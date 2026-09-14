//! Prism's image engine.
//!
//! One entry point: bytes in, an ordered list of operations, bytes out. The
//! pipeline decodes once and encodes once, so a resize followed by a
//! watermark does not pay for two round trips through JPEG.
//!
//! Everything reaching `process` came from an upload. The order of the first
//! three steps is deliberate and load-bearing: identify the format from the
//! content, bound the dimensions from the header, and only then allocate.

pub mod encode;
pub mod error;
pub mod exif;
pub mod guard;
pub mod ops;
pub mod text;

use image::{DynamicImage, ImageFormat};

pub use error::EngineError;
pub use guard::Limits;
pub use ops::Fit;
pub use text::Colour;

/// What an image is, without decoding it.
#[derive(Debug, Clone)]
pub struct Metadata {
    pub width: u32,
    pub height: u32,
    pub format: String,
    /// Dimensions as they will appear AFTER the EXIF orientation is applied.
    ///
    /// A portrait phone photo reports landscape dimensions in its header and
    /// a tag saying to rotate it. Code laying out a gallery from the header
    /// alone gets every phone photo's aspect ratio wrong.
    pub oriented_width: u32,
    pub oriented_height: u32,
    /// `1` when there is no EXIF orientation.
    pub orientation: u8,
    pub has_alpha: bool,
}

/// One step of a pipeline.
#[derive(Debug, Clone)]
pub enum Operation {
    Resize {
        width: Option<u32>,
        height: Option<u32>,
        fit: Fit,
    },
    Crop {
        x: u32,
        y: u32,
        width: u32,
        height: u32,
    },
    Rotate(i32),
    Flip(String),
    /// Overlay another encoded image. Its bytes go through the same guards.
    Composite {
        image: Vec<u8>,
        x: i64,
        y: i64,
        opacity: f32,
    },
    WatermarkText {
        text: String,
        font: Vec<u8>,
        size: f32,
        colour: Colour,
        x: i64,
        y: i64,
    },
}

/// What to write out.
#[derive(Debug, Clone)]
pub struct Output {
    pub format: ImageFormat,
    pub quality: u8,
    /// What transparency is resolved against when the format has no alpha.
    pub background: Colour,
}

impl Output {
    /// White, opaque — what a page shows behind an image.
    pub const WHITE: Colour = Colour {
        r: 255,
        g: 255,
        b: 255,
        a: 255,
    };
}

/// Identify an image and describe it, without decoding the pixels.
pub fn inspect(bytes: &[u8], limits: Limits) -> Result<Metadata, EngineError> {
    let probe = guard::probe(bytes, limits)?;
    let orientation = exif::orientation(bytes);
    let (oriented_width, oriented_height) = if orientation.swaps_axes() {
        (probe.height, probe.width)
    } else {
        (probe.width, probe.height)
    };
    Ok(Metadata {
        width: probe.width,
        height: probe.height,
        format: guard::format_name(probe.format).to_string(),
        oriented_width,
        oriented_height,
        orientation: match orientation {
            exif::Orientation::Normal => 1,
            exif::Orientation::FlipHorizontal => 2,
            exif::Orientation::Rotate180 => 3,
            exif::Orientation::FlipVertical => 4,
            exif::Orientation::Transpose => 5,
            exif::Orientation::Rotate90 => 6,
            exif::Orientation::Transverse => 7,
            exif::Orientation::Rotate270 => 8,
        },
        has_alpha: probe.format != ImageFormat::Jpeg,
    })
}

/// Decode, guarded.
fn decode(bytes: &[u8], limits: Limits, auto_orient: bool) -> Result<DynamicImage, EngineError> {
    // Probe FIRST. `load_from_memory` would happily allocate the fifty
    // thousand square pixels a four-kilobyte file can declare.
    guard::probe(bytes, limits)?;
    let image =
        image::load_from_memory(bytes).map_err(|error| EngineError::Decode(error.to_string()))?;
    if !auto_orient {
        return Ok(image);
    }
    Ok(ops::apply_orientation(image, exif::orientation(bytes)))
}

/// Composite onto a solid background, resolving transparency.
///
/// White by default because that is what a page shows behind an image, and
/// because black is the answer people get by accident when a library drops
/// the channel instead of blending it.
fn flatten(image: DynamicImage, background: Colour) -> DynamicImage {
    let rgba = image.to_rgba8();
    let mut out = image::RgbImage::new(rgba.width(), rgba.height());
    for (x, y, pixel) in rgba.enumerate_pixels() {
        let alpha = f32::from(pixel.0[3]) / 255.0;
        let blend = |top: u8, bottom: u8| {
            (f32::from(top) * alpha + f32::from(bottom) * (1.0 - alpha)).round() as u8
        };
        out.put_pixel(
            x,
            y,
            image::Rgb([
                blend(pixel.0[0], background.r),
                blend(pixel.0[1], background.g),
                blend(pixel.0[2], background.b),
            ]),
        );
    }
    DynamicImage::ImageRgb8(out)
}

/// Scale a layer's alpha, for a watermark that should not be opaque.
fn fade(layer: DynamicImage, opacity: f32) -> DynamicImage {
    if opacity >= 1.0 {
        return layer;
    }
    let factor = opacity.clamp(0.0, 1.0);
    let mut rgba = layer.to_rgba8();
    for pixel in rgba.pixels_mut() {
        pixel.0[3] = (f32::from(pixel.0[3]) * factor).round() as u8;
    }
    DynamicImage::ImageRgba8(rgba)
}

/// Run a pipeline.
pub fn process(
    input: &[u8],
    operations: &[Operation],
    output: &Output,
    limits: Limits,
    auto_orient: bool,
) -> Result<Vec<u8>, EngineError> {
    let mut image = decode(input, limits, auto_orient)?;

    for operation in operations {
        image = match operation {
            Operation::Resize { width, height, fit } => ops::resize(image, *width, *height, *fit)?,
            Operation::Crop {
                x,
                y,
                width,
                height,
            } => ops::crop(image, *x, *y, *width, *height)?,
            Operation::Rotate(degrees) => ops::rotate(image, *degrees)?,
            Operation::Flip(axis) => ops::flip(image, axis)?,
            Operation::Composite {
                image: overlay_bytes,
                x,
                y,
                opacity,
            } => {
                // The overlay is an upload too, in every case where the
                // watermark is chosen per tenant. Same guards, same limits.
                let overlay = decode(overlay_bytes, limits, true)?;
                ops::composite(image, &fade(overlay, *opacity), *x, *y)
            }
            Operation::WatermarkText {
                text,
                font,
                size,
                colour,
                x,
                y,
            } => {
                let layer = text::render(font, text, *size, *colour)?;
                ops::composite(image, &layer, *x, *y)
            }
        };
    }

    // A format without an alpha channel needs the transparency RESOLVED, not
    // discarded. Dropping the channel keeps whatever colour sat underneath —
    // a transparent red pixel becomes opaque red — so the image is
    // composited onto a background first, the way a viewer would show it.
    if !encode::keeps_alpha(output.format) {
        image = flatten(image, output.background);
    }
    encode::encode(&image, output.format, output.quality)
}
