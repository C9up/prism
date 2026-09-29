//! Styled QR codes: the options and the geometry of `qr-code-styling` (1.9.2,
//! read from its tarball's sources) — module shapes rounded by their
//! neighbours, finder frames and centres, solid colours or gradients, a
//! rounded background and a logo in the middle.
//!
//! Lengths are in modules, like the rest of this module: the `viewBox` is the
//! symbol plus its margin, so `margin`, `scale` and `width` keep the npm
//! `qrcode` meaning. `qr-code-styling` counts in pixels of a canvas; its
//! shapes are the same, scaled.
//!
//! The raster is this SVG rendered by resvg, so the two cannot drift apart.
//! The logo is the exception: it is decoded once through Prism's guards,
//! embedded in the SVG as a re-encoded PNG, and composited onto the raster by
//! Prism rather than decoded a second time by the renderer.

use std::f64::consts::PI;

use image::{DynamicImage, ImageFormat, RgbaImage};
use qrcode::EcLevel;
use resvg::{tiny_skia, usvg};

use super::{check_contrast, colour_of, invalid, matrix, resolve, side_of, Matrix, QrOptions};
use crate::encode::encode;
use crate::error::EngineError;
use crate::guard::Limits;
use crate::ops::{self, Fit};

/// `dotsOptions`, `cornersSquareOptions` or `cornersDotOptions`.
#[derive(Debug, Clone, Default)]
pub struct Figure {
    /// `type`: a module shape, or a finder frame / centre shape.
    pub kind: Option<String>,
    pub color: Option<String>,
    /// Wins over `color`, as upstream.
    pub gradient: Option<Gradient>,
}

#[derive(Debug, Clone, Default)]
pub struct Gradient {
    /// `linear` (the default) or `radial`.
    pub kind: Option<String>,
    /// Radians, for a linear gradient.
    pub rotation: Option<f64>,
    pub color_stops: Vec<ColorStop>,
}

#[derive(Debug, Clone)]
pub struct ColorStop {
    /// 0 to 1.
    pub offset: f64,
    pub color: String,
}

/// `backgroundOptions`.
#[derive(Debug, Clone, Default)]
pub struct Background {
    /// 0 (square) to 1 (a circle's worth of corner radius).
    pub round: Option<f64>,
    pub color: Option<String>,
    pub gradient: Option<Gradient>,
}

/// `imageOptions`.
#[derive(Debug, Clone, Default)]
pub struct ImageOptions {
    /// The share of the level's error correction the logo may cover, 0 to
    /// [`MAX_IMAGE_SIZE`]. Default 0.4, as upstream.
    pub image_size: Option<f64>,
    /// Space around the logo, in modules. Default 0.
    pub margin: Option<f64>,
    /// Leave the modules under the logo out. Default true, as upstream.
    pub hide_background_dots: Option<bool>,
}

/// The most colour stops a gradient may have.
const MAX_STOPS: usize = 16;

/// The largest `imageSize` accepted. Upstream takes any number, and at 1 the
/// logo hides all of the level's error correction — the code no longer
/// scans. Half of it leaves the other half for damage and glare.
const MAX_IMAGE_SIZE: f64 = 0.5;

/// The longest side the logo is embedded at in the SVG: enough for print at
/// the size a logo takes in a QR code, not the megabytes of a photo.
const MAX_LOGO_SIDE: u32 = 1024;

/// A colour, or a gradient over a box.
#[derive(Debug, Clone)]
enum Paint {
    Solid([u8; 4]),
    Linear {
        rotation: f64,
        stops: Vec<(f64, [u8; 4])>,
    },
    Radial {
        stops: Vec<(f64, [u8; 4])>,
    },
}

impl Paint {
    fn colours(&self) -> Vec<[u8; 4]> {
        match self {
            Self::Solid(colour) => vec![*colour],
            Self::Linear { stops, .. } | Self::Radial { stops } => {
                stops.iter().map(|(_, colour)| *colour).collect()
            }
        }
    }
}

/// A paint with the box its gradient spans and the finder's extra rotation
/// (upstream's `_createColor` arguments).
#[derive(Debug, Clone)]
struct Placed {
    paint: Paint,
    area: Area,
    rotation: f64,
}

