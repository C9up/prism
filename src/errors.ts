/**
 * Prism errors.
 *
 * The engine reports a stable code with every failure; this is where it
 * becomes something a controller can branch on. A caller rejecting an upload
 * needs to tell "that is not an image" from "the engine is not installed",
 * and a message is not a contract.
 */

export class PrismError extends Error {
	readonly code: string;

	constructor(code: string, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = new.target.name;
		this.code = code;
	}
}

/** Every code the engine can report. */
export const PRISM_CODES = [
	"EMPTY_INPUT",
	"INPUT_TOO_LARGE",
	"TOO_MANY_PIXELS",
	"ZERO_DIMENSION",
	"UNKNOWN_FORMAT",
	"UNSUPPORTED_FORMAT",
	"UNREADABLE",
	"DECODE_FAILED",
	"ENCODE_FAILED",
	"INVALID_GEOMETRY",
	"INVALID_FONT",
	"INVALID_OPERATION",
	"INTERNAL_PANIC",
] as const;

export type PrismCode = (typeof PRISM_CODES)[number];

function isKnownCode(value: string): value is PrismCode {
	return (PRISM_CODES as readonly string[]).includes(value);
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
export function fromEngine(error: unknown): PrismError {
	const message = error instanceof Error ? error.message : String(error);
	const separator = message.indexOf(": ");
	if (separator > 0) {
		const code = message.slice(0, separator);
		if (isKnownCode(code)) {
			return new PrismError(`E_PRISM_${code}`, message.slice(separator + 2), {
				cause: error,
			});
		}
	}
	return new PrismError("E_PRISM_ENGINE", message, { cause: error });
}

/** Raised when an operation needs the Rust engine and it is not there. */
export class PrismNativeRequiredError extends PrismError {
	constructor(reason: string) {
		super(
			"E_PRISM_NATIVE_REQUIRED",
			`The Rust image engine is required but not loaded — ${reason}.\n` +
				"Install the prebuilt binary for this platform, or build it with `pnpm build:napi`.",
		);
	}
}
