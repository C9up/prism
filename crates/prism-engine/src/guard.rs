//! What has to happen before a single pixel is allocated.
//!
//! Every byte reaching this crate came from an upload. Two things about an
//! image file are attacker-controlled and load-bearing: what format it
//! actually is, and how large it claims to be. Getting either wrong is not a
//! wrong picture — it is the process.

use image::{ImageFormat, ImageReader};
use std::io::Cursor;

use crate::error::EngineError;

/// Every format this build can touch, in bit order.
///
/// The decoders are all compiled in; which of them an application will
/// actually accept is a runtime decision — see [`FormatSet`].
const FORMATS: &[(ImageFormat, &str)] = &[
    (ImageFormat::Jpeg, "jpeg"),
    (ImageFormat::Png, "png"),
    (ImageFormat::WebP, "webp"),
    (ImageFormat::Gif, "gif"),
    (ImageFormat::Bmp, "bmp"),
    (ImageFormat::Ico, "ico"),
    (ImageFormat::Tiff, "tiff"),
    (ImageFormat::Tga, "tga"),
    (ImageFormat::Qoi, "qoi"),
    (ImageFormat::Pnm, "pnm"),
    (ImageFormat::Dds, "dds"),
    (ImageFormat::Farbfeld, "farbfeld"),
    (ImageFormat::Hdr, "hdr"),
    (ImageFormat::OpenExr, "openexr"),
    (ImageFormat::Avif, "avif"),
];

/// The formats `dds` aside every entry of [`FORMATS`] can also WRITE.
///
/// `image` has no DDS encoder, so naming it as an output is refused up front
/// rather than failing inside the encoder with a less useful message.
const ENCODABLE: &[ImageFormat] = &[
    ImageFormat::Jpeg,
    ImageFormat::Png,
    ImageFormat::WebP,
    ImageFormat::Gif,
    ImageFormat::Bmp,
    ImageFormat::Ico,
    ImageFormat::Tiff,
    ImageFormat::Tga,
    ImageFormat::Qoi,
    ImageFormat::Pnm,
    ImageFormat::Farbfeld,
    ImageFormat::Hdr,
    ImageFormat::OpenExr,
    ImageFormat::Avif,
];

/// Which formats an application will DECODE.
///
/// An allowlist, not a denylist, and a runtime one. Every decoder compiled in
/// is parser surface facing hostile input, so the default is the three the web
/// actually runs on and anything wider is a decision an application makes
/// deliberately — after weighing what it gains against thirteen more parsers
/// reachable from an upload form.
///
/// A bitmask so that [`Limits`] stays `Copy` and can be threaded through the
/// engine without allocating.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FormatSet(u16);

impl FormatSet {
    /// jpeg, png, webp — what a browser renders and what an upload form
    /// realistically receives.
    pub const WEB: Self = Self(0b111);

    /// Every format this build can decode. Widens the parser surface to
    /// thirteen more codecs; name them individually unless you mean it.
    pub fn all() -> Self {
        Self((1u16 << FORMATS.len()) - 1)
    }

    pub fn is_empty(self) -> bool {
        self.0 == 0
    }

    pub fn contains(self, format: ImageFormat) -> bool {
        FORMATS
            .iter()
            .position(|(candidate, _)| *candidate == format)
            .is_some_and(|bit| self.0 & (1 << bit) != 0)
    }

    /// Build from the names an application wrote.
    pub fn from_names<I, S>(names: I) -> Result<Self, EngineError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut bits = 0u16;
        for name in names {
            let format = parse_format_name(name.as_ref())?;
            let bit = FORMATS
                .iter()
                .position(|(candidate, _)| *candidate == format)
                .expect("parse_format_name only yields known formats");
            bits |= 1 << bit;
        }
        Ok(Self(bits))
    }

    /// The names in this set, for an error that has to say what IS allowed.
    pub fn names(self) -> Vec<&'static str> {
        FORMATS
            .iter()
            .enumerate()
            .filter(|(bit, _)| self.0 & (1 << bit) != 0)
            .map(|(_, (_, name))| *name)
            .collect()
    }
}

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
    /// Which formats this application will decode.
    pub allowed: FormatSet,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            // 50 megapixels — comfortably above a 61 MP full-frame camera's
            // output, far below what exhausts a container.
            max_pixels: 50_000_000,
            // 64 MiB.
            max_bytes: 64 * 1024 * 1024,
            allowed: FormatSet::WEB,
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
    if !limits.allowed.contains(format) {
        // The message names what IS accepted: "gif is not allowed" is only
        // actionable next to the list the application configured.
        return Err(EngineError::FormatNotAllowed {
            found: format_name(format).into(),
            allowed: limits.allowed.names().join(", "),
        });
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
    FORMATS
        .iter()
        .find(|(candidate, _)| *candidate == format)
        .map(|(_, name)| *name)
        .unwrap_or("unsupported")
}

/// Parse a name this engine knows, without deciding anything about it.
fn parse_format_name(name: &str) -> Result<ImageFormat, EngineError> {
    let lower = name.to_ascii_lowercase();
    let lower = if lower == "jpg" {
        "jpeg".to_string()
    } else {
        lower
    };
    FORMATS
        .iter()
        .find(|(_, candidate)| *candidate == lower)
        .map(|(format, _)| *format)
        .ok_or_else(|| EngineError::UnsupportedFormat(name.into()))
}

/// Parse a format name a caller wrote, for the OUTPUT side.
pub fn parse_format(name: &str) -> Result<ImageFormat, EngineError> {
    let format = parse_format_name(name)?;
    if !ENCODABLE.contains(&format) {
        return Err(EngineError::UnsupportedFormat(format!(
            "{name} can be read but not written"
        )));
    }
    Ok(format)
}
