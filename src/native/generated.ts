// GENERATED FROM THE RUST — do not edit.
//
// Produced by scripts/generate-napi-types.mjs from napi-derive's type-def
// output. Editing this file by hand puts it back where it started: a
// description that can disagree with the code it describes.

export interface JsLimits {
	/** Largest decoded pixel count allowed. Default 50000000. */
	maxPixels?: number;
	/** Largest input accepted, in bytes. Default 67108864. */
	maxBytes?: number;
}

export interface JsColour {
	r: number;
	g: number;
	b: number;
	/** 0-255. Defaults to fully opaque. */
	a?: number;
}

export interface JsMetadata {
	width: number;
	height: number;
	format: string;
	/** Dimensions after the EXIF orientation is applied. */
	orientedWidth: number;
	orientedHeight: number;
	orientation: number;
	hasAlpha: boolean;
}

/**
 * One pipeline step.
 *
 * NAMED NAPI CONSTRAINT. The engine models this as a Rust enum with a
 * payload per variant, which is the shape the operation actually has.
 * napi-rs cannot carry a tagged union across the boundary, so it is flattened
 * to a discriminator plus optional fields and validated back into the enum in
 * `operation_of`. The TypeScript side declares the real union and builds
 * these, so the flat shape is never what a caller writes.
 */

export interface JsOperation {
	kind: string;
	width?: number;
	height?: number;
	fit?: string;
	x?: number;
	y?: number;
	degrees?: number;
	axis?: string;
	image?: Buffer;
	opacity?: number;
	text?: string;
	font?: Buffer;
	size?: number;
	color?: JsColour;
}

export interface JsOutput {
	/** One of `jpeg`, `png`, `webp`. */
	format: string;
	/** 1-100, for formats that have a quality knob. Default 82. */
	quality?: number;
	/**
	 * What transparency is resolved against for a format with no alpha
	 * channel. Default opaque white.
	 */
	background?: JsColour;
}

/**
 * Identify an image from its header. Synchronous: it reads a few hundred
 * bytes and never allocates a pixel buffer.
 */

export declare function inspect(
	bytes: Buffer,
	limits?: JsLimits | undefined | null,
): JsMetadata;

/**
 * Run a pipeline on a worker thread.
 *
 * The buffers are copied into owned vectors HERE, on the JS thread: a napi
 * `Buffer` borrows memory the JS heap owns and garbage-collects, and holding
 * one across a thread boundary is a use-after-free waiting for the right
 * allocation pattern.
 */

export declare function process(
	input: Buffer,
	operations: Array<JsOperation>,
	output: JsOutput,
	limits?: JsLimits | undefined | null,
	autoOrient?: boolean | undefined | null,
): Promise<Buffer>;
