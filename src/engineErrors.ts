/**
 * The engine's failures, back as prism errors.
 *
 * The engine reports a stable code with every failure; this is where it
 * becomes something a controller can branch on. A caller rejecting an upload
 * needs to tell "that is not an image" from "the engine is not installed",
 * and a message is not a contract.
 */

import type { ErrorClass, Exception } from "@c9up/flare";
import * as errors from "./errors.js";

/** Every code the engine can report, without the `E_PRISM_` prefix. */
export const PRISM_CODES = [
	"EMPTY_INPUT",
	"INPUT_TOO_LARGE",
	"TOO_MANY_PIXELS",
	"ZERO_DIMENSION",
	"UNKNOWN_FORMAT",
	"UNSUPPORTED_FORMAT",
	"FORMAT_NOT_ALLOWED",
	"UNREADABLE",
	"DECODE_FAILED",
	"ENCODE_FAILED",
	"INVALID_GEOMETRY",
	"INVALID_FONT",
	"COLOUR_SPACE",
	"INVALID_OPERATION",
	"QR_TOO_LONG",
	"INVALID_QR_OPTION",
	"INTERNAL_PANIC",
] as const;

export type PrismCode = (typeof PRISM_CODES)[number];

/** The error class of each code the engine can report. */
const ENGINE_ERRORS: Record<PrismCode, ErrorClass<[string]>> = {
	EMPTY_INPUT: errors.E_PRISM_EMPTY_INPUT,
	INPUT_TOO_LARGE: errors.E_PRISM_INPUT_TOO_LARGE,
	TOO_MANY_PIXELS: errors.E_PRISM_TOO_MANY_PIXELS,
	ZERO_DIMENSION: errors.E_PRISM_ZERO_DIMENSION,
	UNKNOWN_FORMAT: errors.E_PRISM_UNKNOWN_FORMAT,
	UNSUPPORTED_FORMAT: errors.E_PRISM_UNSUPPORTED_FORMAT,
	FORMAT_NOT_ALLOWED: errors.E_PRISM_FORMAT_NOT_ALLOWED,
	UNREADABLE: errors.E_PRISM_UNREADABLE,
	DECODE_FAILED: errors.E_PRISM_DECODE_FAILED,
	ENCODE_FAILED: errors.E_PRISM_ENCODE_FAILED,
	INVALID_GEOMETRY: errors.E_PRISM_INVALID_GEOMETRY,
	INVALID_FONT: errors.E_PRISM_INVALID_FONT,
	COLOUR_SPACE: errors.E_PRISM_COLOUR_SPACE,
	INVALID_OPERATION: errors.E_PRISM_INVALID_OPERATION,
	QR_TOO_LONG: errors.E_PRISM_QR_TOO_LONG,
	INVALID_QR_OPTION: errors.E_PRISM_INVALID_QR_OPTION,
	INTERNAL_PANIC: errors.E_PRISM_INTERNAL_PANIC,
};

function isKnownCode(value: string): value is PrismCode {
	return PRISM_CODES.some((code) => code === value);
}

/**
 * Split the engine's `CODE: message` into a coded error.
 *
 * The engine cannot throw a JavaScript class across the NAPI boundary, so it
 * prefixes the code onto the message and this puts it back. A message that
 * does not carry a known code is passed through under `E_PRISM_ENGINE` rather
 * than guessed at — inventing a code would be worse than admitting there
 * isn't one.
 */
export function fromEngine(error: unknown): Exception {
	const message = error instanceof Error ? error.message : String(error);
	const separator = message.indexOf(": ");
	if (separator > 0) {
		const code = message.slice(0, separator);
		if (isKnownCode(code)) {
			return new ENGINE_ERRORS[code]([message.slice(separator + 2)], {
				cause: error,
			});
		}
	}
	return new errors.E_PRISM_ENGINE([message], { cause: error });
}
