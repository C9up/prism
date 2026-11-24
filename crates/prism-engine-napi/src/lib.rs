//! NAPI bindings for the Prism image engine.
//!
//! Two crossings, never more: `inspect` reads a header synchronously because
//! it touches a few hundred bytes, and `process` hands the whole pipeline to
//! a libuv worker because decoding, resampling and re-encoding a photograph
//! is tens of milliseconds that must not sit on the event loop.
//!
//! Beside the engine, `openedPath` names the file behind a descriptor on the
//! systems where only native code can ask: the image endpoint confines what
//! it opened, not what it named.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::panic::{catch_unwind, AssertUnwindSafe};

mod opened;

use prism_engine::{
    error::EngineError, guard, ops::Fit, Colour, Limits, Metadata, Operation, Output,
};

/// Run engine work with a panic net.
///
/// Every input here is an upload. A panic crossing the NAPI boundary takes
/// the whole Node process down — on a worker thread it aborts outright — so
/// no path may let one escape, however malformed the file.
fn guarded<T, F>(doing: &str, work: F) -> Result<T>
where
    F: FnOnce() -> std::result::Result<T, EngineError>,
{
    match catch_unwind(AssertUnwindSafe(work)) {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(Error::new(
            Status::GenericFailure,
            format!("{}: {}", error.code(), error),
        )),
        Err(_) => Err(Error::new(
            Status::GenericFailure,
            format!("INTERNAL_PANIC: internal panic while {doing}"),
        )),
    }
}

#[napi(object)]
pub struct JsLimits {
    /// Largest decoded pixel count allowed. Default 50000000.
    pub max_pixels: Option<i64>,
    /// Largest input accepted, in bytes. Default 67108864.
    pub max_bytes: Option<i64>,
    /// Largest working set one pipeline may hold, in bytes. Default
    /// 536870912.
    pub max_memory: Option<i64>,
    /// Formats this application will DECODE. Default jpeg, png, webp.
    ///
    /// Every decoder is compiled in; this is the runtime gate. Widening it
    /// exposes more parser surface to whatever an upload form receives, so
    /// the list is named rather than inherited.
    pub allowed_formats: Option<Vec<String>>,
}

fn limits_of(limits: Option<JsLimits>) -> Result<Limits> {
    let defaults = Limits::default();
    let Some(limits) = limits else {
        return Ok(defaults);
    };
    let allowed = match limits.allowed_formats {
        Some(names) if !names.is_empty() => {
            guard::FormatSet::from_names(names).map_err(|error| {
                Error::new(Status::InvalidArg, format!("{}: {}", error.code(), error))
            })?
        }
        // An empty list is a config that would refuse every image. Read as
        // "unset" rather than honoured, because honouring it means every
        // upload fails with a message about an allowlist nobody remembers
        // writing.
        _ => defaults.allowed,
    };
    Ok(Limits {
        allowed,
        // Negative or zero is not "no limit" — it is a caller who computed a
        // limit wrongly, and reading it as unbounded is how the guard gets
        // switched off by accident. Fall back to the default instead.
        max_pixels: limits
            .max_pixels
            .filter(|value| *value > 0)
            .map(|value| value as u64)
            .unwrap_or(defaults.max_pixels),
        max_bytes: limits
            .max_bytes
            .filter(|value| *value > 0)
            .map(|value| value as usize)
            .unwrap_or(defaults.max_bytes),
        max_memory: limits
            .max_memory
            .filter(|value| *value > 0)
            .map(|value| value as u64)
            .unwrap_or(defaults.max_memory),
    })
}

#[napi(object)]
pub struct JsColour {
    pub r: u32,
    pub g: u32,
    pub b: u32,
    /// 0-255. Defaults to fully opaque.
    pub a: Option<u32>,
}

#[napi(object)]
pub struct JsMetadata {
    pub width: u32,
    pub height: u32,
    pub format: String,
    /// Dimensions after the EXIF orientation is applied.
    pub oriented_width: u32,
    pub oriented_height: u32,
    pub orientation: u32,
    pub has_alpha: bool,
    /// The colour space the file DECLARES. `srgb` for the majority, which
    /// declare nothing — `image` reads no ICC profile.
    pub color_space: String,
}

