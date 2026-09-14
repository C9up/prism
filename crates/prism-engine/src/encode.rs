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
pub fn encode(
    image: &DynamicImage,
    format: ImageFormat,
    quality: u8,
) -> Result<Vec<u8>, EngineError> {
    let mut out = Vec::new();
    match format {
        ImageFormat::Jpeg => {
            // JPEG has no alpha, and `to_rgb8()` alone does NOT solve that:
            // it drops the alpha channel and keeps whatever colour was
            // underneath, so a fully transparent red pixel is written as
            // opaque red. The image has to be composited onto a background
            // first — see `flatten`.
            let rgb = DynamicImage::ImageRgb8(image.to_rgb8());
            let mut cursor = Cursor::new(&mut out);
            let encoder = JpegEncoder::new_with_quality(&mut cursor, quality.clamp(1, 100));
            rgb.write_with_encoder(encoder)
                .map_err(|error| EngineError::Encode(error.to_string()))?;
        }
        ImageFormat::Png => {
            let mut cursor = Cursor::new(&mut out);
            image
                .write_with_encoder(PngEncoder::new(&mut cursor))
                .map_err(|error| EngineError::Encode(error.to_string()))?;
        }
        ImageFormat::WebP => {
            // NAMED LIMITATION: lossless only. `quality` is accepted and
            // ignored here rather than rejected, so that a pipeline written
            // against jpeg keeps working when its output format is switched —
            // and so that adding a lossy encoder later is not a breaking
            // change to the contract. The size difference is real: expect a
            // lossless WebP to be several times a lossy one.
            let rgba = DynamicImage::ImageRgba8(image.to_rgba8());
            let mut cursor = Cursor::new(&mut out);
            rgba.write_with_encoder(WebPEncoder::new_lossless(&mut cursor))
                .map_err(|error| EngineError::Encode(error.to_string()))?;
        }
        other => {
            return Err(EngineError::UnsupportedFormat(
                crate::guard::format_name(other).into(),
            ))
        }
    }
    Ok(out)
}

/// Whether an output format can carry transparency.
pub fn keeps_alpha(format: ImageFormat) -> bool {
    !matches!(format, ImageFormat::Jpeg)
}
