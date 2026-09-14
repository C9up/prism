//! Colour spaces.
//!
//! ## What this can and cannot do
//!
//! `image` models colour with CICP — the code points MPEG and the web use —
//! not with ICC profiles, and it exposes **no ICC reader**. Two consequences,
//! both worth knowing before reaching for this:
//!
//! 1. **The source space is what the file DECLARES**, and most files declare
//!    nothing. A JPEG carrying an Adobe RGB ICC profile is decoded as sRGB,
//!    because the profile is never read. Converting it will therefore convert
//!    from the wrong origin. `from` exists for exactly that case: an
//!    application that knows better says so.
//! 2. **Adobe RGB has no CICP code point at all.** It cannot be named here,
//!    by us or by anyone — that is a limitation of the model, not of this
//!    module. Wide-gamut work that needs it needs an ICC pipeline, which is a
//!    different dependency.
//!
//! What does work: sRGB, linear sRGB, Display P3, DCI-P3 and Rec.709,
//! converted between each other with the primaries and transfer function
//! applied properly rather than the samples reinterpreted.
//!
//! **Rec.2020 and the HDR transfers are NOT offered**, and deliberately so.
//! `image` has no colorimetric interpretation for BT.2020 primaries — every
//! conversion into or out of them fails with "not supported". Naming a space
//! that can only ever raise is worse than admitting it is absent, so
//! `rec2020`, `rec2100-pq` and `rec2100-hlg` were tried, proved to fail, and
//! removed rather than shipped as a promise.

use image::metadata::{
    Cicp, CicpColorPrimaries, CicpMatrixCoefficients, CicpTransferCharacteristics,
    CicpVideoFullRangeFlag,
};
use image::{ConvertColorOptions, DynamicImage};

use crate::error::EngineError;

/// Build a full-range RGB CICP from its two interesting halves.
const fn rgb(primaries: CicpColorPrimaries, transfer: CicpTransferCharacteristics) -> Cicp {
    Cicp {
        primaries,
        transfer,
        // Identity: these are RGB spaces, not YCbCr ones. `image`'s transform
        // API refuses anything else.
        matrix: CicpMatrixCoefficients::Identity,
        // Full range. Studio-swing levels are a video concern and the
        // transform API refuses them too.
        full_range: CicpVideoFullRangeFlag::FullRange,
    }
}

/// The spaces an application can name, and what each maps to.
///
/// A curated list rather than the whole CICP registry: every entry here is a
/// space someone actually delivers images in, and each one that cannot round
/// trip is worse than absent.
const SPACES: &[(&str, Cicp)] = &[
    ("srgb", Cicp::SRGB),
    ("linear-srgb", Cicp::SRGB_LINEAR),
    ("display-p3", Cicp::DISPLAY_P3),
    (
        "dci-p3",
        rgb(
            CicpColorPrimaries::SmpteRp431,
            CicpTransferCharacteristics::SRgb,
        ),
    ),
    (
        // BT.709 and sRGB share primaries — the same CICP code point 1. Only
        // the transfer function differs, and that difference is the whole
        // reason both are nameable here.
        "rec709",
        rgb(CicpColorPrimaries::SRgb, CicpTransferCharacteristics::Bt709),
    ),
];

/// Resolve a name an application wrote.
pub fn parse_space(name: &str) -> Result<Cicp, EngineError> {
    let lower = name.to_ascii_lowercase();
    SPACES
        .iter()
        .find(|(candidate, _)| *candidate == lower)
        .map(|(_, cicp)| *cicp)
        .ok_or_else(|| {
            EngineError::ColourSpace(format!(
                "\"{name}\" is not one of {}",
                SPACES
                    .iter()
                    .map(|(n, _)| *n)
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        })
}

/// The name for a space, for metadata. `unknown` when it is not one we name.
pub fn space_name(cicp: Cicp) -> &'static str {
    SPACES
        .iter()
        .find(|(_, candidate)| {
            candidate.primaries == cicp.primaries && candidate.transfer == cicp.transfer
        })
        .map(|(name, _)| *name)
        .unwrap_or("unknown")
}

/// Convert into `to`, optionally declaring where the samples actually came
/// from first.
///
/// `from` does not convert: it OVERRIDES what the file claims, for the common
/// case of an image whose real profile the decoder never read. Getting it
/// wrong produces a wrong picture rather than an error, which is why it is
/// opt-in and why the default is to trust the file.
pub fn convert(
    mut image: DynamicImage,
    to: Cicp,
    from: Option<Cicp>,
) -> Result<DynamicImage, EngineError> {
    if let Some(from) = from {
        image
            .set_color_space(from)
            .map_err(|error| EngineError::ColourSpace(error.to_string()))?;
    }
    image
        .apply_color_space(to, ConvertColorOptions::default())
        .map_err(|error| EngineError::ColourSpace(error.to_string()))?;
    Ok(image)
}

/// What `inspect` reports for a file that declares nothing — which is most of
/// them, because `image` reads no ICC and defaults to sRGB.
pub const DEFAULT_SPACE_NAME: &str = "srgb";