#[derive(Debug, Clone, Copy)]
struct Area {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DotType {
    Square,
    Dots,
    Rounded,
    ExtraRounded,
    Classy,
    ClassyRounded,
}

/// A finder's 7 × 7 frame.
#[derive(Debug, Clone, Copy)]
enum Frame {
    Dot,
    Square,
    ExtraRounded,
    /// Upstream's fallback: the frame's modules, drawn as data modules.
    Modules(DotType),
}

/// A finder's 3 × 3 centre.
#[derive(Debug, Clone, Copy)]
enum Centre {
    Dot,
    Square,
    Modules(DotType),
}

fn dot_type_of(name: &str) -> Option<DotType> {
    match name {
        "square" => Some(DotType::Square),
        "dots" => Some(DotType::Dots),
        "rounded" => Some(DotType::Rounded),
        "extra-rounded" => Some(DotType::ExtraRounded),
        "classy" => Some(DotType::Classy),
        "classy-rounded" => Some(DotType::ClassyRounded),
        _ => None,
    }
}

const DOT_TYPES: &str = "square, dots, rounded, extra-rounded, classy or classy-rounded";

fn dots_of(figure: Option<&Figure>) -> Result<DotType, EngineError> {
    match figure.and_then(|figure| figure.kind.as_deref()) {
        None => Ok(DotType::Square),
        Some(name) => dot_type_of(name).ok_or_else(|| {
            invalid(format!(
                "dotsOptions.type must be {DOT_TYPES}, got \"{name}\""
            ))
        }),
    }
}

/// The frame shapes first, then any module shape — upstream's order, which
/// is why `extra-rounded` names the frame shape here.
fn frame_of(figure: Option<&Figure>, dots: DotType) -> Result<Frame, EngineError> {
    match figure.and_then(|figure| figure.kind.as_deref()) {
        None => Ok(Frame::Modules(dots)),
        Some("dot") => Ok(Frame::Dot),
        Some("square") => Ok(Frame::Square),
        Some("extra-rounded") => Ok(Frame::ExtraRounded),
        Some(name) => dot_type_of(name).map(Frame::Modules).ok_or_else(|| {
            invalid(format!(
                "cornersSquareOptions.type must be dot, square, extra-rounded or {DOT_TYPES}, got \"{name}\""
            ))
        }),
    }
}

/// A centre drawn as nine separate dots is the one shape ZXing — the
/// decoder behind most phone scanners — cannot find, whatever the rest
/// looks like. Upstream falls back to it whenever the modules are `dots`;
/// here that fallback draws one round `dot` instead, and asking for it by
/// name is refused.
fn centre_of(figure: Option<&Figure>, dots: DotType) -> Result<Centre, EngineError> {
    match figure.and_then(|figure| figure.kind.as_deref()) {
        None if dots == DotType::Dots => Ok(Centre::Dot),
        None => Ok(Centre::Modules(dots)),
        Some("dot") => Ok(Centre::Dot),
        Some("square") => Ok(Centre::Square),
        Some("dots") => Err(invalid(
            "cornersDotOptions.type dots draws the finder centres as nine separate dots, \
             which scanners do not find; use dot",
        )),
        Some(name) => dot_type_of(name).map(Centre::Modules).ok_or_else(|| {
            invalid(format!(
                "cornersDotOptions.type must be dot, square or {DOT_TYPES}, got \"{name}\""
            ))
        }),
    }
}

fn gradient_of(name: &str, gradient: &Gradient) -> Result<Paint, EngineError> {
    let count = gradient.color_stops.len();
    if count == 0 || count > MAX_STOPS {
        return Err(invalid(format!(
            "{name}.colorStops must hold 1 to {MAX_STOPS} stops, got {count}"
        )));
    }
    let stops = gradient
        .color_stops
        .iter()
        .map(|stop| {
            if !stop.offset.is_finite() || !(0.0..=1.0).contains(&stop.offset) {
                return Err(invalid(format!(
                    "{name}.colorStops offsets must be from 0 to 1, got {}",
                    stop.offset
                )));
            }
            Ok((
                stop.offset,
                colour_of(&format!("{name}.colorStops"), &stop.color)?,
            ))
        })
        .collect::<Result<Vec<_>, _>>()?;
    match gradient.kind.as_deref() {
        None | Some("linear") => {
            let rotation = gradient.rotation.unwrap_or(0.0);
            if !rotation.is_finite() {
                return Err(invalid(format!("{name}.rotation must be a finite number")));
            }
            Ok(Paint::Linear { rotation, stops })
        }
        Some("radial") => Ok(Paint::Radial { stops }),
        Some(other) => Err(invalid(format!(
            "{name}.type must be linear or radial, got \"{other}\""
        ))),
    }
}

/// A figure's own paint: its gradient, else its colour, else none.
fn paint_of(
    name: &str,
    color: Option<&String>,
    gradient: Option<&Gradient>,
) -> Result<Option<Paint>, EngineError> {
    if let Some(gradient) = gradient {
        return Ok(Some(gradient_of(&format!("{name}.gradient"), gradient)?));
    }
    color
        .map(|color| Ok(Paint::Solid(colour_of(&format!("{name}.color"), color)?)))
        .transpose()
}

fn figure_paint(name: &str, figure: Option<&Figure>) -> Result<Option<Paint>, EngineError> {
    match figure {
        None => Ok(None),
        Some(figure) => paint_of(name, figure.color.as_ref(), figure.gradient.as_ref()),
    }
}

// ─── Geometry ───────────────────────────────────────────────────────
//
// Each shape is upstream's path, in a unit box, with a quarter-turn count in
// place of its `rotate(…)` transform: the points are turned before they are
// written, so every module lands in one `path` and a gradient spans them all.

#[derive(Debug, Clone, Copy)]
enum Step {
    Move(f64, f64),
    Line(f64, f64),
    Arc {
        radius: f64,
        sweep: bool,
        to: (f64, f64),
    },
}

use Step::{Arc, Line, Move};

const SQUARE: &[Step] = &[
    Move(0.0, 0.0),
    Line(0.0, 1.0),
    Line(1.0, 1.0),
    Line(1.0, 0.0),
];

const CIRCLE: &[Step] = &[
    Move(0.5, 0.0),
    Arc {
        radius: 0.5,
        sweep: false,
        to: (0.5, 1.0),
    },
    Arc {
        radius: 0.5,
        sweep: false,
        to: (0.5, 0.0),
    },
];

/// Unturned, the right side is rounded.
const SIDE_ROUNDED: &[Step] = &[
    Move(0.0, 0.0),
    Line(0.0, 1.0),
    Line(0.5, 1.0),
    Arc {
        radius: 0.5,
        sweep: false,
        to: (0.5, 0.0),
    },
];

/// Unturned, the top right corner is rounded.
const CORNER_ROUNDED: &[Step] = &[
    Move(0.0, 0.0),
    Line(0.0, 1.0),
    Line(1.0, 1.0),
    Line(1.0, 0.5),
    Arc {
        radius: 0.5,
        sweep: false,
        to: (0.5, 0.0),
    },
];

/// Unturned, the top right corner is rounded to the full side.
const CORNER_EXTRA_ROUNDED: &[Step] = &[
    Move(0.0, 0.0),
    Line(0.0, 1.0),
    Line(1.0, 1.0),
    Arc {
        radius: 1.0,
        sweep: false,
        to: (0.0, 0.0),
    },
];

/// Unturned, the bottom left and top right corners are rounded.
const CORNERS_ROUNDED: &[Step] = &[
    Move(0.0, 0.0),
    Line(0.0, 0.5),
    Arc {
        radius: 0.5,
        sweep: false,
        to: (0.5, 1.0),
    },
    Line(1.0, 1.0),
    Line(1.0, 0.5),
    Arc {
        radius: 0.5,
        sweep: false,
        to: (0.5, 0.0),
    },
];

/// A number as SVG wants it: at most four decimals, no trailing zeros.
fn num(value: f64) -> String {
    let text = format!("{value:.4}");
    let text = text.trim_end_matches('0').trim_end_matches('.');
    if text == "-0" {
        "0".to_string()
    } else {
        text.to_string()
    }
}

/// Write `steps`, turned `quarters` times clockwise about the box's centre
/// (SVG's `rotate(90)`), scaled to `size` at `(x, y)`.
fn push_shape(path: &mut String, steps: &[Step], x: f64, y: f64, size: f64, quarters: u8) {
    let place = |(px, py): (f64, f64)| {
        let (mut px, mut py) = (px, py);
        for _ in 0..quarters {
            (px, py) = (1.0 - py, px);
        }
        (num(x + px * size), num(y + py * size))
    };
    for step in steps {
        match *step {
            Move(px, py) => {
                let (x, y) = place((px, py));
                path.push_str(&format!("M{x} {y}"));
            }
            Line(px, py) => {
                let (x, y) = place((px, py));
                path.push_str(&format!("L{x} {y}"));
            }
            // A turn keeps the orientation, so the sweep flag stands.
            Arc { radius, sweep, to } => {
                let (x, y) = place(to);
                let r = num(radius * size);
                path.push_str(&format!("A{r} {r} 0 0 {} {x} {y}", u8::from(sweep)));
            }
        }
    }
    path.push('Z');
}

fn push_circle(path: &mut String, cx: f64, cy: f64, radius: f64) {
    push_shape(path, CIRCLE, cx - radius, cy - radius, radius * 2.0, 0);
}

#[derive(Debug, Clone, Copy, Default)]
struct Neighbours {
    left: bool,
    right: bool,
    top: bool,
    bottom: bool,
}

/// The shape of one module and its quarter turns, from its dark neighbours
/// (upstream's `QRDot`).
fn dot_shape(kind: DotType, n: Neighbours) -> (&'static [Step], u8) {
    let count = [n.left, n.right, n.top, n.bottom]
        .iter()
        .filter(|&&dark| dark)
        .count();
    match kind {
        DotType::Square => (SQUARE, 0),
        DotType::Dots => (CIRCLE, 0),
        DotType::Rounded | DotType::ExtraRounded => {
            if count == 0 {
                return (CIRCLE, 0);
            }
            if count > 2 || (n.left && n.right) || (n.top && n.bottom) {
                return (SQUARE, 0);
            }
            if count == 2 {
                let corner = if kind == DotType::Rounded {
                    CORNER_ROUNDED
                } else {
                    CORNER_EXTRA_ROUNDED
                };
                let quarters = if n.left && n.top {
                    1
                } else if n.top && n.right {
                    2
                } else if n.right && n.bottom {
                    3
                } else {
                    0
                };
                return (corner, quarters);
            }
            let quarters = if n.top {
                1
            } else if n.right {
                2
            } else if n.bottom {
                3
            } else {
                0
            };
            (SIDE_ROUNDED, quarters)
        }
        DotType::Classy | DotType::ClassyRounded => {
            let corner = if kind == DotType::Classy {
                CORNER_ROUNDED
            } else {
                CORNER_EXTRA_ROUNDED
            };
            if count == 0 {
                (CORNERS_ROUNDED, 1)
            } else if !n.left && !n.top {
                (corner, 3)
            } else if !n.right && !n.bottom {
                (corner, 1)
            } else {
                (SQUARE, 0)
            }
        }
    }
}

/// A finder's frame and centre, as upstream's `squareMask` and `dotMask`.
fn in_frame(row: i64, col: i64) -> bool {
    (0..7).contains(&row) && (0..7).contains(&col) && (row == 0 || row == 6 || col == 0 || col == 6)
}

fn in_centre(row: i64, col: i64) -> bool {
    (2..5).contains(&row) && (2..5).contains(&col)
}

/// Draw the cells of a finder mask as modules of `kind`.
fn push_mask(path: &mut String, kind: DotType, x: f64, y: f64, mask: fn(i64, i64) -> bool) {
    for row in 0..7 {
        for col in 0..7 {
            if !mask(row, col) {
                continue;
            }
            let (steps, quarters) = dot_shape(
                kind,
                Neighbours {
                    left: mask(row, col - 1),
                    right: mask(row, col + 1),
                    top: mask(row - 1, col),
                    bottom: mask(row + 1, col),
                },
            );
            push_shape(path, steps, x + col as f64, y + row as f64, 1.0, quarters);
        }
    }
}

fn frame_path(frame: Frame, x: f64, y: f64) -> String {
    let mut path = String::new();
    match frame {
        Frame::Dot => {
            push_circle(&mut path, x + 3.5, y + 3.5, 3.5);
            push_circle(&mut path, x + 3.5, y + 3.5, 2.5);
        }
        Frame::Square => {
            push_shape(&mut path, SQUARE, x, y, 7.0, 0);
            push_shape(&mut path, SQUARE, x + 1.0, y + 1.0, 5.0, 0);
        }
        Frame::ExtraRounded => {
            // Upstream's outer rounded square (radius 2.5) and inner one
            // (radius 1.5), in absolute coordinates.
            let p = |dx: f64, dy: f64| format!("{} {}", num(x + dx), num(y + dy));
            path.push_str(&format!(
                "M{}L{}A2.5 2.5 0 0 0 {}L{}A2.5 2.5 0 0 0 {}L{}A2.5 2.5 0 0 0 {}L{}A2.5 2.5 0 0 0 {}Z",
                p(0.0, 2.5),
                p(0.0, 4.5),
                p(2.5, 7.0),
                p(4.5, 7.0),
                p(7.0, 4.5),
                p(7.0, 2.5),
                p(4.5, 0.0),
                p(2.5, 0.0),
                p(0.0, 2.5),
            ));
            path.push_str(&format!(
                "M{}L{}A1.5 1.5 0 0 1 {}L{}A1.5 1.5 0 0 1 {}L{}A1.5 1.5 0 0 1 {}L{}A1.5 1.5 0 0 1 {}Z",
                p(2.5, 1.0),
                p(4.5, 1.0),
                p(6.0, 2.5),
                p(6.0, 4.5),
                p(4.5, 6.0),
                p(2.5, 6.0),
                p(1.0, 4.5),
                p(1.0, 2.5),
                p(2.5, 1.0),
            ));
        }
        Frame::Modules(kind) => push_mask(&mut path, kind, x, y, in_frame),
    }
    path
}

fn centre_path(centre: Centre, x: f64, y: f64) -> String {
    let mut path = String::new();
    match centre {
        Centre::Dot => push_circle(&mut path, x + 3.5, y + 3.5, 1.5),
        Centre::Square => push_shape(&mut path, SQUARE, x + 2.0, y + 2.0, 3.0, 0),
        Centre::Modules(kind) => push_mask(&mut path, kind, x, y, in_centre),
    }
    path
}

// ─── Paint ──────────────────────────────────────────────────────────

/// The `id` placeholder, replaced by a digest of the document once it is
/// written — `@` appears nowhere else in it.
const ID: &str = "@id@";

fn stops_of(stops: &[(f64, [u8; 4])]) -> String {
    stops
        .iter()
        .map(|(offset, [r, g, b, a])| {
            let opacity = if *a == 255 {
                String::new()
            } else {
                format!(" stop-opacity=\"{}\"", num(f64::from(*a) / 255.0))
            };
            format!(
                "<stop offset=\"{}%\" stop-color=\"#{r:02x}{g:02x}{b:02x}\"{opacity}/>",
                num(offset * 100.0)
            )
        })
        .collect()
}

/// The `fill` attribute for a placed paint, adding its gradient to `defs`
/// (upstream's `_createColor`).
fn fill_of(placed: &Placed, defs: &mut Vec<String>) -> String {
    let Area {
        x,
        y,
        width,
        height,
    } = placed.area;
    let id = format!("{ID}-{}", defs.len());
    let definition = match &placed.paint {
        Paint::Solid(colour) => return super::colour_attribute(*colour, "fill"),
        Paint::Radial { stops } => {
            let (cx, cy) = (num(x + width / 2.0), num(y + height / 2.0));
            format!(
                "<radialGradient id=\"{id}\" gradientUnits=\"userSpaceOnUse\" fx=\"{cx}\" fy=\"{cy}\" cx=\"{cx}\" cy=\"{cy}\" r=\"{}\">{}</radialGradient>",
                num(width.max(height) / 2.0),
                stops_of(stops)
            )
        }
        Paint::Linear { rotation, stops } => {
            let rotation = (rotation + placed.rotation) % (2.0 * PI);
            let positive = (rotation + 2.0 * PI) % (2.0 * PI);
            let (mut x0, mut y0) = (x + width / 2.0, y + height / 2.0);
            let (mut x1, mut y1) = (x0, y0);
            if positive <= 0.25 * PI || positive > 1.75 * PI {
                x0 -= width / 2.0;
                y0 -= height / 2.0 * rotation.tan();
                x1 += width / 2.0;
                y1 += height / 2.0 * rotation.tan();
            } else if positive <= 0.75 * PI {
                y0 -= height / 2.0;
                x0 -= width / 2.0 / rotation.tan();
                y1 += height / 2.0;
                x1 += width / 2.0 / rotation.tan();
            } else if positive <= 1.25 * PI {
                x0 += width / 2.0;
                y0 += height / 2.0 * rotation.tan();
                x1 -= width / 2.0;
                y1 -= height / 2.0 * rotation.tan();
            } else {
                y0 += height / 2.0;
                x0 += width / 2.0 / rotation.tan();
                y1 -= height / 2.0;
                x1 -= width / 2.0 / rotation.tan();
            }
            format!(
                "<linearGradient id=\"{id}\" gradientUnits=\"userSpaceOnUse\" x1=\"{}\" y1=\"{}\" x2=\"{}\" y2=\"{}\">{}</linearGradient>",
                num(x0),
                num(y0),
                num(x1),
                num(y1),
                stops_of(stops)
            )
        }
    };
    defs.push(definition);
    format!("fill=\"url(#{id})\"")
}

// ─── Logo ───────────────────────────────────────────────────────────

/// The logo and where it sits, in modules.
struct Logo {
    image: DynamicImage,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    /// Modules left out around the centre, across and down.
    hide_x: f64,
    hide_y: f64,
    hide: bool,
}

/// The share of codewords each level can recover.
fn recovery(level: EcLevel) -> f64 {
    match level {
        EcLevel::L => 0.07,
        EcLevel::M => 0.15,
        EcLevel::Q => 0.25,
        EcLevel::H => 0.3,
    }
}

/// Upstream's `calculateImageSize` with a module as the unit: the most
/// modules, odd on each axis, the logo may cover at its aspect ratio.
/// Returns the logo's size and the hidden modules across and down.
fn logo_area(
    image_width: u32,
    image_height: u32,
    max_hidden: f64,
    max_axis: f64,
) -> (f64, f64, f64, f64) {
    let k = f64::from(image_height) / f64::from(image_width);
    let mut hide_x = (max_hidden / k).sqrt().floor().max(1.0).min(max_axis);
    if hide_x % 2.0 == 0.0 {
        hide_x -= 1.0;
    }
    let mut width = hide_x;
    let mut hide_y = 1.0 + 2.0 * ((hide_x * k - 1.0) / 2.0).ceil();
    let mut height = width * k;
    if hide_y * hide_x > max_hidden || max_axis < hide_y {
        if max_axis < hide_y {
            hide_y = max_axis;
            // Upstream decrements the other axis here, which leaves this one
            // even and the logo off-centre in its hole.
            if hide_y % 2.0 == 0.0 {
                hide_y -= 1.0;
            }
        } else {
            hide_y -= 2.0;
        }
        height = hide_y;
        hide_x = 1.0 + 2.0 * ((hide_y / k - 1.0) / 2.0).ceil();
        width = height / k;
    }
    (width, height, hide_x, hide_y)
}

fn logo_of(
    bytes: &[u8],
    options: Option<&ImageOptions>,
    level: EcLevel,
    count: usize,
    margin: f64,
) -> Result<Logo, EngineError> {
    let defaults = ImageOptions::default();
    let options = options.unwrap_or(&defaults);
    let image_size = options.image_size.unwrap_or(0.4);
    if !image_size.is_finite() || image_size <= 0.0 || image_size > MAX_IMAGE_SIZE {
        return Err(invalid(format!(
            "imageOptions.imageSize must be above 0 and at most {MAX_IMAGE_SIZE}, got {image_size}"
        )));
    }
    let image_margin = options.margin.unwrap_or(0.0);
    if !image_margin.is_finite() || image_margin < 0.0 {
        return Err(invalid(format!(
            "imageOptions.margin must be a positive number of modules, got {image_margin}"
        )));
    }
    // The logo is an upload as much as any image Prism processes: same
    // probe, same limits, before a pixel is decoded.
    let image = crate::decode(bytes, Limits::default(), true)?;
    let count_f = count as f64;
    let max_hidden = (image_size * recovery(level) * count_f * count_f).floor();
    let (width, height, hide_x, hide_y) =
        logo_area(image.width(), image.height(), max_hidden, count_f - 14.0);
    let (width, height) = (width - image_margin * 2.0, height - image_margin * 2.0);
    if max_hidden < 1.0 || hide_x < 1.0 || hide_y < 1.0 || width <= 0.0 || height <= 0.0 {
        return Err(invalid(
            "the logo has no room at this imageSize, imageOptions.margin and error correction",
        ));
    }
    Ok(Logo {
        x: margin + image_margin + (count_f - width - image_margin * 2.0) / 2.0,
        y: margin + image_margin + (count_f - height - image_margin * 2.0) / 2.0,
        width,
        height,
        hide_x,
        hide_y,
        hide: options.hide_background_dots.unwrap_or(true),
        image,
    })
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let byte = |i: usize| u32::from(chunk.get(i).copied().unwrap_or(0));
        let n = (byte(0) << 16) | (byte(1) << 8) | byte(2);
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(char::from(ALPHABET[((n >> (18 - 6 * i)) & 63) as usize]));
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// FNV-1a: a stable digest for the gradient ids, so two codes inlined in
/// one page do not share each other's gradients, and one code always
/// renders the same bytes.
fn digest(text: &str) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

// ─── Document ───────────────────────────────────────────────────────

/// What the raster needs besides the SVG.
struct Styled {
    svg: String,
    matrix_size: usize,
    total: f64,
    logo: Option<Logo>,
    resolved: super::Resolved,
}

/// Write the styled SVG. `embed_logo` is false for the raster, which
/// composites the decoded logo itself.
fn build(text: &str, options: &QrOptions, embed_logo: bool) -> Result<Styled, EngineError> {
    let resolved = resolve(options)?;
    let dots_kind = dots_of(options.dots.as_ref())?;
    let frame = frame_of(options.corners_square.as_ref(), dots_kind)?;
    let centre = centre_of(options.corners_dot.as_ref(), dots_kind)?;
    let background = match &options.background {
        None => None,
        Some(background) => paint_of(
            "backgroundOptions",
            background.color.as_ref(),
            background.gradient.as_ref(),
        )?,
    }
    .unwrap_or(Paint::Solid(resolved.light));
    let round = match options
        .background
        .as_ref()
        .and_then(|background| background.round)
    {
        None => 0.0,
        Some(round) if round.is_finite() && (0.0..=1.0).contains(&round) => round,
        Some(round) => {
            return Err(invalid(format!(
                "backgroundOptions.round must be from 0 to 1, got {round}"
            )))
        }
    };
    let dots_paint =
        figure_paint("dotsOptions", options.dots.as_ref())?.unwrap_or(Paint::Solid(resolved.dark));
    let frame_paint = figure_paint("cornersSquareOptions", options.corners_square.as_ref())?;
    let centre_paint = figure_paint("cornersDotOptions", options.corners_dot.as_ref())?;

    // Everything drawn must stand out from everything behind it.
    let mut drawn = dots_paint.colours();
    drawn.extend(frame_paint.iter().flat_map(Paint::colours));
    drawn.extend(centre_paint.iter().flat_map(Paint::colours));
    for foreground in &drawn {
        for behind in background.colours() {
            check_contrast("a module colour", *foreground, behind)?;
        }
    }

    let matrix: Matrix = matrix(text, &resolved)?;
    let count = matrix.size;
    let margin = f64::from(resolved.margin);
    let total = count as f64 + margin * 2.0;
    let logo = match &options.image {
        None => None,
        Some(bytes) => Some(logo_of(
            bytes,
            options.image_options.as_ref(),
            resolved.level,
            count,
            margin,
        )?),
    };

    // Upstream's filter: the finders are drawn apart, and the modules under
    // the logo are left out — which also rounds their neighbours.
    let last = count as i64 - 7;
    let shown = |row: i64, col: i64| -> bool {
        if row < 0 || col < 0 || row >= count as i64 || col >= count as i64 {
            return false;
        }
        if (row < 7 && col < 7) || (row < 7 && col >= last) || (row >= last && col < 7) {
            return false;
        }
        if let Some(logo) = logo.as_ref().filter(|logo| logo.hide) {
            let (r, c, n) = (row as f64, col as f64, count as f64);
            if r >= (n - logo.hide_y) / 2.0
                && r < (n + logo.hide_y) / 2.0
                && c >= (n - logo.hide_x) / 2.0
                && c < (n + logo.hide_x) / 2.0
            {
                return false;
            }
        }
        matrix.modules[row as usize * count + col as usize]
    };

    let mut defs = Vec::new();
    let mut body = String::new();
    let whole = Area {
        x: 0.0,
        y: 0.0,
        width: total,
        height: total,
    };

    let background_fill = fill_of(
        &Placed {
            paint: background.clone(),
            area: whole,
            rotation: 0.0,
        },
        &mut defs,
    );
    let invisible = matches!(background, Paint::Solid([_, _, _, 0]));
    if !invisible {
        let radius = if round > 0.0 {
            let r = num(total / 2.0 * round);
            format!(" rx=\"{r}\" ry=\"{r}\"")
        } else {
            String::new()
        };
        body.push_str(&format!(
            "<rect width=\"{t}\" height=\"{t}\"{radius} {background_fill}/>",
            t = num(total)
        ));
    }

    let mut dots = String::new();
    for row in 0..count as i64 {
        for col in 0..count as i64 {
            if !shown(row, col) {
                continue;
            }
            let (steps, quarters) = dot_shape(
                dots_kind,
                Neighbours {
                    left: shown(row, col - 1),
                    right: shown(row, col + 1),
                    top: shown(row - 1, col),
                    bottom: shown(row + 1, col),
                },
            );
            push_shape(
                &mut dots,
                steps,
                margin + col as f64,
                margin + row as f64,
                1.0,
                quarters,
            );
        }
    }
    let dots_placed = Placed {
        paint: dots_paint,
        area: whole,
        rotation: 0.0,
    };
    let dots_fill = fill_of(&dots_placed, &mut defs);
    if !dots.is_empty() {
        body.push_str(&format!("<path {dots_fill} d=\"{dots}\"/>"));
    }

    let offset = (count - 7) as f64;
    for (column, row, rotation) in [(0.0, 0.0, 0.0), (1.0, 0.0, PI / 2.0), (0.0, 1.0, -PI / 2.0)] {
        let (x, y) = (margin + column * offset, margin + row * offset);
        // Unset, a frame takes the modules' paint, and a centre the frame's.
        let frame_placed = frame_paint.clone().map(|paint| Placed {
            paint,
            area: Area {
                x,
                y,
                width: 7.0,
                height: 7.0,
            },
            rotation,
        });
        let centre_placed = centre_paint
            .clone()
            .map(|paint| Placed {
                paint,
                area: Area {
                    x: x + 2.0,
                    y: y + 2.0,
                    width: 3.0,
                    height: 3.0,
                },
                rotation,
            })
            .or_else(|| frame_placed.clone());
        let frame_fill = match &frame_placed {
            Some(placed) => fill_of(placed, &mut defs),
            None => dots_fill.clone(),
        };
        let centre_fill = match &centre_placed {
            Some(placed) => fill_of(placed, &mut defs),
            None => dots_fill.clone(),
        };
        body.push_str(&format!(
            "<path {frame_fill} fill-rule=\"evenodd\" d=\"{}\"/>",
            frame_path(frame, x, y)
        ));
        body.push_str(&format!(
            "<path {centre_fill} d=\"{}\"/>",
            centre_path(centre, x, y)
        ));
    }

    if let (Some(logo), true) = (&logo, embed_logo) {
        let embedded = ops::resize(
            logo.image.clone(),
            Some(MAX_LOGO_SIDE),
            Some(MAX_LOGO_SIDE),
            Fit::Inside,
        )?;
        let png = encode(&embedded, ImageFormat::Png, 100, 8)?;
        let href = format!("data:image/png;base64,{}", base64(&png));
        body.push_str(&format!(
            "<image x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" href=\"{href}\" xlink:href=\"{href}\"/>",
            num(logo.x),
            num(logo.y),
            num(logo.width),
            num(logo.height),
        ));
    }

    let defs = if defs.is_empty() {
        String::new()
    } else {
        format!("<defs>{}</defs>", defs.concat())
    };
    let dimensions = match resolved.width {
        Some(width) => format!("width=\"{width}\" height=\"{width}\" "),
        None => String::new(),
    };
    let document = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" {dimensions}viewBox=\"0 0 {t} {t}\">{defs}{body}</svg>\n",
        t = num(total)
    );
    let id = format!("qr{:012x}", digest(&document) >> 16);
    Ok(Styled {
        svg: document.replace(ID, &id),
        matrix_size: count,
        total,
        logo,
        resolved,
    })
}

/// The styled QR code as an SVG document.
pub(super) fn svg(text: &str, options: &QrOptions) -> Result<String, EngineError> {
    Ok(build(text, options, true)?.svg)
}

/// The styled QR code rendered by resvg, the logo composited, encoded as
/// `format`.
pub(super) fn image(
    text: &str,
    options: &QrOptions,
    format: ImageFormat,
    quality: u8,
) -> Result<Vec<u8>, EngineError> {
    let styled = build(text, options, false)?;
    let side = side_of(styled.matrix_size, &styled.resolved)?;
    let tree = usvg::Tree::from_str(&styled.svg, &usvg::Options::default())
        .map_err(|error| EngineError::Encode(format!("rendering the QR code: {error}")))?;
    let mut pixmap = tiny_skia::Pixmap::new(side, side)
        .ok_or_else(|| EngineError::Encode("rendering the QR code: no canvas".into()))?;
    let zoom = side as f32 / tree.size().width();
    resvg::render(
        &tree,
        tiny_skia::Transform::from_scale(zoom, zoom),
        &mut pixmap.as_mut(),
    );

    let mut pixels = RgbaImage::new(side, side);
    for (from, to) in pixmap.pixels().iter().zip(pixels.pixels_mut()) {
        let colour = from.demultiply();
        to.0 = [colour.red(), colour.green(), colour.blue(), colour.alpha()];
    }
    let mut image = DynamicImage::ImageRgba8(pixels);
    if let Some(logo) = styled.logo {
        let per_module = f64::from(side) / styled.total;
        let width = (logo.width * per_module).round().max(1.0) as u32;
        let height = (logo.height * per_module).round().max(1.0) as u32;
        let resized = ops::resize(logo.image, Some(width), Some(height), Fit::Fill)?;
        image = ops::composite(
            image,
            &resized,
            (logo.x * per_module).round() as i64,
            (logo.y * per_module).round() as i64,
        );
    }
    encode(&image, format, quality, 8)
}

#[cfg(test)]
mod tests {
    use super::*;

