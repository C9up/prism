//! Writing the result back out.

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::codecs::webp::WebPEncoder;
use image::{DynamicImage, ImageFormat};
use std::io::Cursor;

use crate::error::EngineError;

/// Encode, dropping every piece of metadata the input carried.
///
/// Not a step that has to be taken: these encoders write pixels, so EXIF,
/// GPS, XMP and colour profiles simply do not survive. Worth stating because
/// it is a privacy property people expect to have to ask for.
///
/// Three formats take a hand-written path because they need a decision the
/// generic one cannot make — a quality, a lossless mode, an alpha channel the
/// container cannot hold. Everything else goes through `image`'s own
/// `write_to`, which is also what keeps a newly-enabled format working here
/// without a matching arm being added.
pub fn encode(
    image: &DynamicImage,
    format: ImageFormat,
    quality: u8,
    depth: u8,
) -> Result<Vec<u8>, EngineError> {
    let mut out = Vec::new();
    match format {
        ImageFormat::Jpeg => {
            // JPEG has no alpha, and `to_rgb8()` alone does NOT solve that:
            // it drops the alpha channel and keeps whatever colour was
            // underneath, so a fully transparent red pixel is written as
            // opaque red. The image has to be composited onto a background
            // first — see `flatten` in lib.rs.
            let rgb = DynamicImage::ImageRgb8(image.to_rgb8());
            let mut cursor = Cursor::new(&mut out);
            let encoder = JpegEncoder::new_with_quality(&mut cursor, quality.clamp(1, 100));
            rgb.write_with_encoder(encoder)
                .map_err(|error| EngineError::Encode(error.to_string()))?;
        }
        ImageFormat::Png => {
            // PNG is one of the two formats that carries sixteen bits, so a
            // pipeline asking for depth gets it here rather than being
            // silently narrowed.
            let source = if depth >= 16 {
                DynamicImage::ImageRgba16(image.to_rgba16())
            } else {
                image.clone()
            };
            let mut cursor = Cursor::new(&mut out);
            source
                .write_with_encoder(PngEncoder::new(&mut cursor))
                .map_err(|error| EngineError::Encode(error.to_string()))?;
        }
        ImageFormat::WebP => {
            let rgba = image.to_rgba8();
            if quality >= 100 {
                // Lossless, through `image`'s own encoder. Asked for
                // explicitly by a quality of 100 — the one value that cannot
                // mean "compress a bit".
                let mut cursor = Cursor::new(&mut out);
                DynamicImage::ImageRgba8(rgba)
                    .write_with_encoder(WebPEncoder::new_lossless(&mut cursor))
                    .map_err(|error| EngineError::Encode(error.to_string()))?;
            } else {
                // Lossy, through libwebp. `image` has no lossy WebP encoder,
                // and a lossless WebP is several times the size of a lossy
                // one — which defeats the reason anyone reaches for the
                // format at all. libwebp is vendored and built from source by
                // `libwebp-sys`, so this costs a C compiler at build time and
                // no system library.
                let encoder = webp::Encoder::from_rgba(rgba.as_raw(), rgba.width(), rgba.height());
                out = encoder.encode(f32::from(quality.clamp(1, 100))).to_vec();
            }
        }
        other => {
            // The generic path. Several of these accept only one colour type —
            // Farbfeld wants 16-bit RGBA, HDR and OpenEXR want 32-bit float —
            // and `write_to` says so rather than writing something wrong, so
            // the conversion is attempted once and the refusal is reported as
            // it comes.
            let mut cursor = Cursor::new(&mut out);
            let converted = match other {
                ImageFormat::Farbfeld => DynamicImage::ImageRgba16(image.to_rgba16()),
                ImageFormat::Hdr | ImageFormat::OpenExr => {
                    DynamicImage::ImageRgb32F(image.to_rgb32f())
                }
                // TIFF is the other format that carries sixteen bits.
                ImageFormat::Tiff if depth >= 16 => DynamicImage::ImageRgba16(image.to_rgba16()),
                // GIF is palette-based but its encoder quantises for us; ICO
                // and the rest take 8-bit RGBA.
                _ => DynamicImage::ImageRgba8(image.to_rgba8()),
            };
            converted
                .write_to(&mut cursor, other)
                .map_err(|error| EngineError::Encode(error.to_string()))?;
        }
    }
    Ok(out)
}

/// Whether an output format can carry transparency.
///
/// JPEG cannot, and the float formats model light rather than coverage — an
/// alpha channel written there is not what a viewer will read back.
pub fn keeps_alpha(format: ImageFormat) -> bool {
    !matches!(
        format,
        ImageFormat::Jpeg | ImageFormat::Hdr | ImageFormat::OpenExr
    )
}
