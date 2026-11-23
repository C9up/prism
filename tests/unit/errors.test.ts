import { Exception } from "@c9up/flare";
import { describe, expect, it } from "vitest";
import { fromEngine } from "../../src/engineErrors.js";
import { errors, PRISM_CODES } from "../../src/index.js";

describe("prism > errors", () => {
	it("the entry exports every error as one `errors` namespace", () => {
		const error = new errors.E_PRISM_INVALID_BINDING(["Prism", "Prism"]);
		expect(error).toBeInstanceOf(Exception);
		expect(error).toBeInstanceOf(errors.E_PRISM_INVALID_BINDING);
		expect(error.code).toBe("E_PRISM_INVALID_BINDING");
		expect(error.status).toBe(500);
		expect(error.message).toBe(
			"[prism] the container returned something that is not a Prism for the Prism token.",
		);
	});

	it("an upload the engine refuses answers 422", () => {
		const error = new errors.E_PRISM_UNKNOWN_FORMAT(["not an image"]);
		expect(error).toBeInstanceOf(Exception);
		expect(error.status).toBe(422);
	});
});

describe("fromEngine", () => {
	it("lifts the engine's code prefix into a code a caller can branch on", () => {
		// The engine cannot throw a JavaScript class across NAPI, so it
		// prefixes the code onto the message. This is the contract that turns
		// it back.
		const error = fromEngine(
			new Error("TOO_MANY_PIXELS: the image declares 9e9"),
		);
		expect(error).toBeInstanceOf(errors.E_PRISM_TOO_MANY_PIXELS);
		expect(error.code).toBe("E_PRISM_TOO_MANY_PIXELS");
		expect(error.message).toBe("the image declares 9e9");
	});

	it("keeps the original as the cause", () => {
		const original = new Error("DECODE_FAILED: broken");
		expect(fromEngine(original).cause).toBe(original);
	});

	it("does not invent a code for a message it does not recognise", () => {
		// Guessing would be worse than admitting there is no code: a caller
		// branching on E_PRISM_DECODE_FAILED must never get it for something
		// that was not a decode failure.
		const error = fromEngine(new Error("SOMETHING_ELSE: unexpected"));
		expect(error.code).toBe("E_PRISM_ENGINE");
		expect(error.message).toBe("SOMETHING_ELSE: unexpected");
	});

	it("handles a message with no code prefix at all", () => {
		expect(fromEngine(new Error("plain failure")).code).toBe("E_PRISM_ENGINE");
	});

	it("handles something thrown that is not an Error", () => {
		const error = fromEngine("a bare string");
		expect(error.code).toBe("E_PRISM_ENGINE");
		expect(error.message).toBe("a bare string");
	});

	it("recognises every code the engine declares", () => {
		for (const code of PRISM_CODES) {
			expect(fromEngine(new Error(`${code}: why`)).code).toBe(
				`E_PRISM_${code}`,
			);
		}
	});
});

describe("E_PRISM_NATIVE_REQUIRED", () => {
	it("says why it is missing and how to get it", () => {
		// A missing binary is the one failure where the message IS the fix.
		const error = new errors.E_PRISM_NATIVE_REQUIRED([
			"no binary for linux-riscv64",
		]);
		expect(error.code).toBe("E_PRISM_NATIVE_REQUIRED");
		expect(error.message).toContain("no binary for linux-riscv64");
		expect(error.message).toContain("pnpm build:napi");
	});
});