/// One pipeline step.
///
/// NAMED NAPI CONSTRAINT. The engine models this as a Rust enum with a
/// payload per variant, which is the shape the operation actually has.
/// napi-rs cannot carry a tagged union across the boundary, so it is flattened
/// to a discriminator plus optional fields and validated back into the enum in
/// `operation_of`. The TypeScript side declares the real union and builds
/// these, so the flat shape is never what a caller writes.
#[napi(object)]
pub struct JsOperation {
    pub kind: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fit: Option<String>,
    pub x: Option<i64>,
    pub y: Option<i64>,
    /// `f64`, not `i32`: napi converts to an `i32` by truncating the fraction
    /// and keeping the low 32 bits, so `2^32 + 90` would arrive as 90. Checked
    /// back into an `i32` in `operation_of`.
    pub degrees: Option<f64>,
    pub axis: Option<String>,
    pub image: Option<Buffer>,
    pub opacity: Option<f64>,
    pub text: Option<String>,
    pub font: Option<Buffer>,
    pub size: Option<f64>,
    pub color: Option<JsColour>,
    /// Blur / sharpen radius.
    pub sigma: Option<f64>,
    /// Sharpen: contrast step below which nothing is sharpened, so flat areas
    /// like sky do not have their sensor noise amplified. `f64` for the same
    /// reason as `degrees`.
    pub threshold: Option<f64>,
    /// Brighten (-255..255), contrast (-255..255) and hue rotation (degrees).
    pub value: Option<f64>,
    /// `thumbnail`: ignore the aspect ratio, as `fit: "fill"` does.
    pub exact: Option<bool>,
    /// A 3x3 convolution kernel, row-major — exactly nine values.
    pub kernel: Option<Vec<f64>>,
    /// `convertColorSpace`: the target space.
    pub to: Option<String>,
    /// `convertColorSpace`: overrides what the FILE claims about its source.
    pub from: Option<String>,
}

#[napi(object)]
pub struct JsOutput {
    /// One of `jpeg`, `png`, `webp`.
    pub format: String,
    /// 1-100, for formats that have a quality knob. Default 82.
    pub quality: Option<u32>,
    /// What transparency is resolved against for a format with no alpha
    /// channel. Default opaque white.
    pub background: Option<JsColour>,
    /// Bits per channel: 8 (default) or 16. Only PNG and TIFF carry 16;
    /// elsewhere the encoder narrows it back rather than refusing.
    pub depth: Option<u32>,
    /// CPU effort, 0 (fastest) to 9 (slowest). Only AVIF has the knob.
    /// Default 4.
    pub effort: Option<u32>,
}

fn missing(kind: &str, field: &str) -> Error {
    Error::new(
        Status::InvalidArg,
        format!("INVALID_OPERATION: a \"{kind}\" operation needs \"{field}\""),
    )
}

fn non_negative(kind: &str, field: &str, value: i64) -> Result<u32> {
    if value < 0 || value > i64::from(u32::MAX) {
        return Err(Error::new(
            Status::InvalidArg,
            format!("INVALID_OPERATION: \"{kind}\".{field} must be between 0 and 4294967295, got {value}"),
        ));
    }
    Ok(value as u32)
}

/// A whole number JavaScript sent as a double, refused unless it is one and
/// in `low..=high`.
fn whole(kind: &str, field: &str, value: f64, low: i32, high: i32) -> Result<i32> {
    if !value.is_finite()
        || value.fract() != 0.0
        || value < f64::from(low)
        || value > f64::from(high)
    {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "INVALID_OPERATION: \"{kind}\".{field} must be a whole number between {low} and {high}, got {value}"
            ),
        ));
    }
    // Exact: integral and inside the i32 range, both checked above.
    Ok(value as i32)
}

/// A real number JavaScript sent as a double, refused unless it is finite,
/// in `low..=high`, and still finite once narrowed to the engine's `f32`.
///
/// A plain `as f32` turned NaN into a silent no-op (a composite whose every
/// alpha became zero) and 1e300 into infinity.
fn real(kind: &str, field: &str, value: f64, low: f64, high: f64) -> Result<f32> {
    // Narrowed on purpose: the engine works in f32, and the result is
    // checked below rather than trusted.
    let narrowed = value as f32;
    if !value.is_finite() || !narrowed.is_finite() || value < low || value > high {
        return Err(Error::new(
            Status::InvalidArg,
            format!(
                "INVALID_OPERATION: \"{kind}\".{field} must be a finite number between {low} and {high}, got {value}"
            ),
        ));
    }
    Ok(narrowed)
}