    const URI: &str = "otpauth://totp/Acme:ada?secret=JBSWY3DPEHPK3PXP&issuer=Acme";

    fn figure(kind: &str) -> Option<Figure> {
        Some(Figure {
            kind: Some(kind.into()),
            ..Figure::default()
        })
    }

    fn gradient(kind: &str, stops: &[&str]) -> Option<Gradient> {
        let last = stops.len().saturating_sub(1).max(1) as f64;
        Some(Gradient {
            kind: Some(kind.into()),
            rotation: Some(PI / 4.0),
            color_stops: stops
                .iter()
                .enumerate()
                .map(|(i, colour)| ColorStop {
                    offset: i as f64 / last,
                    color: (*colour).into(),
                })
                .collect(),
        })
    }

    /// A 60 × 40 two-colour logo, as an application would upload it.
    fn logo() -> Vec<u8> {
        let image = RgbaImage::from_fn(60, 40, |x, _| {
            if x < 30 {
                image::Rgba([220, 38, 38, 255])
            } else {
                image::Rgba([37, 99, 235, 255])
            }
        });
        encode(&DynamicImage::ImageRgba8(image), ImageFormat::Png, 100, 8).expect("logo")
    }

    fn read(bytes: &[u8]) -> String {
        let decoded = image::load_from_memory(bytes).expect("decodes").to_luma8();
        let (width, height) = decoded.dimensions();
        rxing::helpers::detect_in_luma(
            decoded.into_raw(),
            width,
            height,
            Some(rxing::BarcodeFormat::QR_CODE),
        )
        .expect("reads")
        .getText()
        .to_string()
    }

