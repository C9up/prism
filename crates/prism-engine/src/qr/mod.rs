//! QR codes: the module matrix, written as SVG or rasterised for an encoder.
//!
//! The shape follows the npm `qrcode` package (1.5.4, read from its tarball):
//! the same options and defaults — margin 4 modules, scale 4 pixels, a
//! `width` that overrides the scale once it can hold the symbol, dark and
//! light colours in hex with an optional alpha — and the same SVG, a single
//! `path` of horizontal runs with `shape-rendering="crispEdges"`, so a page
//! that styled the output of one keeps working with the other.
//!
//! The text and every option may come from a request, so each is bounded
//! before anything is allocated: the text to what a QR code can hold, the
//! raster to a side of [`MAX_SIDE`] pixels, the colours to strict hex — the
//! SVG is written from the parsed channels, never from the string given.
//!
//! The styled variant — module and finder shapes, gradients, a logo — lives
//! in [`style`], after `qr-code-styling`.

use image::{DynamicImage, ImageFormat, Rgba, RgbaImage};
use qrcode::types::QrError;
use qrcode::{Color, EcLevel, QrCode, Version};

use crate::encode::encode;
use crate::error::EngineError;

mod style;
pub mod swiss;

pub use style::{Background, ColorStop, Figure, Gradient, ImageOptions};

/// The largest side, in pixels, a rasterised QR code may have. A version 40
/// symbol is 177 modules; at the default scale of 4 with its margin that is
/// 740 pixels, so the cap leaves room for print sizes and stops a `width`
/// from a request from allocating a gigapixel.
pub const MAX_SIDE: u32 = 4096;

/// The most a QR code holds: 7089 digits in numeric mode (version 40, level
/// L). Anything longer is refused before the encoder spends time on it.
pub const MAX_TEXT_BYTES: usize = 7089;

/// The most modules a margin may add on each side.
const MAX_MARGIN: u32 = 64;

/// What the caller may set. `None` means the npm `qrcode` default.
#[derive(Debug, Clone, Default)]
pub struct QrOptions {
    pub error_correction_level: Option<String>,
    pub version: Option<f64>,
    pub margin: Option<f64>,
    pub scale: Option<f64>,
    pub width: Option<f64>,
    pub dark: Option<String>,
    pub light: Option<String>,
    /// `qr-code-styling`'s `dotsOptions`: the data modules.
    pub dots: Option<Figure>,
    /// `cornersSquareOptions`: the finder patterns' 7 × 7 frames.
    pub corners_square: Option<Figure>,
    /// `cornersDotOptions`: the finder patterns' 3 × 3 centres.
    pub corners_dot: Option<Figure>,
    pub background: Option<Background>,
    /// The logo's bytes, decoded through Prism's guards.
    pub image: Option<Vec<u8>>,
    pub image_options: Option<ImageOptions>,
}

impl QrOptions {
    /// Whether any `qr-code-styling` option is set — the styled renderer
    /// takes over from the npm `qrcode` one.
    fn is_styled(&self) -> bool {
        self.dots.is_some()
            || self.corners_square.is_some()
            || self.corners_dot.is_some()
            || self.background.is_some()
            || self.image.is_some()
            || self.image_options.is_some()
    }
}

/// The options, validated and with their defaults.
#[derive(Debug, Clone, Copy)]
struct Resolved {
    level: EcLevel,
    version: Option<i16>,
    margin: u32,
    scale: f64,
    width: Option<u32>,
    dark: [u8; 4],
    light: [u8; 4],
}

/// The encoded symbol: `size` × `size` modules, row by row, dark = true.
struct Matrix {
    size: usize,
    modules: Vec<bool>,
}

fn invalid(message: impl Into<String>) -> EngineError {
    EngineError::QrOption(message.into())
}

/// A whole number within `[min, max]`, or the option error naming it.
fn whole(name: &str, value: f64, min: u32, max: u32) -> Result<u32, EngineError> {
    if value.fract() != 0.0 || value < f64::from(min) || value > f64::from(max) {
        return Err(invalid(format!(
            "{name} must be a whole number from {min} to {max}, got {value}"
        )));
    }
    // In range and whole, so the conversion is exact.
    Ok(value as u32)
}