/// Any finite `f32`: the engine applies the field's own range.
fn any_real(kind: &str, field: &str, value: f64) -> Result<f32> {
    real(kind, field, value, f64::from(f32::MIN), f64::from(f32::MAX))
}

/// The largest contrast step a sharpen threshold can mean: a 16-bit channel's
/// full range.
const SHARPEN_THRESHOLD_MAX: i32 = 65_535;

/// Rebuild the engine's enum, refusing anything the flat shape allows but the
/// operation does not.
fn operation_of(op: JsOperation) -> Result<Operation> {
    let kind = op.kind.as_str();
    match kind {
        "resize" => {
            if op.width.is_none() && op.height.is_none() {
                return Err(missing("resize", "width or height"));
            }
            let fit = Fit::parse(op.fit.as_deref().unwrap_or("cover")).map_err(|error| {
                Error::new(Status::InvalidArg, format!("INVALID_OPERATION: {error}"))
            })?;
            Ok(Operation::Resize {
                width: op.width,
                height: op.height,
                fit,
            })
        }
        "crop" => Ok(Operation::Crop {
            x: non_negative("crop", "x", op.x.ok_or_else(|| missing("crop", "x"))?)?,
            y: non_negative("crop", "y", op.y.ok_or_else(|| missing("crop", "y"))?)?,
            width: op.width.ok_or_else(|| missing("crop", "width"))?,
            height: op.height.ok_or_else(|| missing("crop", "height"))?,
        }),
        "rotate" => Ok(Operation::Rotate(whole(
            "rotate",
            "degrees",
            op.degrees.ok_or_else(|| missing("rotate", "degrees"))?,
            i32::MIN,
            i32::MAX,
        )?)),
        "flip" => Ok(Operation::Flip(
            op.axis.ok_or_else(|| missing("flip", "axis"))?,
        )),
        "composite" => Ok(Operation::Composite {
            image: op
                .image
                .ok_or_else(|| missing("composite", "image"))?
                .to_vec(),
            x: op.x.unwrap_or(0),
            y: op.y.unwrap_or(0),
            opacity: real("composite", "opacity", op.opacity.unwrap_or(1.0), 0.0, 1.0)?,
        }),
        "watermarkText" => {
            let colour = op.color.unwrap_or(JsColour {
                r: 255,
                g: 255,
                b: 255,
                a: Some(255),
            });
            Ok(Operation::WatermarkText {
                text: op.text.ok_or_else(|| missing("watermarkText", "text"))?,
                font: op
                    .font
                    .ok_or_else(|| missing("watermarkText", "font"))?
                    .to_vec(),
                size: any_real("watermarkText", "size", op.size.unwrap_or(32.0))?,
                colour: Colour {
                    r: colour.r.min(255) as u8,
                    g: colour.g.min(255) as u8,
                    b: colour.b.min(255) as u8,
                    a: colour.a.unwrap_or(255).min(255) as u8,
                },
                x: op.x.unwrap_or(0),
                y: op.y.unwrap_or(0),
            })
        }
        "thumbnail" => {
            if op.width.is_none() && op.height.is_none() {
                return Err(missing("thumbnail", "width or height"));
            }
            Ok(Operation::Thumbnail {
                width: op.width,
                height: op.height,
                exact: op.exact.unwrap_or(false),
            })
        }
        "blur" => Ok(Operation::Blur(any_real(
            "blur",
            "sigma",
            op.sigma.ok_or_else(|| missing("blur", "sigma"))?,
        )?)),
        "fastBlur" => Ok(Operation::FastBlur(any_real(
            "fastBlur",
            "sigma",
            op.sigma.ok_or_else(|| missing("fastBlur", "sigma"))?,
        )?)),
        "sharpen" => Ok(Operation::Sharpen {
            sigma: any_real(
                "sharpen",
                "sigma",
                op.sigma.ok_or_else(|| missing("sharpen", "sigma"))?,
            )?,
            // Zero, not a guess: no threshold means sharpen everything, which
            // is what an unqualified "sharpen" asks for.
            threshold: match op.threshold {
                Some(value) => whole("sharpen", "threshold", value, 0, SHARPEN_THRESHOLD_MAX)?,
                None => 0,
            },
        }),
        "brighten" => Ok(Operation::Brighten(whole(
            "brighten",
            "value",
            op.value.ok_or_else(|| missing("brighten", "value"))?,
            i32::MIN,
            i32::MAX,
        )?)),
        "contrast" => Ok(Operation::Contrast(any_real(
            "contrast",
            "value",
            op.value.ok_or_else(|| missing("contrast", "value"))?,
        )?)),
        "hueRotate" => Ok(Operation::HueRotate(whole(
            "hueRotate",
            "value",
            op.value.ok_or_else(|| missing("hueRotate", "value"))?,
            i32::MIN,
            i32::MAX,
        )?)),
        "convertColorSpace" => Ok(Operation::ConvertColourSpace {
            to: op.to.ok_or_else(|| missing("convertColorSpace", "to"))?,
            from: op.from,
        }),
        "invert" => Ok(Operation::Invert),
        "grayscale" => Ok(Operation::Grayscale),
        "filter3x3" => Ok(Operation::Filter3x3(
            op.kernel
                .ok_or_else(|| missing("filter3x3", "kernel"))?
                .into_iter()
                .map(|value| any_real("filter3x3", "kernel", value))
                .collect::<Result<Vec<f32>>>()?,
        )),
        other => Err(Error::new(
            Status::InvalidArg,
            format!("INVALID_OPERATION: \"{other}\" is not a known operation"),
        )),
    }
}