    fn scaled(options: QrOptions) -> QrOptions {
        QrOptions {
            scale: Some(8.0),
            ..options
        }
    }

    #[test]
    fn every_module_shape_reads_back() {
        for kind in [
            "square",
            "dots",
            "rounded",
            "extra-rounded",
            "classy",
            "classy-rounded",
        ] {
            let options = scaled(QrOptions {
                dots: figure(kind),
                ..QrOptions::default()
            });
            let png = image(URI, &options, ImageFormat::Png, 100).expect(kind);
            assert_eq!(read(&png), URI, "{kind}");
        }
    }

    #[test]
    fn every_finder_shape_reads_back() {
        for (frame, centre) in [
            ("dot", "dot"),
            ("square", "square"),
            ("extra-rounded", "dot"),
            ("rounded", "classy"),
            ("dots", "square"),
        ] {
            let options = scaled(QrOptions {
                dots: figure("rounded"),
                corners_square: figure(frame),
                corners_dot: figure(centre),
                ..QrOptions::default()
            });
            let png = image(URI, &options, ImageFormat::Png, 100).expect(frame);
            assert_eq!(read(&png), URI, "{frame} / {centre}");
        }
    }

    #[test]
    fn gradients_and_a_round_background_read_back_in_every_format() {
        let options = scaled(QrOptions {
            dots: Some(Figure {
                kind: Some("classy-rounded".into()),
                gradient: gradient("linear", &["#1e3a8a", "#7c3aed"]),
                ..Figure::default()
            }),
            corners_square: Some(Figure {
                kind: Some("extra-rounded".into()),
                gradient: gradient("radial", &["#111827", "#be123c"]),
                ..Figure::default()
            }),
            corners_dot: Some(Figure {
                kind: Some("dot".into()),
                color: Some("#0f172a".into()),
                ..Figure::default()
            }),
            background: Some(Background {
                round: Some(0.2),
                gradient: gradient("linear", &["#ffffff", "#f1f5f9"]),
                ..Background::default()
            }),
            ..QrOptions::default()
        });
        let svg = svg(URI, &options).expect("svg");
        assert!(svg.contains("<linearGradient id=\"qr"));
        assert!(svg.contains("<radialGradient id=\"qr"));
        assert!(svg.contains(" rx=\""));
        for format in [ImageFormat::Png, ImageFormat::WebP, ImageFormat::Avif] {
            let bytes = image(URI, &options, format, 100).expect("encodes");
            assert_eq!(read(&bytes), URI, "{format:?}");
        }
    }

