//! What has to happen before a single pixel is allocated.
//!
//! Every byte reaching this crate came from an upload. Two things about an
//! image file are attacker-controlled and load-bearing: what format it
//! actually is, and how large it claims to be. Getting either wrong is not a
//! wrong picture — it is the process.

use image::{ImageFormat, ImageReader};
use std::io::Cursor;

use crate::error::EngineError;

/// The formats this engine will decode.
///
/// An allowlist, not a denylist. `image` can be built with far more decoders,
/// and every one of them is parser surface facing hostile input — a format
/// nobody asked for is a liability, not a feature.
pub const ALLOWED: &[ImageFormat] = &[ImageFormat::Jpeg, ImageFormat::Png, ImageFormat::WebP];

/// Ceilings applied before decoding.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// Largest number of pixels a decoded image may have.
    ///
    /// This is the decompression-bomb bound. A 40 KB PNG can declare
    /// 50000x50000, and decoding it asks for ten gigabytes before anything
    /// has a chance to object. The dimensions are read from the header and
    /// checked here, so the allocation never happens.
    pub max_pixels: u64,
    /// Largest input the engine will look at, in bytes.
    pub max_bytes: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            // 50 megapixels — comfortably above a 61 MP full-frame camera's
            // output, far below what exhausts a container.
            max_pixels: 50_000_000,
            // 64 MiB.
            max_bytes: 64 * 1024 * 1024,
        }
    }
}

/// What the header says, before any pixel work.
#[derive(Debug, Clone, Copy)]
pub struct Probe {
    pub width: u32,
    pub height: u32,
    pub format: ImageFormat,
}

/// Identify and bound an input without decoding it.
///
/// The format comes from the CONTENT, never from a filename or a
/// `Content-Type`: both are supplied by the same party as the bytes. A PNG
/// decoder pointed at a JPEG is the mildest outcome of trusting them; a
/// polyglot file that a browser renders as SVG is not.
pub fn probe(bytes: &[u8], limits: Limits) -> Result<Probe, EngineError> {
    if bytes.is_empty() {
        return Err(EngineError::Empty);
    }
    if bytes.len() > limits.max_bytes {
        return Err(EngineError::TooLarge {
            bytes: bytes.len(),
            limit: limits.max_bytes,
        });
    }

    let reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| EngineError::Unreadable(error.to_string()))?;

    let format = reader.format().ok_or(EngineError::UnknownFormat)?;
    if !ALLOWED.contains(&format) {
        return Err(EngineError::UnsupportedFormat(format_name(format).into()));
    }

    let (width, height) = reader
        .into_dimensions()
        .map_err(|error| EngineError::Unreadable(error.to_string()))?;

    // Multiplied in u64: two u32 dimensions overflow a u32 long before they
    // reach a limit, and an overflowed product compares as a small number —
    // which is precisely the check passing for the largest possible image.
    let pixels = u64::from(width) * u64::from(height);
    if pixels > limits.max_pixels {
        return Err(EngineError::TooManyPixels {
            pixels,
            limit: limits.max_pixels,
        });
    }
    if width == 0 || height == 0 {
        return Err(EngineError::ZeroDimension);
    }

    Ok(Probe {
        width,
        height,
        format,
    })
}

/// The name this engine uses for a format, in errors and in its API.
pub fn format_name(format: ImageFormat) -> &'static str {
    match format {
        ImageFormat::Jpeg => "jpeg",
        ImageFormat::Png => "png",
        ImageFormat::WebP => "webp",
        _ => "unsupported",
    }
}

/// Parse a format name a caller wrote, for the OUTPUT side.
pub fn parse_format(name: &str) -> Result<ImageFormat, EngineError> {
    match name.to_ascii_lowercase().as_str() {
        "jpeg" | "jpg" => Ok(ImageFormat::Jpeg),
        "png" => Ok(ImageFormat::Png),
        "webp" => Ok(ImageFormat::WebP),
        other => Err(EngineError::UnsupportedFormat(other.into())),
    }
}