fn metadata_of(metadata: Metadata) -> JsMetadata {
    JsMetadata {
        width: metadata.width,
        height: metadata.height,
        format: metadata.format,
        oriented_width: metadata.oriented_width,
        oriented_height: metadata.oriented_height,
        orientation: u32::from(metadata.orientation),
        has_alpha: metadata.has_alpha,
        color_space: metadata.colour_space,
    }
}

/// Identify an image from its header. Synchronous: it reads a few hundred
/// bytes and never allocates a pixel buffer.
#[napi]
pub fn inspect(bytes: Buffer, limits: Option<JsLimits>) -> Result<JsMetadata> {
    let owned = bytes.to_vec();
    let limits = limits_of(limits)?;
    guarded("inspecting an image", || {
        prism_engine::inspect(&owned, limits)
    })
    .map(metadata_of)
}

pub struct ProcessTask {
    input: Vec<u8>,
    operations: Vec<Operation>,
    output: Output,
    limits: Limits,
    auto_orient: bool,
}

impl Task for ProcessTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        // A panic on a libuv worker aborts the process outright — there is no
        // catch above it — and every byte here came from an upload.
        guarded("processing an image", || {
            prism_engine::process(
                &self.input,
                &self.operations,
                &self.output,
                self.limits,
                self.auto_orient,
            )
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(Buffer::from(output))
    }
}

/// Run a pipeline on a worker thread.
///
/// The buffers are copied into owned vectors HERE, on the JS thread: a napi
/// `Buffer` borrows memory the JS heap owns and garbage-collects, and holding
/// one across a thread boundary is a use-after-free waiting for the right
/// allocation pattern.
// The return type is declared rather than inferred: napi-derive cannot see
// through `AsyncTask<T>` to the `JsValue` the task resolves with, so without
// this the generated declaration says `Promise<unknown>` and every caller has
// to assert what the Rust already knows.
#[napi(ts_return_type = "Promise<Buffer>")]
pub fn process(
    input: Buffer,
    operations: Vec<JsOperation>,
    output: JsOutput,
    limits: Option<JsLimits>,
    auto_orient: Option<bool>,
) -> Result<AsyncTask<ProcessTask>> {
    let format = guard::parse_format(&output.format)
        .map_err(|error| Error::new(Status::InvalidArg, format!("{}: {}", error.code(), error)))?;
    let operations = operations
        .into_iter()
        .map(operation_of)
        .collect::<Result<Vec<_>>>()?;
    let effort = match output.effort {
        None => prism_engine::encode::DEFAULT_EFFORT,
        Some(effort) if effort <= u32::from(prism_engine::encode::MAX_EFFORT) => effort as u8,
        Some(effort) => {
            return Err(Error::new(
                Status::InvalidArg,
                format!("INVALID_OPERATION: effort must be between 0 and 9, got {effort}"),
            ))
        }
    };

    Ok(AsyncTask::new(ProcessTask {
        input: input.to_vec(),
        operations,
        output: Output {
            format,
            quality: output.quality.unwrap_or(82).clamp(1, 100) as u8,
            background: output
                .background
                .map(|colour| Colour {
                    r: colour.r.min(255) as u8,
                    g: colour.g.min(255) as u8,
                    b: colour.b.min(255) as u8,
                    a: 255,
                })
                .unwrap_or(Output::WHITE),
            depth: match output.depth {
                Some(16) => Output::DEPTH_16,
                // Anything else is eight. A caller asking for 12 or 32 gets
                // the web's depth rather than an error, for the same reason
                // depth is narrowed rather than refused per format.
                _ => Output::DEPTH_8,
            },
            effort,
        },
        limits: limits_of(limits)?,
        auto_orient: auto_orient.unwrap_or(true),
    }))
}

