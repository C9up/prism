/**
 * What a caller writes.
 *
 * The operation type here is a real discriminated union: `kind` narrows the
 * fields, so an editor completes `fit` after `resize` and refuses `degrees`.
 * The engine's Rust models it the same way. What sits BETWEEN them is flat —
 * napi-rs cannot carry a tagged union — and that flattening happens in
 * `native.ts`, in one place, rather than leaking into the API.
 */

/** The formats the engine will read and write. */
export type ImageFormat = "jpeg" | "png" | "webp";

/** How a resize reconciles the requested box with the aspect ratio. */
export type Fit =
	/** Exactly the requested size. Distorts. */
	| "fill"
	/** Largest size fitting inside the box. Never distorts, may be smaller. */
	| "contain"
	/** Fills the box and crops the overflow, centred. Never distorts. */
	| "cover"
	/** Like `contain`, but never enlarges a smaller image. */
	| "inside";

export interface Colour {
	r: number;
	g: number;
	b: number;
	/** 0-255. Opaque when omitted. */
	a?: number;
}

export interface ResizeOptions {
	width?: number;
	height?: number;
	/** Default `"cover"`. */
	fit?: Fit;
}

export interface CropOptions {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface CompositeOptions {
	/** The overlay, encoded. It goes through the same guards as the input. */
	image: Buffer;
	/** Signed, so an overlay may hang off the edge. Default 0. */
	x?: number;
	y?: number;
	/** 0-1. Default 1. */
	opacity?: number;
}

export interface WatermarkTextOptions {
	text: string;
	/**
	 * The font, as bytes. No font is bundled: shipping one would bind every
	 * consumer to its licence and add megabytes for the majority who never
	 * draw text.
	 */
	font: Buffer;
	/** Pixels. Default 32. */
	size?: number;
	/** Default opaque white. */
	color?: Colour;
	x?: number;
	y?: number;
}

export type Operation =
	| ({ kind: "resize" } & ResizeOptions)
	| ({ kind: "crop" } & CropOptions)
	| { kind: "rotate"; degrees: number }
	| { kind: "flip"; axis: "horizontal" | "vertical" }
	| ({ kind: "composite" } & CompositeOptions)
	| ({ kind: "watermarkText" } & WatermarkTextOptions);

/** Ceilings applied before anything is decoded. */
export interface Limits {
	/**
	 * Largest decoded pixel count. Default 50000000.
	 *
	 * The decompression-bomb bound. A 40 KB PNG can declare 50000x50000, and
	 * decoding it asks for ten gigabytes before anything objects.
	 */
	maxPixels?: number;
	/** Largest input accepted, in bytes. Default 67108864 (64 MiB). */
	maxBytes?: number;
}

export interface OutputOptions {
	format: ImageFormat;
	/** 1-100, for formats with a quality knob. Default 82. */
	quality?: number;
	/**
	 * What transparency is resolved against for a format with no alpha
	 * channel. Default opaque white.
	 *
	 * It matters: dropping the alpha channel instead of blending keeps
	 * whatever colour sat underneath, so a transparent red pixel would be
	 * written as opaque red.
	 */
	background?: Colour;
}

/** What an image is, read from its header. */
export interface Metadata {
	width: number;
	height: number;
	format: ImageFormat | string;
	/**
	 * Dimensions as they appear AFTER the EXIF orientation is applied.
	 *
	 * A portrait phone photo reports landscape dimensions in its header plus
	 * a tag saying to rotate it. Laying out a gallery from the header alone
	 * gets every phone photo's aspect ratio wrong.
	 */
	orientedWidth: number;
	orientedHeight: number;
	/** EXIF orientation, 1-8. `1` when there is none. */
	orientation: number;
	hasAlpha: boolean;
}

export interface PrismConfig {
	/** Applied to every operation that does not pass its own. */
	limits?: Limits;
	/** Default output quality. */
	quality?: number;
	/**
	 * Apply the EXIF orientation on decode. Default `true`.
	 *
	 * Turning it off serves the sensor's pixels, which is almost never what
	 * a viewer expects.
	 */
	autoOrient?: boolean;
}
