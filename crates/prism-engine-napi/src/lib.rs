//! NAPI bindings for the Prism image engine.
//!
//! Two crossings, never more: `inspect` reads a header synchronously because
//! it touches a few hundred bytes, and `process` hands the whole pipeline to
//! a libuv worker because decoding, resampling and re-encoding a photograph
//! is tens of milliseconds that must not sit on the event loop.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::panic::{catch_unwind, AssertUnwindSafe};

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
}

fn limits_of(limits: Option<JsLimits>) -> Limits {
    let defaults = Limits::default();
    let Some(limits) = limits else {
        return defaults;
    };
    Limits {
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
    }
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
    pub degrees: Option<i32>,
    pub axis: Option<String>,
    pub image: Option<Buffer>,
    pub opacity: Option<f64>,
    pub text: Option<String>,
    pub font: Option<Buffer>,
    pub size: Option<f64>,
    pub color: Option<JsColour>,
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
        "rotate" => Ok(Operation::Rotate(
            op.degrees.ok_or_else(|| missing("rotate", "degrees"))?,
        )),
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
            opacity: op.opacity.unwrap_or(1.0) as f32,
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
                size: op.size.unwrap_or(32.0) as f32,
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
    }
}

/// Identify an image from its header. Synchronous: it reads a few hundred
/// bytes and never allocates a pixel buffer.
#[napi]
pub fn inspect(bytes: Buffer, limits: Option<JsLimits>) -> Result<JsMetadata> {
    let owned = bytes.to_vec();
    let limits = limits_of(limits);
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
        },
        limits: limits_of(limits),
        auto_orient: auto_orient.unwrap_or(true),
    }))
}