/// QR code options, in the names of the npm `qrcode` package. The numbers
/// arrive as JavaScript numbers and are validated in the engine: converted to
/// `u32` here, a negative margin would wrap to four billion first.
#[napi(object)]
pub struct JsQrOptions {
    pub error_correction_level: Option<String>,
    pub version: Option<f64>,
    pub margin: Option<f64>,
    pub scale: Option<f64>,
    pub width: Option<f64>,
    pub dark: Option<String>,
    pub light: Option<String>,
    /// The `qr-code-styling` options, in its names.
    pub dots_options: Option<JsQrFigure>,
    pub corners_square_options: Option<JsQrFigure>,
    pub corners_dot_options: Option<JsQrFigure>,
    pub background_options: Option<JsQrBackground>,
    /// The logo's bytes; the engine probes and decodes them under its limits.
    pub image: Option<Buffer>,
    pub image_options: Option<JsQrImageOptions>,
}

#[napi(object)]
pub struct JsQrColorStop {
    pub offset: f64,
    pub color: String,
}

#[napi(object)]
pub struct JsQrGradient {
    #[napi(js_name = "type")]
    pub kind: Option<String>,
    pub rotation: Option<f64>,
    pub color_stops: Vec<JsQrColorStop>,
}

#[napi(object)]
pub struct JsQrFigure {
    #[napi(js_name = "type")]
    pub kind: Option<String>,
    pub color: Option<String>,
    pub gradient: Option<JsQrGradient>,
}

#[napi(object)]
pub struct JsQrBackground {
    pub round: Option<f64>,
    pub color: Option<String>,
    pub gradient: Option<JsQrGradient>,
}

#[napi(object)]
pub struct JsQrImageOptions {
    pub image_size: Option<f64>,
    pub margin: Option<f64>,
    pub hide_background_dots: Option<bool>,
}

fn qr_gradient_of(gradient: JsQrGradient) -> prism_engine::qr::Gradient {
    prism_engine::qr::Gradient {
        kind: gradient.kind,
        rotation: gradient.rotation,
        color_stops: gradient
            .color_stops
            .into_iter()
            .map(|stop| prism_engine::qr::ColorStop {
                offset: stop.offset,
                color: stop.color,
            })
            .collect(),
    }
}

fn qr_figure_of(figure: JsQrFigure) -> prism_engine::qr::Figure {
    prism_engine::qr::Figure {
        kind: figure.kind,
        color: figure.color,
        gradient: figure.gradient.map(qr_gradient_of),
    }
}

fn qr_options_of(options: Option<JsQrOptions>) -> prism_engine::qr::QrOptions {
    match options {
        None => prism_engine::qr::QrOptions::default(),
        Some(options) => prism_engine::qr::QrOptions {
            error_correction_level: options.error_correction_level,
            version: options.version,
            margin: options.margin,
            scale: options.scale,
            width: options.width,
            dark: options.dark,
            light: options.light,
            dots: options.dots_options.map(qr_figure_of),
            corners_square: options.corners_square_options.map(qr_figure_of),
            corners_dot: options.corners_dot_options.map(qr_figure_of),
            background: options
                .background_options
                .map(|background| prism_engine::qr::Background {
                    round: background.round,
                    color: background.color,
                    gradient: background.gradient.map(qr_gradient_of),
                }),
            // Copied: the task outlives the call, and the JS heap owns the
            // buffer (see `ProcessTask`).
            image: options.image.map(|image| image.to_vec()),
            image_options: options
                .image_options
                .map(|image| prism_engine::qr::ImageOptions {
                    image_size: image.image_size,
                    margin: image.margin,
                    hide_background_dots: image.hide_background_dots,
                }),
        },
    }
}

