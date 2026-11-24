//! Prism's image engine.
//!
//! One entry point: bytes in, an ordered list of operations, bytes out. The
//! pipeline decodes once and encodes once, so a resize followed by a
//! watermark does not pay for two round trips through JPEG.
//!
//! Everything reaching `process` came from an upload. The order of the first
//! three steps is deliberate and load-bearing: identify the format from the
//! content, bound the dimensions from the header, and only then allocate.

pub mod avif;
pub mod colour;
pub mod encode;
pub mod error;
pub mod exif;
pub mod frames;
pub mod guard;
pub mod ops;
pub mod qr;
pub mod text;

/// The format an output is encoded as, as `parse_format` names it.
pub use image::ImageFormat;
use image::{DynamicImage, ImageDecoder, ImageError, ImageReader};
use std::io::Cursor;

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
    /// The colour space the file DECLARES — `unknown` when it is not one this
    /// engine names, and `srgb` for the majority of files, which declare
    /// nothing and are decoded as sRGB by default.
    pub colour_space: String,
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
    /// Fast box downscale. Cheaper and softer than `Resize`.
    Thumbnail {
        width: Option<u32>,
        height: Option<u32>,
        exact: bool,
    },
    Blur(f32),
    /// Box-approximated blur — visually close, far cheaper.
    FastBlur(f32),
    Sharpen {
        sigma: f32,
        threshold: i32,
    },
    Brighten(i32),
    Contrast(f32),
    HueRotate(i32),
    Invert,
    Grayscale,
    /// A 3x3 convolution kernel, row-major.
    Filter3x3(Vec<f32>),
    /// Convert into a colour space, optionally declaring the source first.
    ConvertColourSpace {
        to: String,
        /// Overrides what the FILE claims. For an image whose real profile
        /// the decoder never read — `image` has no ICC reader.
        from: Option<String>,
    },
}

/// What to write out.
#[derive(Debug, Clone)]
pub struct Output {
    pub format: ImageFormat,
    pub quality: u8,
    /// What transparency is resolved against when the format has no alpha.
    pub background: Colour,
    /// Bits per channel to write: 8 or 16.
    ///
    /// 16 is only honoured by formats that carry it — PNG and TIFF. Elsewhere
    /// the encoder narrows it back, which is why this is a request rather
    /// than a guarantee.
    pub depth: u8,
    /// CPU effort, 0 (fastest) to 9 (slowest). Only AVIF has the knob.
    pub effort: u8,
}

impl Output {
    /// Eight bits per channel: what the web runs on.
    pub const DEPTH_8: u8 = 8;
    /// Sixteen bits per channel, for the formats that carry it.
    pub const DEPTH_16: u8 = 16;

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
        colour_space: colour::DEFAULT_SPACE_NAME.to_string(),
    })
}

/// Decode, guarded.
pub(crate) fn decode(
    bytes: &[u8],
    limits: Limits,
    auto_orient: bool,
) -> Result<DynamicImage, EngineError> {
    // Probe FIRST, and decode with the decoder the probe read the header
    // with. `load_from_memory` would happily allocate the fifty thousand
    // square pixels a four-kilobyte file can declare, under `image`'s own
    // 512 MiB default rather than this engine's limits.
    let (probe, decoder) = guard::opened(bytes, limits)?;
    let image = match decoder {
        Some(mut decoder) => {
            decoder
                .set_limits(guard::decode_limits(limits, probe.decode_bytes))
                .map_err(decode_error)?;
            DynamicImage::from_decoder(decoder).map_err(decode_error)?
        }
        None => {
            // An AVIF. The probe bounded what the sequence headers declare; a
            // frame header can still override it, and `image` gives dav1d no
            // limit.
            avif::preflight(bytes, limits.max_pixels)?;
            let mut reader = ImageReader::with_format(Cursor::new(bytes), probe.format);
            reader.limits(guard::decode_limits(limits, 0));
            reader.decode().map_err(decode_error)?
        }
    };
    if !auto_orient {
        return Ok(image);
    }
    let orientation = exif::orientation(bytes);
    if !matches!(orientation, exif::Orientation::Normal) {
        // Every orientation but the identity builds a rotated copy.
        let held = ops::bytes_of(&image);
        ops::charge(held, held, limits.max_memory)?;
    }
    Ok(ops::apply_orientation(image, orientation))
}

fn decode_error(error: ImageError) -> EngineError {
    EngineError::Decode(error.to_string())
}

