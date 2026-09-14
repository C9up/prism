/**
 * Loader and boundary for the Rust image engine.
 *
 * The engine is not optional. There is no JavaScript fallback here — a
 * missing binary is a hard failure with an actionable message, never a silent
 * degradation that lets one deployment behave differently from another.
 *
 * This module is also where the API's discriminated union is flattened into
 * the shape napi-rs can carry, and where the engine's `CODE: message` becomes
 * a coded error. Both translations live here so neither leaks outward.
 */

import { fromEngine, PrismNativeRequiredError } from "./errors.js";
import type { JsLimits, JsOperation, JsOutput } from "./native/generated.js";
import type { Limits, Metadata, Operation, OutputOptions } from "./types.js";
import {
	loadNativeBinary,
	unavailableReason as vendorUnavailableReason,
} from "./vendor/nativeBinary.js";

/**
 * The engine's surface, as the Rust declares it.
 *
 * Derived from the generated file — written by `pnpm build:napi-types` from
 * napi-derive's own `type-def` output — rather than restated here, where
 * nothing would notice a `pub fn` changing its signature.
 */
type NativePrism = typeof import("./native/generated.js");

const attempt = loadNativeBinary<NativePrism>();
const native = attempt.loaded ? attempt.binary : undefined;
const loadError = attempt.loaded ? undefined : attempt.cause;

export function isNativeAvailable(): boolean {
	return native !== undefined;
}

function unavailableReason(): string {
	if (loadError !== undefined) {
		return `failed to load (${loadError instanceof Error ? loadError.message : String(loadError)})`;
	}
	return vendorUnavailableReason();
}

function engine(): NativePrism {
	if (native === undefined) {
		throw new PrismNativeRequiredError(unavailableReason());
	}
	return native;
}

function limitsOf(limits: Limits | undefined): JsLimits | undefined {
	if (!limits) return undefined;
	return {
		maxPixels: limits.maxPixels,
		maxBytes: limits.maxBytes,
		allowedFormats: limits.allowedFormats
			? [...limits.allowedFormats]
			: undefined,
	};
}

/**
 * Flatten one operation for the boundary.
 *
 * Exhaustive by construction: the `kind` switch returns from every arm, so a
 * variant added to the union without a case here fails to typecheck rather
 * than silently reaching the engine as an unknown kind.
 */
function flatten(operation: Operation): JsOperation {
	switch (operation.kind) {
		case "resize":
			return {
				kind: "resize",
				width: operation.width,
				height: operation.height,
				fit: operation.fit,
			};
		case "crop":
			return {
				kind: "crop",
				x: operation.x,
				y: operation.y,
				width: operation.width,
				height: operation.height,
			};
		case "rotate":
			return { kind: "rotate", degrees: operation.degrees };
		case "flip":
			return { kind: "flip", axis: operation.axis };
		case "composite":
			return {
				kind: "composite",
				image: operation.image,
				x: operation.x,
				y: operation.y,
				opacity: operation.opacity,
			};
		case "watermarkText":
			return {
				kind: "watermarkText",
				text: operation.text,
				font: operation.font,
				size: operation.size,
				color: operation.color,
				x: operation.x,
				y: operation.y,
			};
		case "thumbnail":
			return {
				kind: "thumbnail",
				width: operation.width,
				height: operation.height,
				exact: operation.exact,
			};
		case "blur":
			return { kind: "blur", sigma: operation.sigma };
		case "fastBlur":
			return { kind: "fastBlur", sigma: operation.sigma };
		case "sharpen":
			return {
				kind: "sharpen",
				sigma: operation.sigma,
				threshold: operation.threshold,
			};
		case "brighten":
			return { kind: "brighten", value: operation.value };
		case "contrast":
			return { kind: "contrast", value: operation.value };
		case "hueRotate":
			return { kind: "hueRotate", value: operation.value };
		case "invert":
			return { kind: "invert" };
		case "grayscale":
			return { kind: "grayscale" };
		case "filter3x3":
			return { kind: "filter3x3", kernel: [...operation.kernel] };
		case "convertColorSpace":
			return {
				kind: "convertColorSpace",
				to: operation.to,
				from: operation.from,
			};
	}
}

/** Read an image's header. Synchronous: it never allocates a pixel buffer. */
export function inspectNative(bytes: Buffer, limits?: Limits): Metadata {
	const loaded = engine();
	try {
		return loaded.inspect(bytes, limitsOf(limits));
	} catch (error) {
		throw fromEngine(error);
	}
}

/**
 * Run a pipeline on a worker thread.
 *
 * One crossing for the whole pipeline, not one per operation: a resize
 * followed by a watermark decodes and encodes once, and the event loop never
 * waits on the resampling.
 */
export async function processNative(
	input: Buffer,
	operations: readonly Operation[],
	output: OutputOptions,
	limits?: Limits,
	autoOrient?: boolean,
): Promise<Buffer> {
	const loaded = engine();
	const spec: JsOutput = {
		format: output.format,
		quality: output.quality,
		background: output.background,
		depth: output.depth,
	};
	try {
		return await loaded.process(
			input,
			operations.map(flatten),
			spec,
			limitsOf(limits),
			autoOrient,
		);
	} catch (error) {
		throw fromEngine(error);
	}
}
