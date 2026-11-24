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
use crate::guard::Limits;

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
            Ok((tw, derived_side(th)?))
        }
        (None, Some(th)) => {
            let tw = ((u64::from(th) * u64::from(w) + u64::from(h) / 2) / u64::from(h)).max(1);
            Ok((derived_side(tw)?, th))
        }
    }
}

/// A derived side that does not fit a `u32` is refused, not truncated: `as`
/// would wrap it to an arbitrary smaller number and resize to the wrong shape.
fn derived_side(value: u64) -> Result<u32, EngineError> {
    u32::try_from(value).map_err(|_| {
        EngineError::Geometry(format!(
            "keeping the aspect ratio makes the other side {value} pixels, which no image can be"
        ))
    })
}

/// The box an aspect-preserving resize lands in.
///
/// `image::math::resize_dimensions`, reproduced because it is crate-private
/// and the size it computes has to be bounded BEFORE `image` allocates it.
fn fitted(width: u32, height: u32, nwidth: u32, nheight: u32, fill: bool) -> (u32, u32) {
    let wratio = f64::from(nwidth) / f64::from(width);
    let hratio = f64::from(nheight) / f64::from(height);
    let ratio = if fill {
        wratio.max(hratio)
    } else {
        wratio.min(hratio)
    };
    let nw = ((f64::from(width) * ratio).round() as u64).max(1);
    let nh = ((f64::from(height) * ratio).round() as u64).max(1);
    if nw > u64::from(u32::MAX) {
        let ratio = f64::from(u32::MAX) / f64::from(width);
        (
            u32::MAX,
            ((f64::from(height) * ratio).round() as u32).max(1),
        )
    } else if nh > u64::from(u32::MAX) {
        let ratio = f64::from(u32::MAX) / f64::from(height);
        (((f64::from(width) * ratio).round() as u32).max(1), u32::MAX)
    } else {
        (nw as u32, nh as u32)
    }
}

/// Refuse a buffer of `width` x `height` over the pixel ceiling.
///
/// Rust aborts the process when an allocation fails — that is not a panic,
/// and no `catch_unwind` sees it — so an output whose size came from a request
/// is bounded here, by the same ceiling the input is held to, before `image`
/// asks for the memory.
pub(crate) fn bound(width: u32, height: u32, max_pixels: u64) -> Result<(), EngineError> {
    let pixels = u64::from(width) * u64::from(height);
    if pixels > max_pixels {
        return Err(EngineError::OutputTooLarge {
            width,
            height,
            pixels,
            limit: max_pixels,
        });
    }
    Ok(())
}

/// Bytes the pixels of `image` occupy.
pub(crate) fn bytes_of(image: &DynamicImage) -> u64 {
    image.as_bytes().len() as u64
}

/// Bytes of a `width` x `height` buffer at `bytes_per_pixel`.
pub(crate) fn bytes_for(width: u32, height: u32, bytes_per_pixel: u64) -> u64 {
    (u64::from(width) * u64::from(height)).saturating_mul(bytes_per_pixel)
}

/// Bytes one pixel of `image` takes.
pub(crate) fn pixel_bytes(image: &DynamicImage) -> u64 {
    u64::from(image.color().bytes_per_pixel())
}

/// Refuse a step whose working set would be over the memory ceiling.
///
/// `held` is what stays alive across the step — the image it reads, and any
/// layer beside it — and `allocated` what the step adds before it can drop
/// anything. The sum is the step's peak. What each step counts:
///
/// - decode: the decoded buffer (bit depth and channels from the header),
///   plus the GIF frame buffer or WebP planes beside it; twice that when an
///   EXIF orientation is applied, since rotating copies;
/// - Lanczos resize: the source, a 16-byte-per-pixel float intermediate of
///   SOURCE width x TARGET height, and the output (plus the crop of `cover`);
/// - thumbnail and crop: the source and the output;
/// - a filter: the source and one copy (two for the blurs, whose separable
///   pass keeps a transient image);
/// - composite: both layers, and an 8-bit RGBA copy of each;
/// - encode: the image, the encoder's converted copy and its output.
pub(crate) fn charge(held: u64, allocated: u64, max_memory: u64) -> Result<(), EngineError> {
    let needed = held.saturating_add(allocated);
    if needed > max_memory {
        return Err(EngineError::MemoryLimit {
            needed,
            limit: max_memory,
        });
    }
    Ok(())
}