/// Narrow a 16-bit image to 8 bits, for an 8-bit output.
///
/// The bytes a 16-bit source costs are not worth carrying through a
/// pipeline whose output drops them: an 8-bit RGBA copy is half the size of
/// every buffer after it. Only formats that write 8 bits at the requested
/// depth are narrowed; Farbfeld, HDR and OpenEXR keep their precision.
fn narrowed(
    image: DynamicImage,
    output: &Output,
    limits: Limits,
) -> Result<DynamicImage, EngineError> {
    if output.depth >= Output::DEPTH_16
        || matches!(
            output.format,
            ImageFormat::Farbfeld | ImageFormat::Hdr | ImageFormat::OpenExr
        )
    {
        return Ok(image);
    }
    let half = ops::bytes_of(&image) / 2;
    let narrow = |image: &DynamicImage| ops::charge(ops::bytes_of(image), half, limits.max_memory);
    Ok(match image {
        DynamicImage::ImageLuma16(_) => {
            narrow(&image)?;
            DynamicImage::ImageLuma8(image.to_luma8())
        }
        DynamicImage::ImageLumaA16(_) => {
            narrow(&image)?;
            DynamicImage::ImageLumaA8(image.to_luma_alpha8())
        }
        DynamicImage::ImageRgb16(_) => {
            narrow(&image)?;
            DynamicImage::ImageRgb8(image.to_rgb8())
        }
        DynamicImage::ImageRgba16(_) => {
            narrow(&image)?;
            DynamicImage::ImageRgba8(image.to_rgba8())
        }
        other => other,
    })
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
    let mut image = narrowed(decode(input, limits, auto_orient)?, output, limits)?;
    let budget = limits.max_memory;

    for operation in operations {
        let held = ops::bytes_of(&image);
        image = match operation {
            Operation::Resize { width, height, fit } => {
                ops::resize(image, *width, *height, *fit, limits)?
            }
            Operation::Crop {
                x,
                y,
                width,
                height,
            } => ops::crop(image, *x, *y, *width, *height, budget)?,
            Operation::Rotate(degrees) => {
                ops::charge(held, held, budget)?;
                ops::rotate(image, *degrees)?
            }
            Operation::Flip(axis) => {
                ops::charge(held, held, budget)?;
                ops::flip(image, axis)?
            }
            Operation::Composite {
                image: overlay_bytes,
                x,
                y,
                opacity,
            } => {
                // Checked before the overlay is decoded: a NaN used to fade
                // every alpha to zero, and the overlay silently vanished.
                let opacity = ops::opacity(*opacity)?;
                // The overlay is an upload too, in every case where the
                // watermark is chosen per tenant. Same guards, same limits —
                // and the same budget, of which the base already holds part.
                let overlay = decode(
                    overlay_bytes,
                    Limits {
                        max_memory: budget.saturating_sub(held),
                        ..limits
                    },
                    true,
                )?;
                if opacity < 1.0 {
                    ops::charge(
                        held.saturating_add(ops::bytes_of(&overlay)),
                        ops::bytes_for(overlay.width(), overlay.height(), 4),
                        budget,
                    )?;
                }
                ops::composite(image, &fade(overlay, opacity), *x, *y, budget)?
            }
            Operation::WatermarkText {
                text,
                font,
                size,
                colour,
                x,
                y,
            } => {
                let layer = text::render(font, text, *size, *colour, limits, held)?;
                ops::composite(image, &layer, *x, *y, budget)?
            }
            Operation::Thumbnail {
                width,
                height,
                exact,
            } => ops::thumbnail(image, *width, *height, *exact, limits)?,
            // The separable blur keeps a transient image beside its output.
            Operation::Blur(sigma) => {
                ops::charge(held, held.saturating_mul(2), budget)?;
                ops::blur(image, *sigma)?
            }
            Operation::FastBlur(sigma) => {
                ops::charge(held, held.saturating_mul(2), budget)?;
                ops::fast_blur(image, *sigma)?
            }
            Operation::Sharpen { sigma, threshold } => {
                ops::charge(held, held.saturating_mul(2), budget)?;
                ops::sharpen(image, *sigma, *threshold)?
            }
            Operation::Brighten(value) => {
                ops::charge(held, held, budget)?;
                ops::brighten(image, *value)?
            }
            Operation::Contrast(amount) => {
                ops::charge(held, held, budget)?;
                ops::contrast(image, *amount)?
            }
            Operation::HueRotate(degrees) => {
                ops::charge(held, held, budget)?;
                ops::hue_rotate(image, *degrees)
            }
            // In place.
            Operation::Invert => ops::invert(image),
            Operation::Grayscale => {
                ops::charge(held, held, budget)?;
                ops::grayscale(image)
            }
            Operation::Filter3x3(kernel) => {
                ops::charge(held, held, budget)?;
                ops::filter3x3(image, kernel)?
            }
            Operation::ConvertColourSpace { to, from } => {
                let target = colour::parse_space(to)?;
                let source = from.as_deref().map(colour::parse_space).transpose()?;
                ops::charge(held, held, budget)?;
                colour::convert(image, target, source)?
            }
        };
    }

    // A format without an alpha channel needs the transparency RESOLVED, not
    // discarded. Dropping the channel keeps whatever colour sat underneath —
    // a transparent red pixel becomes opaque red — so the image is
    // composited onto a background first, the way a viewer would show it.
    if !encode::keeps_alpha(output.format) {
        // An 8-bit RGBA copy, then the RGB result.
        let pixels = ops::bytes_for(image.width(), image.height(), 7);
        ops::charge(ops::bytes_of(&image), pixels, budget)?;
        image = flatten(image, output.background);
    }
    ops::charge(
        ops::bytes_of(&image),
        encode::working_bytes(&image, output.format, output.depth),
        budget,
    )?;
    encode::encode_with_effort(
        &image,
        output.format,
        output.quality,
        output.depth,
        output.effort,
    )
}
