//! What has to happen before a single pixel is allocated.
//!
//! Every byte reaching this crate came from an upload. Two things about an
//! image file are attacker-controlled and load-bearing: what format it
//! actually is, and how large it claims to be. Getting either wrong is not a
//! wrong picture — it is the process.

use image::{ImageDecoder, ImageFormat, ImageReader};
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
    /// has a chance to object. The dimensions are read from the header —
    /// and, for a container that states them twice, from every frame — and
    /// checked here, so the allocation never happens.
    pub max_pixels: u64,
    /// Largest input the engine will look at, in bytes.
    pub max_bytes: usize,
    /// Largest working set one pipeline may hold, in bytes.
    ///
    /// A pixel count is not a memory bound: a 16-bit RGBA pixel is 8 bytes
    /// decoded, and a resample holds a 16-byte float intermediate on top of
    /// the source and the output. Each step adds what it holds to what it is
    /// about to allocate and is refused, before allocating, when the sum is
    /// over this. See [`crate::ops::charge`] for what each step counts.
    pub max_memory: u64,
    /// Which formats this application will decode.
    pub allowed: FormatSet,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            // 50 megapixels — comfortably above a 61 MP full-frame camera's
            // output. What it costs in bytes is bounded by `max_memory`.
            max_pixels: 50_000_000,
            // 64 MiB.
            max_bytes: 64 * 1024 * 1024,
            // 512 MiB. Every image under the default pixel ceiling decodes
            // within it (50 MP of 16-bit RGBA is 400 MB), so the default
            // configuration never refuses at decode what it lets through the
            // pixel check; it refuses the steps after that would not fit.
            max_memory: 512 * 1024 * 1024,
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
    /// What decoding will hold, in bytes: the decoded buffer, plus what the
    /// format's decoder allocates beside it. Never more than `max_memory`.
    pub decode_bytes: u64,
}

/// What `image` may spend reading a header, beyond the file's own bytes.
///
/// The one header field that EXPANDS is a PNG's `iCCP` chunk: a zlib stream
/// the `png` crate inflates while it looks for the image data, bounded only by
/// the allocation limit it is handed — 512 MiB by default, from a ~523 KB
/// file. An ICC profile is a few kilobytes and a large one a few megabytes;
/// this engine never reads it (the output carries none), and `png` drops a
/// profile that does not fit instead of failing. The file-proportional part
/// keeps every text and EXIF chunk a valid file carries readable: `png`
/// charges the same budget for its copies of them.
const ICC_ALLOWANCE: u64 = 4 * 1024 * 1024;

fn header_limits(file: usize) -> image::Limits {
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(ICC_ALLOWANCE.saturating_add(3u64.saturating_mul(file as u64)));
    limits
}

/// The limits a decode runs under once the probe has passed, `held` bytes
/// of it already accounted for.
///
/// The probe has already refused what these would; they are the decoder's
/// own second line, for an allocation the probe did not foresee.
pub(crate) fn decode_limits(limits: Limits, held: u64) -> image::Limits {
    let side = u32::try_from(limits.max_pixels).unwrap_or(u32::MAX);
    let mut bounded = image::Limits::default();
    bounded.max_image_width = Some(side);
    bounded.max_image_height = Some(side);
    bounded.max_alloc = Some(limits.max_memory.saturating_sub(held));
    bounded
}

fn unreadable(error: impl std::fmt::Display) -> EngineError {
    EngineError::Unreadable(error.to_string())
}

/// A decoder for `bytes`, past the header and under explicit limits.
///
/// Never for AVIF: `image`'s AVIF decoder decodes the whole frame in its
/// constructor — see `avif.rs`.
pub(crate) fn decoder<'a>(
    bytes: &'a [u8],
    format: ImageFormat,
) -> Result<impl ImageDecoder + 'a, EngineError> {
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    reader.limits(header_limits(bytes.len()));
    reader.into_decoder().map_err(unreadable)
}

