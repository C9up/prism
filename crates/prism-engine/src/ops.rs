//! Geometry and composition.
//!
//! The filter is Lanczos3 throughout. It is the slowest of the good ones and
//! the only one that does not visibly soften a downscale, which is what a
//! thumbnail is. If a measurement ever says the resize kernel is the
//! bottleneck, `fast_image_resize` is the SIMD path — but measure first
//! rather than reach for it.

use image::imageops::{overlay, FilterType};
use image::DynamicImage;

use crate::error::EngineError;
use crate::exif::Orientation;

const FILTER: FilterType = FilterType::Lanczos3;

/// How a resize reconciles the requested box with the image's aspect ratio.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fit {
    /// Exactly the requested size. Distorts.
    Fill,
    /// Largest size fitting INSIDE the box. Never distorts, may be smaller.
    Contain,
    /// Fills the box and crops the overflow, centred. Never distorts.
    Cover,
    /// Like `Contain`, but never enlarges a smaller image.
    Inside,
}

impl Fit {
    pub fn parse(name: &str) -> Result<Self, EngineError> {
        match name.to_ascii_lowercase().as_str() {
            "fill" => Ok(Self::Fill),
            "contain" => Ok(Self::Contain),
            "cover" => Ok(Self::Cover),
            "inside" => Ok(Self::Inside),
            other => Err(EngineError::Geometry(format!(
                "\"{other}\" is not one of fill, contain, cover, inside"
            ))),
        }
    }
}

/// Put the pixels the right way up, per the EXIF tag.
pub fn apply_orientation(image: DynamicImage, orientation: Orientation) -> DynamicImage {
    match orientation {
        Orientation::Normal => image,
        Orientation::FlipHorizontal => image.fliph(),
        Orientation::Rotate180 => image.rotate180(),
        Orientation::FlipVertical => image.flipv(),
        Orientation::Transpose => image.rotate90().fliph(),
        Orientation::Rotate90 => image.rotate90(),
        Orientation::Transverse => image.rotate270().fliph(),
        Orientation::Rotate270 => image.rotate270(),
    }
}

/// Resolve the target box, filling in whichever side the caller left out.
///
/// Asking for one dimension is the common case — "300 wide, keep the shape" —
/// and it is only expressible if the other is derived rather than required.
fn target(
    image: &DynamicImage,
    width: Option<u32>,
    height: Option<u32>,
) -> Result<(u32, u32), EngineError> {
    let (w, h) = (image.width(), image.height());
    match (width, height) {
        (None, None) => Err(EngineError::Geometry(
            "a resize needs a width, a height, or both".into(),
        )),
        (Some(0), _) | (_, Some(0)) => Err(EngineError::Geometry(
            "a resize target cannot be zero".into(),
        )),
        (Some(tw), Some(th)) => Ok((tw, th)),
        (Some(tw), None) => {
            // Rounded, not truncated: a 1000x667 image asked for 300 wide
            // should be 200 tall, not 199. And at least 1, because a very
            // wide image scaled down otherwise computes a height of zero.
            let th = ((u64::from(tw) * u64::from(h) + u64::from(w) / 2) / u64::from(w)).max(1);
            Ok((tw, th as u32))
        }
        (None, Some(th)) => {
            let tw = ((u64::from(th) * u64::from(w) + u64::from(h) / 2) / u64::from(h)).max(1);
            Ok((tw as u32, th))
        }
    }
}

pub fn resize(
    image: DynamicImage,
    width: Option<u32>,
    height: Option<u32>,
    fit: Fit,
) -> Result<DynamicImage, EngineError> {
    let (tw, th) = target(&image, width, height)?;
    Ok(match fit {
        Fit::Fill => image.resize_exact(tw, th, FILTER),
        Fit::Contain => image.resize(tw, th, FILTER),
        Fit::Cover => image.resize_to_fill(tw, th, FILTER),
        Fit::Inside => {
            if image.width() <= tw && image.height() <= th {
                image
            } else {
                image.resize(tw, th, FILTER)
            }
        }
    })
}

pub fn crop(
    image: DynamicImage,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> Result<DynamicImage, EngineError> {
    if width == 0 || height == 0 {
        return Err(EngineError::Geometry("a crop cannot be zero-sized".into()));
    }
    // Checked in u64 and BEFORE cropping. `crop_imm` silently clamps to the
    // image bounds, so an out-of-range rectangle would return a smaller
    // picture than asked for with nothing to say so — a thumbnail quietly
    // missing its subject.
    let right = u64::from(x) + u64::from(width);
    let bottom = u64::from(y) + u64::from(height);
    if right > u64::from(image.width()) || bottom > u64::from(image.height()) {
        return Err(EngineError::Geometry(format!(
            "the crop {width}x{height}+{x}+{y} falls outside the {}x{} image",
            image.width(),
            image.height()
        )));
    }
    Ok(image.crop_imm(x, y, width, height))
}

pub fn rotate(image: DynamicImage, degrees: i32) -> Result<DynamicImage, EngineError> {
    // Normalised first, so -90 and 270 mean the same thing.
    match degrees.rem_euclid(360) {
        0 => Ok(image),
        90 => Ok(image.rotate90()),
        180 => Ok(image.rotate180()),
        270 => Ok(image.rotate270()),
        other => Err(EngineError::Geometry(format!(
            "rotation must be a multiple of 90 degrees, got {other}"
        ))),
    }
}

pub fn flip(image: DynamicImage, axis: &str) -> Result<DynamicImage, EngineError> {
    match axis.to_ascii_lowercase().as_str() {
        "horizontal" => Ok(image.fliph()),
        "vertical" => Ok(image.flipv()),
        other => Err(EngineError::Geometry(format!(
            "\"{other}\" is not one of horizontal, vertical"
        ))),
    }
}

/// Draw `top` over `base` at `(x, y)`, honouring the overlay's alpha.
///
/// Coordinates are signed so an overlay can hang off the edge — a watermark
/// anchored to a corner is routinely larger than the margin it sits in.
pub fn composite(base: DynamicImage, top: &DynamicImage, x: i64, y: i64) -> DynamicImage {
    // To RGBA once: `overlay` blends per channel, and a base without an alpha
    // channel would otherwise drop the overlay's transparency and paint its
    // bounding box.
    let mut canvas = base.to_rgba8();
    overlay(&mut canvas, &top.to_rgba8(), x, y);
    DynamicImage::ImageRgba8(canvas)
}
