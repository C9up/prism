/**
 * The object an application holds.
 *
 * A pipeline accumulates operations and crosses into Rust exactly once, when
 * it is asked for bytes. That is the whole reason it is a builder rather than
 * six separate calls: chaining a resize and a watermark must not mean
 * decoding and re-encoding the image twice.
 */

import { inspectNative, processNative } from "./native.js";
import type {
	CompositeOptions,
	ConvertColorSpaceOptions,
	CropOptions,
	ImageFormat,
	Limits,
	Metadata,
	Operation,
	OutputOptions,
	PrismConfig,
	ResizeOptions,
	SharpenOptions,
	ThumbnailOptions,
	WatermarkTextOptions,
} from "./types.js";

export class Pipeline {
	readonly #input: Buffer;
	readonly #config: PrismConfig;
	readonly #operations: Operation[] = [];

	constructor(input: Buffer, config: PrismConfig) {
		this.#input = input;
		this.#config = config;
	}

	/** The operations queued so far, in order. */
	operations(): readonly Operation[] {
		return this.#operations;
	}

	resize(options: ResizeOptions): this {
		this.#operations.push({ kind: "resize", ...options });
		return this;
	}

	crop(options: CropOptions): this {
		this.#operations.push({ kind: "crop", ...options });
		return this;
	}

	/** A multiple of 90. Negative and over-360 values are normalised. */
	rotate(degrees: number): this {
		this.#operations.push({ kind: "rotate", degrees });
		return this;
	}

	flip(axis: "horizontal" | "vertical"): this {
		this.#operations.push({ kind: "flip", axis });
		return this;
	}

	composite(options: CompositeOptions): this {
		this.#operations.push({ kind: "composite", ...options });
		return this;
	}

	watermarkText(options: WatermarkTextOptions): this {
		this.#operations.push({ kind: "watermarkText", ...options });
		return this;
	}

	/**
	 * Fast box downscale.
	 *
	 * Not a substitute for {@link resize}: several times cheaper and visibly
	 * softer, which is the right trade for a 32px avatar and the wrong one for
	 * a 1200px hero.
	 */
	thumbnail(options: ThumbnailOptions): this {
		this.#operations.push({ kind: "thumbnail", ...options });
		return this;
	}

	/** Gaussian blur. Accurate and slow — {@link fastBlur} is the cheap one. */
	blur(sigma: number): this {
		this.#operations.push({ kind: "blur", sigma });
		return this;
	}

	/** Box-approximated blur: visually close to Gaussian, far cheaper. */
	fastBlur(sigma: number): this {
		this.#operations.push({ kind: "fastBlur", sigma });
		return this;
	}

	/** Unsharp mask. */
	sharpen(options: SharpenOptions): this {
		this.#operations.push({ kind: "sharpen", ...options });
		return this;
	}

	/** Additive brightness, -255 to 255. */
	brighten(value: number): this {
		this.#operations.push({ kind: "brighten", value });
		return this;
	}

	/** Contrast, -255 to 255. Negative flattens, positive steepens. */
	contrast(value: number): this {
		this.#operations.push({ kind: "contrast", value });
		return this;
	}

	/** Rotate the hue, in degrees. Wraps, so any integer is valid. */
	hueRotate(value: number): this {
		this.#operations.push({ kind: "hueRotate", value });
		return this;
	}

	invert(): this {
		this.#operations.push({ kind: "invert" });
		return this;
	}

	grayscale(): this {
		this.#operations.push({ kind: "grayscale" });
		return this;
	}

	/** A 3x3 convolution, row-major — exactly nine values. */
	filter3x3(kernel: readonly number[]): this {
		this.#operations.push({ kind: "filter3x3", kernel });
		return this;
	}

	/**
	 * Convert into a colour space, transforming the samples rather than
	 * reinterpreting them.
	 *
	 * Pass `from` when the file's own claim is wrong — which is most images
	 * with a real profile, because `image` reads no ICC.
	 */
	convertColorSpace(options: ConvertColorSpaceOptions): this {
		this.#operations.push({ kind: "convertColorSpace", ...options });
		return this;
	}

	/**
	 * Run everything and encode.
	 *
	 * The one call that touches the engine. A pipeline is inert until this.
	 */
	toBuffer(output: OutputOptions): Promise<Buffer> {
		return processNative(
			this.#input,
			this.#operations,
			{
				...output,
				// `??`, not a spread order. `{ quality: config, ...output }`
				// looks like a default and is not: `output` carries
				// `quality: undefined` whenever the caller omitted it, and
				// spreading that OVER the config value silently discarded it.
				// The configured quality never reached the encoder.
				quality: output.quality ?? this.#config.quality,
			},
			this.#config.limits,
			this.#config.autoOrient,
		);
	}

	/** {@link toBuffer} for the common case of naming only the format. */
	toFormat(format: ImageFormat, quality?: number): Promise<Buffer> {
		return this.toBuffer({ format, quality });
	}
}

export class Prism {
	readonly #config: PrismConfig;

	constructor(config: PrismConfig = {}) {
		this.#config = config;
	}

	/** The configuration this was built with. */
	config(): PrismConfig {
		return this.#config;
	}

	/**
	 * Identify an image and describe it, without decoding the pixels.
	 *
	 * Cheap enough to run on every upload before deciding whether to accept
	 * it — and it is where the format is established, from the CONTENT rather
	 * than from a filename or a `Content-Type`, both of which are supplied by
	 * whoever supplied the bytes.
	 */
	inspect(bytes: Buffer, limits?: Limits): Metadata {
		return inspectNative(bytes, limits ?? this.#config.limits);
	}

	/** Start a pipeline over an encoded image. */
	edit(bytes: Buffer): Pipeline {
		return new Pipeline(bytes, this.#config);
	}
}

/**
 * Type-only helper so a config file is checked where it is written.
 *
 * Flat, with no `default` and no `use()`. That is not an oversight: there is
 * one engine, and the multi-driver shape is for a module that genuinely has
 * more than one backend. Vellum took the same shape for the same reason.
 */
export function defineConfig(config: PrismConfig): PrismConfig {
	return config;
}
