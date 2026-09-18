/**
 * What a caller writes.
 *
 * The operation type here is a real discriminated union: `kind` narrows the
 * fields, so an editor completes `fit` after `resize` and refuses `degrees`.
 * The engine's Rust models it the same way. What sits BETWEEN them is flat —
 * napi-rs cannot carry a tagged union — and that flattening happens in
 * `native.ts`, in one place, rather than leaking into the API.
 */

/**
 * Every format this build can DECODE.
 *
 * All of these decoders are compiled in; which of them an application will
 * accept is a runtime decision — see {@link Limits.allowedFormats}. The
 * default is the three the web runs on.
 */
export type ReadableFormat =
	| "jpeg"
	| "png"
	| "webp"
	| "gif"
	| "bmp"
	| "ico"
	| "tiff"
	| "tga"
	| "qoi"
	| "pnm"
	| "dds"
	| "farbfeld"
	| "hdr"
	| "openexr"
	| "avif";

/**
 * The formats the engine can WRITE.
 *
 * `dds` is readable but not writable — `image` ships no encoder for it — so
 * naming it as an output is refused up front.
 */
export type ImageFormat = Exclude<ReadableFormat, "dds">;

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

export interface ThumbnailOptions {
	width?: number;
	height?: number;
	/** Ignore the aspect ratio, as `fit: "fill"` does. Default `false`. */
	exact?: boolean;
}

export interface SharpenOptions {
	/** Radius. 0-100. */
	sigma: number;
	/**
	 * Contrast step below which nothing is sharpened. Default 0.
	 *
	 * Raising it is what stops an unsharp mask amplifying sensor noise in
	 * flat areas — a clear sky is the usual casualty.
	 */
	threshold?: number;
}

/**
 * The colour spaces this engine can convert between.
 *
 * A curated list, and a short one on purpose. `image` models colour with
 * CICP, not ICC, and refuses any conversion whose colorimetry it cannot
 * interpret — BT.2020 and the HDR transfers among them. Each name here was
 * tried against the library and kept only because it works; a name that can
 * only raise is worse than an absent one.
 *
 * **Adobe RGB is not here and cannot be.** CICP has no code point for it.
 */
export type ColorSpace =
	| "srgb"
	| "linear-srgb"
	| "display-p3"
	| "dci-p3"
	| "rec709";

export interface ConvertColorSpaceOptions {
	to: ColorSpace;
	/**
	 * Overrides what the FILE claims about its own space.
	 *
	 * For the common case of an image whose real profile the decoder never
	 * read — `image` has no ICC reader, so a JPEG carrying an Adobe RGB
	 * profile is decoded as sRGB. Getting this wrong produces a wrong picture
	 * rather than an error, which is why it is opt-in.
	 */
	from?: ColorSpace;
}

export type Operation =
	| ({ kind: "resize" } & ResizeOptions)
	| ({ kind: "crop" } & CropOptions)
	| { kind: "rotate"; degrees: number }
	| { kind: "flip"; axis: "horizontal" | "vertical" }
	| ({ kind: "composite" } & CompositeOptions)
	| ({ kind: "watermarkText" } & WatermarkTextOptions)
	| ({ kind: "thumbnail" } & ThumbnailOptions)
	/** Gaussian blur. Accurate and slow — `fastBlur` is the cheap one. */
	| { kind: "blur"; sigma: number }
	/** Box-approximated blur: visually close to Gaussian, far cheaper. */
	| { kind: "fastBlur"; sigma: number }
	| ({ kind: "sharpen" } & SharpenOptions)
	/** Additive brightness, -255 to 255. */
	| { kind: "brighten"; value: number }
	/** Contrast, -255 to 255. Negative flattens, positive steepens. */
	| { kind: "contrast"; value: number }
	/** Hue rotation in degrees. Wraps, so any integer is valid. */
	| { kind: "hueRotate"; value: number }
	| { kind: "invert" }
	| { kind: "grayscale" }
	/** A 3x3 convolution, row-major — emboss, edge detection, custom sharpening. */
	| { kind: "filter3x3"; kernel: readonly number[] }
	| ({ kind: "convertColorSpace" } & ConvertColorSpaceOptions);

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
	/**
	 * Formats this application will decode. Default `["jpeg", "png", "webp"]`.
	 *
	 * Every decoder is compiled in, so this is a runtime gate rather than a
	 * build one — and widening it is a decision, not a convenience. Each
	 * format added is another parser reachable from whatever an upload form
	 * receives, which is why the default is the three a browser renders.
	 *
	 * An unknown name raises rather than being skipped: a typo that silently
	 * narrowed the list would surface as uploads refused in production for no
	 * visible reason.
	 */
	allowedFormats?: readonly ReadableFormat[];
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
	/**
	 * Bits per channel: 8 (default) or 16.
	 *
	 * Only PNG and TIFF carry 16. Elsewhere the encoder narrows it back
	 * rather than refusing — a pipeline that sets depth once should not break
	 * when its output format is switched.
	 */
	depth?: 8 | 16;
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
	/**
	 * The colour space the file DECLARES — `srgb` for the majority, which
	 * declare nothing.
	 */
	colorSpace: string;
}

export interface ImageServingConfig {
	/** Route path. Defaults to `/__image`. */
	path?: string;
	/**
	 * Absolute directories a `src` may resolve inside.
	 *
	 * The entire access-control story. An empty list serves nothing, which is
	 * the safe thing for a misconfiguration to do.
	 */
	roots: readonly string[];
	/** Widths that may be requested. Defaults to {@link DEFAULT_WIDTHS}. */
	widths?: readonly number[];
	/** Formats that may be requested. Defaults to AVIF, WebP, JPEG and PNG. */
	formats?: readonly ImageFormat[];
	/**
	 * Qualities that may be requested. Defaults to the one below.
	 *
	 * A list rather than a range because quality multiplies the cache the same
	 * way width does, and almost every site uses exactly one value.
	 */
	qualities?: readonly number[];
	/** Quality applied when the request names none. Defaults to 82. */
	quality?: number;
	/**
	 * Where rendered variants are kept.
	 *
	 * Without it every request re-decodes, which is survivable in development
	 * and is not a thing to run in production.
	 */
	cacheDir?: string;
	/** `max-age`, in seconds. Defaults to a year. */
	maxAge?: number;
}

export interface PrismConfig {
	/** Applied to every operation that does not pass its own. */
	limits?: Limits;
	/** Default output quality. */
	quality?: number;
	/**
	 * Mount the transformation endpoint `<Image>` points at.
	 *
	 * Absent by default: a route that reads files off disk and spends CPU on
	 * demand is not something a package should add to an application because
	 * the package happened to be installed.
	 *
	 * See `ImageServingConfig` for what each list guards.
	 */
	serve?: ImageServingConfig;
	/**
	 * Apply the EXIF orientation on decode. Default `true`.
	 *
	 * Turning it off serves the sensor's pixels, which is almost never what
	 * a viewer expects.
	 */
	autoOrient?: boolean;
}