pub struct QrSvgTask {
    text: String,
    options: prism_engine::qr::QrOptions,
}

impl Task for QrSvgTask {
    type Output = String;
    type JsValue = String;

    fn compute(&mut self) -> Result<Self::Output> {
        guarded("writing a QR code", || {
            prism_engine::qr::svg(&self.text, &self.options)
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// A QR code as an SVG document, on a worker thread: a logo is decoded and
/// re-encoded, which is not work for the event loop.
#[napi(ts_return_type = "Promise<string>")]
pub fn qr_svg(text: String, options: Option<JsQrOptions>) -> AsyncTask<QrSvgTask> {
    AsyncTask::new(QrSvgTask {
        text,
        options: qr_options_of(options),
    })
}

pub struct QrImageTask {
    text: String,
    options: prism_engine::qr::QrOptions,
    format: prism_engine::ImageFormat,
    quality: u8,
}

impl Task for QrImageTask {
    type Output = Vec<u8>;
    type JsValue = Buffer;

    fn compute(&mut self) -> Result<Self::Output> {
        guarded("rendering a QR code", || {
            prism_engine::qr::image(&self.text, &self.options, self.format, self.quality)
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(Buffer::from(output))
    }
}

/// A QR code as an image, on a worker thread: AVIF encoding is not quick.
#[napi(ts_return_type = "Promise<Buffer>")]
pub fn qr_image(
    text: String,
    format: String,
    options: Option<JsQrOptions>,
    quality: Option<u32>,
) -> Result<AsyncTask<QrImageTask>> {
    let format = guard::parse_format(&format)
        .map_err(|error| Error::new(Status::InvalidArg, format!("{}: {}", error.code(), error)))?;
    Ok(AsyncTask::new(QrImageTask {
        text,
        options: qr_options_of(options),
        format,
        // Lossless by default: a QR code compresses well without loss, and
        // lossy artefacts on module edges are what makes a scanner hesitate.
        quality: quality.unwrap_or(100).clamp(1, 100) as u8,
    }))
}

/// A QR-bill's module matrix: `size` × `size`, row by row, one byte a module
/// (1 dark, 0 light).
#[napi(object)]
pub struct JsQrMatrix {
    pub size: u32,
    pub modules: Buffer,
}

/// The Swiss QR code's matrix, synchronously: a payload holds at most 997
/// bytes, and the bill that draws it is laid out synchronously too.
#[napi]
pub fn qr_swiss_matrix(payload: String) -> Result<JsQrMatrix> {
    guarded("encoding a Swiss QR code", || {
        prism_engine::qr::swiss::matrix(&payload)
    })
    .map(|matrix| JsQrMatrix {
        // At most 117 modules (version 25).
        size: matrix.size as u32,
        modules: Buffer::from(
            matrix
                .modules
                .into_iter()
                .map(u8::from)
                .collect::<Vec<u8>>(),
        ),
    })
}

/// The path of the file behind an open descriptor, as the system names it
/// now, or null where it cannot be asked from here (Linux reads procfs
/// itself). Synchronous: one system call, on a descriptor the caller holds.
#[napi]
pub fn opened_path(fd: i32) -> Option<String> {
    opened::path_of(fd)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn operation(kind: &str) -> JsOperation {
        JsOperation {
            kind: kind.to_string(),
            width: None,
            height: None,
            fit: None,
            x: None,
            y: None,
            degrees: None,
            axis: None,
            image: None,
            opacity: None,
            text: None,
            font: None,
            size: None,
            color: None,
            sigma: None,
            threshold: None,
            value: None,
            exact: None,
            kernel: None,
            to: None,
            from: None,
        }
    }

    fn rotate(degrees: f64) -> Result<Operation> {
        operation_of(JsOperation {
            degrees: Some(degrees),
            ..operation("rotate")
        })
    }

    fn sharpen(threshold: f64) -> Result<Operation> {
        operation_of(JsOperation {
            sigma: Some(1.0),
            threshold: Some(threshold),
            ..operation("sharpen")
        })
    }

    #[test]
    fn a_rotation_is_refused_rather_than_truncated_or_wrapped() {
        for degrees in [
            4_294_967_386.0,
            4_294_967_341.0,
            450.7,
            -2_147_483_738.0,
            f64::NAN,
            f64::INFINITY,
        ] {
            let error = rotate(degrees).expect_err(&degrees.to_string());
            assert!(
                error.reason.starts_with("INVALID_OPERATION:"),
                "{}",
                error.reason
            );
        }
        assert!(matches!(rotate(-270.0), Ok(Operation::Rotate(-270))));
        assert!(matches!(
            rotate(f64::from(i32::MAX)),
            Ok(Operation::Rotate(i32::MAX))
        ));
    }

    #[test]
    fn a_sharpen_threshold_is_refused_rather_than_truncated_or_wrapped() {
        for threshold in [4_294_967_301.0, 5.5, -1.0, 65_536.0, f64::NAN] {
            let error = sharpen(threshold).expect_err(&threshold.to_string());
            assert!(
                error.reason.starts_with("INVALID_OPERATION:"),
                "{}",
                error.reason
            );
        }
        assert!(matches!(
            sharpen(5.0),
            Ok(Operation::Sharpen { threshold: 5, .. })
        ));
    }

    fn refused(result: Result<Operation>, what: &str) {
        let error = result.expect_err(what);
        assert!(
            error.reason.starts_with("INVALID_OPERATION:"),
            "{what}: {}",
            error.reason
        );
    }

    fn valued(kind: &str, value: f64) -> Result<Operation> {
        operation_of(JsOperation {
            value: Some(value),
            ..operation(kind)
        })
    }

    #[test]
    fn brighten_and_hue_rotate_are_refused_rather_than_truncated_or_zeroed() {
        // The range itself, -255..=255, is the engine's to refuse.
        for value in [f64::NAN, f64::INFINITY, 2.9, 1e300] {
            refused(valued("brighten", value), &format!("brighten {value}"));
        }
        for value in [f64::NAN, f64::NEG_INFINITY, 2.9, 1e300] {
            refused(valued("hueRotate", value), &format!("hueRotate {value}"));
        }
        assert!(matches!(
            valued("brighten", -255.0),
            Ok(Operation::Brighten(-255))
        ));
        assert!(matches!(
            valued("hueRotate", 400.0),
            Ok(Operation::HueRotate(400))
        ));
    }

    #[test]
    fn every_real_field_is_refused_when_it_is_not_a_finite_f32() {
        let opacity = |value: f64| {
            operation_of(JsOperation {
                image: Some(Buffer::from(vec![0u8])),
                opacity: Some(value),
                ..operation("composite")
            })
        };
        for value in [f64::NAN, f64::INFINITY, -0.5, 1.5] {
            refused(opacity(value), &format!("opacity {value}"));
        }
        assert!(opacity(0.5).is_ok());

        let sigma = |kind: &str, value: f64| {
            operation_of(JsOperation {
                sigma: Some(value),
                ..operation(kind)
            })
        };
        for kind in ["blur", "fastBlur", "sharpen"] {
            for value in [f64::NAN, f64::INFINITY, 1e300] {
                refused(sigma(kind, value), &format!("{kind} sigma {value}"));
            }
        }

        for value in [f64::NAN, 1e300] {
            refused(valued("contrast", value), &format!("contrast {value}"));
        }

        let size = operation_of(JsOperation {
            text: Some("x".into()),
            font: Some(Buffer::from(vec![0u8])),
            size: Some(1e300),
            ..operation("watermarkText")
        });
        refused(size, "watermark size 1e300");

        let kernel = operation_of(JsOperation {
            kernel: Some(vec![0.0, 0.0, 0.0, 0.0, 1e300, 0.0, 0.0, 0.0, 0.0]),
            ..operation("filter3x3")
        });
        refused(kernel, "kernel 1e300");
    }
}
