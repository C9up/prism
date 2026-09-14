//! Rendering a text watermark.
//!
//! ## What this does not do
//!
//! There is no shaping engine here. Glyphs are looked up one character at a
//! time, kerned, and advanced left to right. That is correct for Latin,
//! Cyrillic and Greek, and WRONG for any script that needs shaping or
//! reordering — Arabic renders unjoined, Devanagari and Thai place their
//! marks wrong, and right-to-left text comes out in visual order reversed.
//!
//! This is stated rather than worked around because the alternative is
//! HarfBuzz: a large dependency, a second text model, and a build that stops
//! being self-contained. A watermark is short, chosen by the operator and
//! usually a brand name, so the trade is deliberate — but anyone stamping
//! user-supplied text in an arbitrary language needs to know it.
//!
//! No font is bundled. The caller supplies the bytes: shipping one would
//! bind every consumer to its licence and add megabytes to a package most of
//! whose users never draw text.

use ab_glyph::{point, Font, FontRef, PxScale, ScaleFont};
use image::{DynamicImage, Rgba, RgbaImage};

use crate::error::EngineError;

/// Straight-alpha RGBA, as a caller writes it.
#[derive(Debug, Clone, Copy)]
pub struct Colour {
    pub r: u8,
    pub g: u8,
    pub b: u8,
    pub a: u8,
}

/// Render `text` into a tight transparent layer, ready to be composited.
///
/// Returning a layer rather than drawing onto the canvas keeps placement in
/// one place: the same compositing path positions an image watermark and a
/// text one, so they cannot drift apart.
pub fn render(
    font_bytes: &[u8],
    text: &str,
    size: f32,
    colour: Colour,
) -> Result<DynamicImage, EngineError> {
    if text.is_empty() {
        return Err(EngineError::Geometry("the watermark text is empty".into()));
    }
    if !(1.0..=4096.0).contains(&size) {
        return Err(EngineError::Geometry(format!(
            "the watermark size must be between 1 and 4096, got {size}"
        )));
    }
    let font = FontRef::try_from_slice(font_bytes)
        .map_err(|error| EngineError::Font(error.to_string()))?;
    let scaled = font.as_scaled(PxScale::from(size));

    // First pass: lay the glyphs out and measure the ink.
    //
    // The layer is sized from the OUTLINE bounds, not from the advance
    // widths. A script font's tail overhangs its advance, and a layer sized
    // by advances clips it.
    let mut pen = point(0.0, scaled.ascent());
    let mut glyphs = Vec::with_capacity(text.chars().count());
    let mut previous = None;
    for character in text.chars() {
        if character == '\n' {
            // One line only. Accepting a newline silently and drawing it as a
            // blank would hide a caller's mistake; refusing says which.
            return Err(EngineError::Geometry(
                "the watermark text must be a single line".into(),
            ));
        }
        let id = font.glyph_id(character);
        if let Some(last) = previous {
            pen.x += scaled.kern(last, id);
        }
        previous = Some(id);
        let glyph = id.with_scale_and_position(PxScale::from(size), pen);
        pen.x += scaled.h_advance(id);
        glyphs.push(glyph);
    }

    let outlined: Vec<_> = glyphs
        .into_iter()
        .filter_map(|glyph| font.outline_glyph(glyph))
        .collect();
    if outlined.is_empty() {
        return Err(EngineError::Font(
            "the font has no glyph for any character in the text".into(),
        ));
    }

    let (mut min_x, mut min_y) = (f32::MAX, f32::MAX);
    let (mut max_x, mut max_y) = (f32::MIN, f32::MIN);
    for glyph in &outlined {
        let bounds = glyph.px_bounds();
        min_x = min_x.min(bounds.min.x);
        min_y = min_y.min(bounds.min.y);
        max_x = max_x.max(bounds.max.x);
        max_y = max_y.max(bounds.max.y);
    }
    let width = (max_x - min_x).ceil().max(1.0) as u32;
    let height = (max_y - min_y).ceil().max(1.0) as u32;

    // Second pass: draw.
    let mut layer = RgbaImage::new(width, height);
    for glyph in outlined {
        let bounds = glyph.px_bounds();
        let offset_x = bounds.min.x - min_x;
        let offset_y = bounds.min.y - min_y;
        glyph.draw(|gx, gy, coverage| {
            let x = gx as f32 + offset_x;
            let y = gy as f32 + offset_y;
            if x < 0.0 || y < 0.0 {
                return;
            }
            let (x, y) = (x as u32, y as u32);
            if x >= width || y >= height {
                return;
            }
            // Coverage is antialiasing, so it scales the alpha rather than
            // the colour — scaling the colour instead is what produces a dark
            // halo around light text on a light background.
            let alpha = (coverage.clamp(0.0, 1.0) * f32::from(colour.a)).round() as u8;
            if alpha == 0 {
                return;
            }
            let pixel = layer.get_pixel_mut(x, y);
            // Glyphs can overlap — an italic 'f' into the next letter. Keep
            // the strongest coverage rather than the last one drawn.
            if alpha > pixel.0[3] {
                *pixel = Rgba([colour.r, colour.g, colour.b, alpha]);
            }
        });
    }

    Ok(DynamicImage::ImageRgba8(layer))
}
