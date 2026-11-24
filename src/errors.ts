/**
 * Prism errors, one class per code. An application branches on
 * `error.code` or on `error instanceof errors.E_…`; every one is a flare
 * `Exception`, with the HTTP status an exception handler answers with.
 *
 * The engine refusals that mean "this input is not an image prism will take"
 * answer 422, as the image endpoint does for them: the request was readable,
 * the upload was not. The rest are faults of the application or the host.
 */

import { createError } from "@c9up/flare";

/** The input is empty. */
export const E_PRISM_EMPTY_INPUT = createError<[string]>(
	"%s",
	"E_PRISM_EMPTY_INPUT",
	422,
);

/** The input is over `maxBytes`. */
export const E_PRISM_INPUT_TOO_LARGE = createError<[string]>(
	"%s",
	"E_PRISM_INPUT_TOO_LARGE",
	422,
);

/** The image, or one an operation would build, is over `maxPixels`. */
export const E_PRISM_TOO_MANY_PIXELS = createError<[string]>(
	"%s",
	"E_PRISM_TOO_MANY_PIXELS",
	422,
);

/**
 * A step of the pipeline would hold more than `maxMemory` bytes — the
 * decoded image, a resize's intermediate, an encoder's copy.
 */
export const E_PRISM_MEMORY_LIMIT = createError<[string]>(
	"%s",
	"E_PRISM_MEMORY_LIMIT",
	422,
);

/** The image has a zero width or height. */
export const E_PRISM_ZERO_DIMENSION = createError<[string]>(
	"%s",
	"E_PRISM_ZERO_DIMENSION",
	422,
);

/** The bytes are not an image format prism recognises. */
export const E_PRISM_UNKNOWN_FORMAT = createError<[string]>(
	"%s",
	"E_PRISM_UNKNOWN_FORMAT",
	422,
);

/** The format is recognised but not supported. */
export const E_PRISM_UNSUPPORTED_FORMAT = createError<[string]>(
	"%s",
	"E_PRISM_UNSUPPORTED_FORMAT",
	422,
);

/** The format is not in `allowedFormats`. */
export const E_PRISM_FORMAT_NOT_ALLOWED = createError<[string]>(
	"%s",
	"E_PRISM_FORMAT_NOT_ALLOWED",
	422,
);

/** The image cannot be read. */
export const E_PRISM_UNREADABLE = createError<[string]>(
	"%s",
	"E_PRISM_UNREADABLE",
	422,
);

/** Decoding failed. */
export const E_PRISM_DECODE_FAILED = createError<[string]>(
	"%s",
	"E_PRISM_DECODE_FAILED",
	422,
);

/** Encoding the output failed. */
export const E_PRISM_ENCODE_FAILED = createError<[string]>(
	"%s",
	"E_PRISM_ENCODE_FAILED",
);

/** A crop outside the image, a target size of zero. */
export const E_PRISM_INVALID_GEOMETRY = createError<[string]>(
	"%s",
	"E_PRISM_INVALID_GEOMETRY",
);

/** A font cannot be used. */
export const E_PRISM_INVALID_FONT = createError<[string]>(
	"%s",
	"E_PRISM_INVALID_FONT",
);

/** A colour space cannot be named, or a conversion is refused. */
export const E_PRISM_COLOUR_SPACE = createError<[string]>(
	"%s",
	"E_PRISM_COLOUR_SPACE",
);

/** An operation lacks a field or has one out of range. */
export const E_PRISM_INVALID_OPERATION = createError<[string]>(
	"%s",
	"E_PRISM_INVALID_OPERATION",
);

/** More text than a QR code can hold at the chosen level and version. */
export const E_PRISM_QR_TOO_LONG = createError<[string]>(
	"%s",
	"E_PRISM_QR_TOO_LONG",
);

/** A QR code option is out of range, or a colour is not strict hex. */
export const E_PRISM_INVALID_QR_OPTION = createError<[string]>(
	"%s",
	"E_PRISM_INVALID_QR_OPTION",
);

/** The engine panicked. */
export const E_PRISM_INTERNAL_PANIC = createError<[string]>(
	"%s",
	"E_PRISM_INTERNAL_PANIC",
);

/** The engine failed without a code prism knows. */
export const E_PRISM_ENGINE = createError<[string]>("%s", "E_PRISM_ENGINE");

/**
 * An operation needs the Rust engine and it is not loaded. The message names
 * the platform package to install; the load error is its `cause`.
 */
export const E_PRISM_NATIVE_REQUIRED = createError<[fix: string]>(
	"The Rust image engine is required but not loaded.\n  Fix: %s",
	"E_PRISM_NATIVE_REQUIRED",
);

/** The `services/main` engine was used before it was set. */
export const E_PRISM_NOT_BOOTED = createError(
	"[prism] Prism singleton accessed before PrismProvider.boot() ran " +
		"or `setPrism(myPrism)` was called. Wire one of them first.",
	"E_PRISM_NOT_BOOTED",
);

/** `config/images.ts` does not export a `defineConfig({ ... })` config. */
export const E_PRISM_INVALID_CONFIG = createError(
	"[prism] config/images.ts must export defineConfig({ ... }).",
	"E_PRISM_INVALID_CONFIG",
);

/** `images.serve` declares no roots, or one of its counts is out of range. */
export const E_PRISM_INVALID_SERVE_CONFIG = createError<[string]>(
	"[prism] %s",
	"E_PRISM_INVALID_SERVE_CONFIG",
);

/** The container resolved something of the wrong kind for a token. */
export const E_PRISM_INVALID_BINDING = createError<[string, string]>(
	"[prism] the container returned something that is not a %s for the %s token.",
	"E_PRISM_INVALID_BINDING",
);