/// The least contrast accepted between what is drawn and the background —
/// WCAG's 3:1 for graphical objects. Below it a scanner may not separate the
/// modules from the background, so the combination is refused.
const MIN_CONTRAST: f64 = 3.0;

/// WCAG relative luminance of an sRGB colour.
fn luminance([r, g, b, _]: [u8; 4]) -> f64 {
    let linear = |channel: u8| {
        let c = f64::from(channel) / 255.0;
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

/// Refuse a foreground that does not stand out from the background. The
/// foreground is blended over the background first, as it will be seen; a
/// fully transparent background shows whatever the page has, which cannot
/// be known here, so it is not judged.
fn check_contrast(name: &str, foreground: [u8; 4], background: [u8; 4]) -> Result<(), EngineError> {
    if background[3] == 0 {
        return Ok(());
    }
    let alpha = f64::from(foreground[3]) / 255.0;
    let blend = |i: usize| {
        (f64::from(foreground[i]) * alpha + f64::from(background[i]) * (1.0 - alpha)).round() as u8
    };
    let seen = [blend(0), blend(1), blend(2), 255];
    let (a, b) = (luminance(seen), luminance(background));
    let ratio = (a.max(b) + 0.05) / (a.min(b) + 0.05);
    if ratio < MIN_CONTRAST {
        return Err(invalid(format!(
            "{name} is too close to the background to scan (contrast {ratio:.2}:1, at least {MIN_CONTRAST}:1)"
        )));
    }
    Ok(())
}

/// `L`/`M`/`Q`/`H`, or the long names the npm package also accepts.
fn level_of(name: &str) -> Result<EcLevel, EngineError> {
    match name.to_ascii_lowercase().as_str() {
        "l" | "low" => Ok(EcLevel::L),
        "m" | "medium" => Ok(EcLevel::M),
        "q" | "quartile" => Ok(EcLevel::Q),
        "h" | "high" => Ok(EcLevel::H),
        _ => Err(invalid(format!(
            "errorCorrectionLevel must be L, M, Q or H, got \"{name}\""
        ))),
    }
}

/// `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa` (the `#` optional, as upstream).
/// Strict: anything else is refused, because the colour ends up in the SVG.
fn colour_of(name: &str, value: &str) -> Result<[u8; 4], EngineError> {
    let hex = value.strip_prefix('#').unwrap_or(value);
    let digits: Vec<u8> = hex
        .chars()
        .map(|c| c.to_digit(16).map(|d| d as u8))
        .collect::<Option<_>>()
        .ok_or_else(|| invalid(format!("{name} must be a hex colour, got \"{value}\"")))?;
    let full: Vec<u8> = match digits.len() {
        3 | 4 => digits.iter().flat_map(|&d| [d, d]).collect(),
        6 | 8 => digits,
        _ => {
            return Err(invalid(format!(
                "{name} must be a hex colour, got \"{value}\""
            )))
        }
    };
    let byte = |i: usize| full[i * 2] * 16 + full[i * 2 + 1];
    Ok([
        byte(0),
        byte(1),
        byte(2),
        if full.len() == 8 { byte(3) } else { 255 },
    ])
}

fn resolve(options: &QrOptions) -> Result<Resolved, EngineError> {
    let scale = options.scale.unwrap_or(4.0);
    if !scale.is_finite() || scale <= 0.0 {
        return Err(invalid(format!(
            "scale must be a positive number, got {scale}"
        )));
    }
    // Upstream ignores a width under 21 — the smallest symbol has 21
    // modules — and uses the scale instead; the same here, once it is a
    // valid number at all.
    let width = match options.width {
        None => None,
        Some(value) => {
            let width = whole("width", value, 1, MAX_SIDE)?;
            (width >= 21).then_some(width)
        }
    };
    Ok(Resolved {
        // A logo hides modules, so it gets the most error correction unless
        // the caller chose otherwise: the hidden area is sized from the
        // level's recovery capacity either way.
        level: match &options.error_correction_level {
            Some(name) => level_of(name)?,
            None if options.image.is_some() => EcLevel::H,
            None => EcLevel::M,
        },
        version: match options.version {
            Some(value) => Some(whole("version", value, 1, 40)? as i16),
            None => None,
        },
        margin: match options.margin {
            Some(value) => whole("margin", value, 0, MAX_MARGIN)?,
            None => 4,
        },
        scale,
        width,
        dark: match &options.dark {
            Some(value) => colour_of("color.dark", value)?,
            None => [0, 0, 0, 255],
        },
        light: match &options.light {
            Some(value) => colour_of("color.light", value)?,
            None => [255, 255, 255, 255],
        },
    })
}

fn matrix(text: &str, options: &Resolved) -> Result<Matrix, EngineError> {
    if text.is_empty() {
        return Err(EngineError::Empty);
    }
    if text.len() > MAX_TEXT_BYTES {
        return Err(EngineError::QrTooLong { bytes: text.len() });
    }
    let code = match options.version {
        Some(version) => QrCode::with_version(text, Version::Normal(version), options.level),
        None => QrCode::with_error_correction_level(text, options.level),
    }
    .map_err(|error| match error {
        QrError::DataTooLong => EngineError::QrTooLong { bytes: text.len() },
        other => invalid(other.to_string()),
    })?;
    Ok(Matrix {
        size: code.width(),
        modules: code
            .to_colors()
            .into_iter()
            .map(|colour| colour == Color::Dark)
            .collect(),
    })
}

/// Pixels per module: the width's when it can hold the symbol, else the
/// scale (upstream's `getScale`).
fn scale_for(size: usize, options: &Resolved) -> f64 {
    let modules = size as f64 + f64::from(options.margin) * 2.0;
    match options.width {
        Some(width) if f64::from(width) >= modules => f64::from(width) / modules,
        _ => options.scale,
    }
}

/// The raster's side in pixels, bounded by [`MAX_SIDE`].
fn side_of(size: usize, options: &Resolved) -> Result<u32, EngineError> {
    let scale = scale_for(size, options);
    let side = ((size as f64 + f64::from(options.margin) * 2.0) * scale).floor();
    if side < 1.0 || side > f64::from(MAX_SIDE) {
        return Err(invalid(format!(
            "the image would be {side} pixels wide, over the {MAX_SIDE}-pixel limit"
        )));
    }
    // Whole and within MAX_SIDE, so the conversion is exact.
    Ok(side as u32)
}

/// `fill="#rrggbb"`, plus the opacity when the colour is not opaque.
fn colour_attribute(colour: [u8; 4], attribute: &str) -> String {
    let [r, g, b, a] = colour;
    let base = format!("{attribute}=\"#{r:02x}{g:02x}{b:02x}\"");
    if a == 255 {
        return base;
    }
    // Upstream writes `.50`, dropping the leading zero; so does this.
    let opacity = format!("{:.2}", f64::from(a) / 255.0);
    format!(
        "{base} {attribute}-opacity=\"{}\"",
        opacity.trim_start_matches('0')
    )
}

/// The dark modules as one path of horizontal runs, stroked half a module
/// down each row (upstream's `qrToPath`).
fn path_of(matrix: &Matrix, margin: u32) -> String {
    let mut path = String::new();
    let size = matrix.size;
    for row in 0..size {
        let mut col = 0;
        let mut cursor: Option<usize> = None;
        while col < size {
            if !matrix.modules[row * size + col] {
                col += 1;
                continue;
            }
            let start = col;
            while col < size && matrix.modules[row * size + col] {
                col += 1;
            }
            match cursor {
                None => path.push_str(&format!(
                    "M{} {}.5",
                    start as u32 + margin,
                    row as u32 + margin
                )),
                Some(end) => path.push_str(&format!("m{} 0", start - end)),
            }
            path.push_str(&format!("h{}", col - start));
            cursor = Some(col);
        }
    }
    path
}

/// The QR code as an SVG document.
pub fn svg(text: &str, options: &QrOptions) -> Result<String, EngineError> {
    if options.is_styled() {
        return style::svg(text, options);
    }
    let options = resolve(options)?;
    check_contrast("color.dark", options.dark, options.light)?;
    let matrix = matrix(text, &options)?;
    let total = matrix.size as u32 + options.margin * 2;
    let background = if options.light[3] == 0 {
        String::new()
    } else {
        format!(
            "<path {} d=\"M0 0h{total}v{total}H0z\"/>",
            colour_attribute(options.light, "fill")
        )
    };
    let dimensions = match options.width {
        Some(width) => format!("width=\"{width}\" height=\"{width}\" "),
        None => String::new(),
    };
    Ok(format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" {dimensions}viewBox=\"0 0 {total} {total}\" shape-rendering=\"crispEdges\">{background}<path {} d=\"{}\"/></svg>\n",
        colour_attribute(options.dark, "stroke"),
        path_of(&matrix, options.margin),
    ))
}

/// The QR code as an image, encoded as `format` (upstream's `qrToImageData`
/// for the pixels, Prism's encoders for the bytes).
pub fn image(
    text: &str,
    options: &QrOptions,
    format: ImageFormat,
    quality: u8,
) -> Result<Vec<u8>, EngineError> {
    if options.is_styled() {
        return style::image(text, options, format, quality);
    }
    let options = resolve(options)?;
    check_contrast("color.dark", options.dark, options.light)?;
    let matrix = matrix(text, &options)?;
    let side = side_of(matrix.size, &options)?;
    let scale = scale_for(matrix.size, &options);
    let scaled_margin = f64::from(options.margin) * scale;
    let last = matrix.size - 1;
    let pixels = RgbaImage::from_fn(side, side, |x, y| {
        let (x, y) = (f64::from(x), f64::from(y));
        let inside = x >= scaled_margin
            && y >= scaled_margin
            && x < f64::from(side) - scaled_margin
            && y < f64::from(side) - scaled_margin;
        if !inside {
            return Rgba(options.light);
        }
        // Clamped: at the far edge the division can land on `size` itself.
        let col = (((x - scaled_margin) / scale) as usize).min(last);
        let row = (((y - scaled_margin) / scale) as usize).min(last);
        if matrix.modules[row * matrix.size + col] {
            Rgba(options.dark)
        } else {
            Rgba(options.light)
        }
    });
    encode(&DynamicImage::ImageRgba8(pixels), format, quality, 8)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn defaults() -> QrOptions {
        QrOptions::default()
    }

    /// Replay the path onto a grid — proof that the SVG draws exactly the
    /// modules the encoder produced.
    fn grid_from_path(path: &str, size: usize, margin: u32) -> Vec<bool> {
        let mut grid = vec![false; size * size];
        let (mut x, mut y) = (0i64, 0i64);
        let mut chars = path.chars().peekable();
        let number = |chars: &mut std::iter::Peekable<std::str::Chars>| {
            let mut s = String::new();
            while let Some(&c) = chars.peek() {
                if c.is_ascii_digit() || c == '.' {
                    s.push(c);
                    chars.next();
                } else {
                    break;
                }
            }
            s.parse::<f64>().expect("a number")
        };
        while let Some(command) = chars.next() {
            match command {
                'M' => {
                    x = number(&mut chars) as i64;
                    chars.next();
                    y = number(&mut chars).floor() as i64;
                }
                'm' => {
                    x += number(&mut chars) as i64;
                    chars.next();
                    number(&mut chars);
                }
                'h' => {
                    let run = number(&mut chars) as i64;
                    for dx in 0..run {
                        let col = (x + dx - i64::from(margin)) as usize;
                        let row = (y - i64::from(margin)) as usize;
                        grid[row * size + col] = true;
                    }
                    x += run;
                }
                _ => {}
            }
        }
        grid
    }

    #[test]
    fn the_svg_draws_every_dark_module_and_no_other() {
        let options = resolve(&defaults()).expect("defaults");
        let matrix = matrix("https://ream.dev/qr?x=1&y=2", &options).expect("encodes");
        let path = path_of(&matrix, 4);
        assert_eq!(grid_from_path(&path, matrix.size, 4), matrix.modules);
    }

    #[test]
    fn writes_upstreams_svg_shape() {
        let svg = svg("hello", &defaults()).expect("svg");
        // Version 1 at level M: 21 modules, plus 4 on each side.
        assert!(svg.starts_with(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 29 29\" shape-rendering=\"crispEdges\">"
        ));
        assert!(svg.contains("<path fill=\"#ffffff\" d=\"M0 0h29v29H0z\"/>"));
        assert!(svg.contains("<path stroke=\"#000000\" d=\"M4 4.5h7"));
    }

    #[test]
    fn writes_colours_from_the_parsed_channels() {
        let svg = svg(
            "hello",
            &QrOptions {
                dark: Some("#12345680".into()),
                light: Some("#fff0".into()),
                ..defaults()
            },
        )
        .expect("svg");
        assert!(svg.contains("stroke=\"#123456\" stroke-opacity=\".50\""));
        // A transparent background is left out entirely, as upstream does.
        assert!(!svg.contains("M0 0h"));
    }

    #[test]
    fn refuses_a_colour_that_is_not_strict_hex() {
        for colour in ["red", "#12", "#12345", "\"/><script>", "#gggggg"] {
            let result = svg(
                "hello",
                &QrOptions {
                    dark: Some(colour.into()),
                    ..defaults()
                },
            );
            assert!(matches!(result, Err(EngineError::QrOption(_))), "{colour}");
        }
    }

    #[test]
    fn refuses_a_dark_colour_too_close_to_the_light_one() {
        let pale = QrOptions {
            dark: Some("#cccccc".into()),
            ..defaults()
        };
        assert!(matches!(svg("hello", &pale), Err(EngineError::QrOption(_))));
        // Blended over the background as it will be seen: half-transparent
        // black on white is still a scannable grey.
        let translucent = QrOptions {
            dark: Some("#00000080".into()),
            ..defaults()
        };
        assert!(svg("hello", &translucent).is_ok());
    }

    #[test]
    fn refuses_text_a_qr_code_cannot_hold() {
        let long = "x".repeat(3000);
        assert!(matches!(
            svg(&long, &defaults()),
            Err(EngineError::QrTooLong { .. })
        ));
        assert!(matches!(
            svg(&"1".repeat(MAX_TEXT_BYTES + 1), &defaults()),
            Err(EngineError::QrTooLong { .. })
        ));
        assert!(matches!(svg("", &defaults()), Err(EngineError::Empty)));
    }

    #[test]
    fn refuses_options_out_of_range() {
        for options in [
            QrOptions {
                margin: Some(-1.0),
                ..defaults()
            },
            QrOptions {
                margin: Some(1.5),
                ..defaults()
            },
            QrOptions {
                version: Some(41.0),
                ..defaults()
            },
            QrOptions {
                scale: Some(0.0),
                ..defaults()
            },
            QrOptions {
                scale: Some(f64::NAN),
                ..defaults()
            },
            QrOptions {
                width: Some(5000.0),
                ..defaults()
            },
            QrOptions {
                error_correction_level: Some("X".into()),
                ..defaults()
            },
        ] {
            assert!(matches!(
                svg("hello", &options),
                Err(EngineError::QrOption(_))
            ));
        }
    }

    #[test]
    fn refuses_a_raster_over_the_side_limit() {
        let huge = QrOptions {
            scale: Some(200.0),
            ..defaults()
        };
        assert!(matches!(
            image("hello", &huge, ImageFormat::Png, 100),
            Err(EngineError::QrOption(_))
        ));
    }

    #[test]
    fn a_rasterised_code_reads_back_in_every_format() {
        let text = "otpauth://totp/Acme:ada?secret=JBSWY3DPEHPK3PXP&issuer=Acme";
        for format in [ImageFormat::Png, ImageFormat::WebP, ImageFormat::Avif] {
            let bytes = image(text, &defaults(), format, 100).expect("encodes");
            let decoded = image::load_from_memory(&bytes).expect("decodes").to_luma8();
            let (width, height) = decoded.dimensions();
            let read = rxing::helpers::detect_in_luma(
                decoded.into_raw(),
                width,
                height,
                Some(rxing::BarcodeFormat::QR_CODE),
            )
            .expect("reads");
            assert_eq!(read.getText(), text, "{format:?}");
        }
    }

    #[test]
    fn width_sets_the_side_as_upstream_does() {
        let options = QrOptions {
            width: Some(290.0),
            ..defaults()
        };
        let png = image("hello", &options, ImageFormat::Png, 100).expect("png");
        let decoded = image::load_from_memory(&png).expect("decodes");
        assert_eq!(decoded.width(), 290);
        assert!(svg("hello", &options)
            .expect("svg")
            .contains("width=\"290\" height=\"290\""));
    }
}