    #[test]
    fn a_logo_is_re_encoded_hides_its_modules_and_reads_back() {
        let options = scaled(QrOptions {
            dots: figure("dots"),
            image: Some(logo()),
            ..QrOptions::default()
        });
        let with = svg(URI, &options).expect("svg");
        assert!(with.contains("<image x=\""));
        assert!(with.contains("href=\"data:image/png;base64,iVBORw0KGgo"));
        // The modules under the logo are left out.
        let without = svg(
            URI,
            &QrOptions {
                image: None,
                error_correction_level: Some("H".into()),
                ..options.clone()
            },
        )
        .expect("svg");
        let circles = |svg: &str| svg.matches("A0.5 0.5").count();
        assert!(circles(&with) < circles(&without));

        for format in [ImageFormat::Png, ImageFormat::WebP, ImageFormat::Avif] {
            let bytes = image(URI, &options, format, 100).expect("encodes");
            assert_eq!(read(&bytes), URI, "{format:?}");
        }
        // Even at level L the hidden area stays within what it recovers.
        let low = QrOptions {
            error_correction_level: Some("L".into()),
            ..options
        };
        assert_eq!(
            read(&image(URI, &low, ImageFormat::Png, 100).expect("L")),
            URI
        );
    }

    #[test]
    fn the_same_code_writes_the_same_bytes_and_ids_differ_between_codes() {
        let options = QrOptions {
            dots: Some(Figure {
                gradient: gradient("linear", &["#000000", "#1e3a8a"]),
                ..Figure::default()
            }),
            ..QrOptions::default()
        };
        let first = svg("one", &options).expect("svg");
        assert_eq!(first, svg("one", &options).expect("svg"));
        let id = |svg: &str| svg.split("id=\"").nth(1).map(|rest| rest[..14].to_string());
        assert_ne!(id(&first), id(&svg("two", &options).expect("svg")));
        assert!(!first.contains(ID));
    }

