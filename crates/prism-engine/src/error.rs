//! Engine failures.
//!
//! Every variant is something a caller can act on, and none of them carries
//! internal detail a caller cannot use. The NAPI layer turns each into a
//! coded error so a controller can branch on "the upload was not an image"
//! without matching on a message.

use std::fmt;

#[derive(Debug)]
pub enum EngineError {
    Empty,
    TooLarge {
        bytes: usize,
        limit: usize,
    },
    TooManyPixels {
        pixels: u64,
        limit: u64,
    },
    ZeroDimension,
    UnknownFormat,
    UnsupportedFormat(String),
    Unreadable(String),
    Decode(String),
    Encode(String),
    /// A geometry the image cannot satisfy — a crop outside its bounds, a
    /// target size of zero.
    Geometry(String),
    Font(String),
}

impl EngineError {
    /// The stable code the TypeScript layer raises under.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Empty => "EMPTY_INPUT",
            Self::TooLarge { .. } => "INPUT_TOO_LARGE",
            Self::TooManyPixels { .. } => "TOO_MANY_PIXELS",
            Self::ZeroDimension => "ZERO_DIMENSION",
            Self::UnknownFormat => "UNKNOWN_FORMAT",
            Self::UnsupportedFormat(_) => "UNSUPPORTED_FORMAT",
            Self::Unreadable(_) => "UNREADABLE",
            Self::Decode(_) => "DECODE_FAILED",
            Self::Encode(_) => "ENCODE_FAILED",
            Self::Geometry(_) => "INVALID_GEOMETRY",
            Self::Font(_) => "INVALID_FONT",
        }
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => write!(f, "the input is empty"),
            Self::TooLarge { bytes, limit } => {
                write!(f, "the input is {bytes} bytes, over the {limit}-byte limit")
            }
            Self::TooManyPixels { pixels, limit } => write!(
                f,
                "the image declares {pixels} pixels, over the {limit}-pixel limit"
            ),
            Self::ZeroDimension => write!(f, "the image declares a zero width or height"),
            Self::UnknownFormat => write!(f, "the bytes do not identify as any known image format"),
            Self::UnsupportedFormat(name) => {
                write!(f, "\"{name}\" is not one of jpeg, png, webp")
            }
            Self::Unreadable(why) => write!(f, "the input could not be read: {why}"),
            Self::Decode(why) => write!(f, "decoding failed: {why}"),
            Self::Encode(why) => write!(f, "encoding failed: {why}"),
            Self::Geometry(why) => write!(f, "{why}"),
            Self::Font(why) => write!(f, "the font could not be read: {why}"),
        }
    }
}

impl std::error::Error for EngineError {}