/// Identify and bound an input without decoding it.
///
/// The format comes from the CONTENT, never from a filename or a
/// `Content-Type`: both are supplied by the same party as the bytes. A PNG
/// decoder pointed at a JPEG is the mildest outcome of trusting them; a
/// polyglot file that a browser renders as SVG is not.
pub fn probe(bytes: &[u8], limits: Limits) -> Result<Probe, EngineError> {
    opened(bytes, limits).map(|(probe, _)| probe)
}

/// [`probe`], keeping the decoder it read the header with — `None` for an
/// AVIF, which is bounded without one.
pub(crate) fn opened<'a>(
    bytes: &'a [u8],
    limits: Limits,
) -> Result<(Probe, Option<impl ImageDecoder + 'a>), EngineError> {
    if bytes.is_empty() {
        return Err(EngineError::Empty);
    }
    if bytes.len() > limits.max_bytes {
        return Err(EngineError::TooLarge {
            bytes: bytes.len(),
            limit: limits.max_bytes,
        });
    }

    let format = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(unreadable)?
        .format()
        .ok_or(EngineError::UnknownFormat)?;
    if !limits.allowed.contains(format) {
        // The message names what IS accepted: "gif is not allowed" is only
        // actionable next to the list the application configured.
        return Err(EngineError::FormatNotAllowed {
            found: format_name(format).into(),
            allowed: limits.allowed.names().join(", "),
        });
    }

    if format == ImageFormat::Avif {
        // NOT `image`'s decoder: it decodes the whole frame to answer the
        // dimensions. The sequence headers say the same thing for a few
        // hundred bits — see `avif.rs`. Counted at 8 bytes a pixel: `image`
        // hands back 16-bit RGBA for a high-bit-depth stream, and `dav1d`'s
        // planes are alive while it converts.
        let declared = crate::avif::declared(bytes)?;
        let probe = bounded(
            limits,
            Probe {
                width: declared.width,
                height: declared.height,
                format,
                decode_bytes: declared.max_pixels.saturating_mul(8),
            },
            declared.max_pixels,
        )?;
        return Ok((probe, None));
    }

    let decoder = decoder(bytes, format)?;
    let (width, height) = decoder.dimensions();
    // Multiplied in u64: two u32 dimensions overflow a u32 long before they
    // reach a limit, and an overflowed product compares as a small number —
    // which is precisely the check passing for the largest possible image.
    let canvas = u64::from(width) * u64::from(height);
    let decoded = canvas.saturating_mul(u64::from(decoder.color_type().bytes_per_pixel()));
    let (pixels, decode_bytes) = match format {
        // The screen is what `image` reports; the first frame is what it
        // reads, into a buffer of its own when the two differ.
        ImageFormat::Gif => {
            let frames = crate::frames::gif(bytes)?;
            let first = frames.first.map_or(0, |(w, h)| u64::from(w) * u64::from(h));
            (
                canvas.max(frames.largest),
                decoded.saturating_add(first.saturating_mul(4)),
            )
        }
        // The bitstream is decoded into planes, or a 4-byte scratch image,
        // beside the output.
        ImageFormat::WebP => {
            crate::frames::webp(bytes, (width, height))?;
            (canvas, decoded.saturating_add(canvas.saturating_mul(4)))
        }
        _ => (canvas, decoded),
    };
    let probe = bounded(
        limits,
        Probe {
            width,
            height,
            format,
            decode_bytes,
        },
        pixels,
    )?;
    Ok((probe, Some(decoder)))
}

/// Hold a probe to the ceilings: pixels, then zero sides, then memory.
fn bounded(limits: Limits, probe: Probe, pixels: u64) -> Result<Probe, EngineError> {
    if pixels > limits.max_pixels {
        return Err(EngineError::TooManyPixels {
            pixels,
            limit: limits.max_pixels,
        });
    }
    if probe.width == 0 || probe.height == 0 {
        return Err(EngineError::ZeroDimension);
    }
    if probe.decode_bytes > limits.max_memory {
        return Err(EngineError::MemoryLimit {
            needed: probe.decode_bytes,
            limit: limits.max_memory,
        });
    }
    Ok(probe)
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