    #[test]
    fn refuses_what_would_not_scan_or_is_not_an_option() {
        let refused =
            |options: QrOptions| matches!(svg(URI, &options), Err(EngineError::QrOption(_)));
        // Too little contrast, in a colour or a gradient stop.
        assert!(refused(QrOptions {
            dots: Some(Figure {
                color: Some("#dddddd".into()),
                ..Figure::default()
            }),
            ..QrOptions::default()
        }));
        assert!(refused(QrOptions {
            corners_square: Some(Figure {
                gradient: gradient("linear", &["#000000", "#fafafa"]),
                ..Figure::default()
            }),
            ..QrOptions::default()
        }));
        // A logo over half the error correction.
        assert!(refused(QrOptions {
            image: Some(logo()),
            image_options: Some(ImageOptions {
                image_size: Some(0.8),
                ..ImageOptions::default()
            }),
            ..QrOptions::default()
        }));
        // A margin that leaves the logo no room.
        assert!(refused(QrOptions {
            image: Some(logo()),
            image_options: Some(ImageOptions {
                margin: Some(20.0),
                ..ImageOptions::default()
            }),
            ..QrOptions::default()
        }));
        for options in [
            QrOptions {
                dots: figure("stars"),
                ..QrOptions::default()
            },
            QrOptions {
                corners_dot: figure("extra-rounded-ish"),
                ..QrOptions::default()
            },
            QrOptions {
                corners_dot: figure("dots"),
                ..QrOptions::default()
            },
            QrOptions {
                dots: Some(Figure {
                    gradient: gradient("conic", &["#000000"]),
                    ..Figure::default()
                }),
                ..QrOptions::default()
            },
            QrOptions {
                dots: Some(Figure {
                    gradient: gradient("linear", &[]),
                    ..Figure::default()
                }),
                ..QrOptions::default()
            },
            QrOptions {
                background: Some(Background {
                    round: Some(2.0),
                    ..Background::default()
                }),
                ..QrOptions::default()
            },
            QrOptions {
                background: Some(Background {
                    color: Some("url(#x)".into()),
                    ..Background::default()
                }),
                ..QrOptions::default()
            },
        ] {
            assert!(refused(options));
        }
    }

    #[test]
    fn a_logo_goes_through_prisms_guards() {
        let result = svg(
            URI,
            &QrOptions {
                image: Some(b"<svg onload=alert(1)>".to_vec()),
                ..QrOptions::default()
            },
        );
        assert!(matches!(result, Err(EngineError::UnknownFormat)));
    }

    #[test]
    fn a_turned_shape_keeps_its_box() {
        // Side-rounded turned a quarter, as for a neighbour above: the
        // straight edges run along the top and left, the arc closes below.
        let mut path = String::new();
        push_shape(&mut path, SIDE_ROUNDED, 2.0, 3.0, 1.0, 1);
        assert_eq!(path, "M3 3L2 3L2 3.5A0.5 0.5 0 0 0 3 3.5Z");
    }

    #[test]
    fn base64_matches_the_rfc_vectors() {
        for (input, output) in [
            ("", ""),
            ("f", "Zg=="),
            ("fo", "Zm8="),
            ("foo", "Zm9v"),
            ("foob", "Zm9vYg=="),
            ("fooba", "Zm9vYmE="),
            ("foobar", "Zm9vYmFy"),
        ] {
            assert_eq!(base64(input.as_bytes()), output);
        }
    }
}