/// Bound a Lanczos resample of `image` to `width` x `height`, then
/// `extra` bytes more (the crop of a `cover`).
///
/// `imageops::resize` samples vertically first, into a 32-bit-float RGBA
/// buffer of the SOURCE width by the TARGET height, so that intermediate is
/// bounded too: a very wide source asked to become very tall builds it far
/// larger than either end, and it is 16 bytes a pixel whatever the source's
/// depth — the largest of the three buffers alive at once.
fn bound_resample(
    image: &DynamicImage,
    width: u32,
    height: u32,
    extra: u64,
    limits: Limits,
) -> Result<(), EngineError> {
    bound(width, height, limits.max_pixels)?;
    bound(image.width(), height, limits.max_pixels)?;
    let intermediate = bytes_for(image.width(), height, 16);
    let output = bytes_for(width, height, pixel_bytes(image));
    charge(
        bytes_of(image),
        intermediate.saturating_add(output).saturating_add(extra),
        limits.max_memory,
    )
}

pub fn resize(
    image: DynamicImage,
    width: Option<u32>,
    height: Option<u32>,
    fit: Fit,
    limits: Limits,
) -> Result<DynamicImage, EngineError> {
    let (tw, th) = target(&image, width, height)?;
    let (w, h) = (image.width(), image.height());
    Ok(match fit {
        Fit::Fill => {
            bound_resample(&image, tw, th, 0, limits)?;
            image.resize_exact(tw, th, FILTER)
        }
        Fit::Contain => {
            let (cw, ch) = fitted(w, h, tw, th, false);
            bound_resample(&image, cw, ch, 0, limits)?;
            image.resize(tw, th, FILTER)
        }
        Fit::Cover => {
            // Scaled to cover the box first, then cropped: the scaled
            // intermediate is the large one.
            let (cw, ch) = fitted(w, h, tw, th, true);
            let cropped = bytes_for(tw, th, pixel_bytes(&image));
            bound_resample(&image, cw, ch, cropped, limits)?;
            image.resize_to_fill(tw, th, FILTER)
        }
        Fit::Inside => {
            if w <= tw && h <= th {
                image
            } else {
                let (cw, ch) = fitted(w, h, tw, th, false);
                bound_resample(&image, cw, ch, 0, limits)?;
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
    max_memory: u64,
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
    charge(
        bytes_of(&image),
        bytes_for(width, height, pixel_bytes(&image)),
        max_memory,
    )?;
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
pub fn composite(
    base: DynamicImage,
    top: &DynamicImage,
    x: i64,
    y: i64,
    max_memory: u64,
) -> Result<DynamicImage, EngineError> {
    charge(
        bytes_of(&base).saturating_add(bytes_of(top)),
        bytes_for(base.width(), base.height(), 4).saturating_add(bytes_for(
            top.width(),
            top.height(),
            4,
        )),
        max_memory,
    )?;
    // To RGBA once: `overlay` blends per channel, and a base without an alpha
    // channel would otherwise drop the overlay's transparency and paint its
    // bounding box.
    let mut canvas = base.to_rgba8();
    overlay(&mut canvas, &top.to_rgba8(), x, y);
    Ok(DynamicImage::ImageRgba8(canvas))
}

// ─── Filters ────────────────────────────────────────────────────────
//
// Every one of these is a thin forward to `image`'s own implementation. The
// value added here is the VALIDATION: each takes a number that came from an
// HTTP request, and an unbounded sigma is a denial of service rather than a
// blurry picture — the cost of a Gaussian blur grows with its radius, on a
// buffer whose size the caller also chose.

/// Largest blur radius accepted.
///
/// A sigma of 1000 on a 4000x3000 image is minutes of CPU on a worker
/// thread. The cap is generous for anything anyone actually wants — a
/// portrait blur is single digits — and bounds the worst case.
const MAX_SIGMA: f32 = 100.0;

fn finite(name: &str, value: f32) -> Result<f32, EngineError> {
    if !value.is_finite() {
        return Err(EngineError::Geometry(format!(
            "{name} must be a finite number"
        )));
    }
    Ok(value)
}

/// A radius in `0..=MAX_SIGMA` that `image` accepts.
///
/// `image` asserts a Gaussian sigma is a normal float, so a subnormal one —
/// finite and in range — panicked inside it. Zero is the one non-normal value
/// it takes (a blur reads it as its own default radius).
fn sigma(value: f32) -> Result<f32, EngineError> {
    let value = finite("sigma", value)?;
    if !(0.0..=MAX_SIGMA).contains(&value) || (value != 0.0 && !value.is_normal()) {
        return Err(EngineError::Geometry(format!(
            "sigma must be 0 or a normal number up to {MAX_SIGMA}, got {value}"
        )));
    }
    Ok(value)
}

/// Gaussian blur. Accurate and slow; see [`fast_blur`] for the cheap one.
pub fn blur(image: DynamicImage, amount: f32) -> Result<DynamicImage, EngineError> {
    Ok(image.blur(sigma(amount)?))
}

/// A composite's opacity, `0..=1`.
pub fn opacity(value: f32) -> Result<f32, EngineError> {
    let value = finite("opacity", value)?;
    if !(0.0..=1.0).contains(&value) {
        return Err(EngineError::Geometry(format!(
            "opacity must be between 0 and 1, got {value}"
        )));
    }
    Ok(value)
}

/// Box-approximated blur — visually close to Gaussian, far cheaper.
pub fn fast_blur(image: DynamicImage, amount: f32) -> Result<DynamicImage, EngineError> {
    Ok(image.fast_blur(sigma(amount)?))
}

/// Unsharp mask. `threshold` suppresses sharpening below a contrast step,
/// which is what stops it amplifying sensor noise in flat areas like sky.
pub fn sharpen(
    image: DynamicImage,
    amount: f32,
    threshold: i32,
) -> Result<DynamicImage, EngineError> {
    // Unlike `blur`, `unsharpen` hands zero straight to the assertion.
    let amount = sigma(amount)?;
    if amount == 0.0 {
        return Err(EngineError::Geometry(
            "sharpen sigma must be greater than 0".into(),
        ));
    }
    Ok(image.unsharpen(amount, threshold))
}

/// Additive brightness, -255 to 255.
pub fn brighten(image: DynamicImage, value: i32) -> Result<DynamicImage, EngineError> {
    if !(-255..=255).contains(&value) {
        return Err(EngineError::Geometry(format!(
            "brightness must be between -255 and 255, got {value}"
        )));
    }
    Ok(image.brighten(value))
}

/// Contrast. Negative flattens, positive steepens; 0 is unchanged.
pub fn contrast(image: DynamicImage, amount: f32) -> Result<DynamicImage, EngineError> {
    let amount = finite("contrast", amount)?;
    if !(-255.0..=255.0).contains(&amount) {
        return Err(EngineError::Geometry(format!(
            "contrast must be between -255 and 255, got {amount}"
        )));
    }
    Ok(image.adjust_contrast(amount))
}

/// Rotate the hue, in degrees. Wraps, so any integer is valid.
pub fn hue_rotate(image: DynamicImage, degrees: i32) -> DynamicImage {
    image.huerotate(degrees)
}

/// Invert in place, then hand the image back.
pub fn invert(mut image: DynamicImage) -> DynamicImage {
    image.invert();
    image
}

pub fn grayscale(image: DynamicImage) -> DynamicImage {
    image.grayscale()
}

/// Fast downscale with a box filter.
///
/// Not a substitute for [`resize`]: it is several times cheaper and visibly
/// softer, which is the right trade for a 32px avatar and the wrong one for a
/// 1200px hero. `exact` ignores the aspect ratio, as `Fit::Fill` does.
pub fn thumbnail(
    image: DynamicImage,
    width: Option<u32>,
    height: Option<u32>,
    exact: bool,
    limits: Limits,
) -> Result<DynamicImage, EngineError> {
    let (tw, th) = target(&image, width, height)?;
    // A box sampler writes straight into the output, so the output is the
    // only buffer to bound.
    let (ow, oh) = if exact {
        (tw, th)
    } else {
        fitted(image.width(), image.height(), tw, th, false)
    };
    bound(ow, oh, limits.max_pixels)?;
    charge(
        bytes_of(&image),
        bytes_for(ow, oh, pixel_bytes(&image)),
        limits.max_memory,
    )?;
    Ok(if exact {
        image.thumbnail_exact(tw, th)
    } else {
        image.thumbnail(tw, th)
    })
}

/// A 3x3 convolution — emboss, edge detection, custom sharpening.
pub fn filter3x3(image: DynamicImage, kernel: &[f32]) -> Result<DynamicImage, EngineError> {
    if kernel.len() != 9 {
        return Err(EngineError::Geometry(format!(
            "a 3x3 kernel needs exactly 9 values, got {}",
            kernel.len()
        )));
    }
    for value in kernel {
        finite("kernel value", *value)?;
    }
    Ok(image.filter3x3(kernel))
}
