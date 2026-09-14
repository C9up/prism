import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { PrismError } from "../../src/errors.js";
import { isNativeAvailable, Prism } from "../../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const font = readFileSync(join(here, "../fixtures/VellumTestSans.ttf"));

const images = new Prism();

/** A solid image, produced by the engine itself so nothing is checked in. */
async function fixture(
	width: number,
	height: number,
	format: "png" | "jpeg" = "png",
): Promise<Buffer> {
	// A 1x1 PNG, upscaled. Built rather than pasted: a base64 blob edited by
	// hand is a CRC error waiting to be debugged as an engine bug.
	const seed = solidPng(64, 96, 192);
	return images
		.edit(seed)
		.resize({ width, height, fit: "fill" })
		.toFormat(format);
}

describe("engine", () => {
	it("is available — the tests below are worthless without it", () => {
		expect(isNativeAvailable()).toBe(true);
	});
});

describe("inspect", () => {
	it("reads the format from the CONTENT, not from a name", async () => {
		// Both a filename and a Content-Type come from whoever sent the bytes.
		const png = await fixture(20, 10);
		expect(images.inspect(png)).toMatchObject({
			format: "png",
			width: 20,
			height: 10,
			orientation: 1,
		});
	});

	it("reports oriented dimensions alongside the raw ones", async () => {
		const png = await fixture(20, 10);
		const meta = images.inspect(png);
		// No EXIF here, so they agree — the point is that both are reported,
		// because a phone photo is where they disagree.
		expect([meta.orientedWidth, meta.orientedHeight]).toEqual([20, 10]);
	});

	it("refuses bytes that are not an image", () => {
		const error = catchError(() => images.inspect(Buffer.from("<svg/>")));
		expect(error).toBeInstanceOf(PrismError);
		expect(error?.code).toBe("E_PRISM_UNKNOWN_FORMAT");
	});

	it("refuses an empty input under its own code", () => {
		expect(catchError(() => images.inspect(Buffer.alloc(0)))?.code).toBe(
			"E_PRISM_EMPTY_INPUT",
		);
	});
});

describe("guards", () => {
	it("refuses a header declaring more pixels than the limit", async () => {
		const png = await fixture(64, 64);
		const tight = new Prism({ limits: { maxPixels: 100 } });
		expect(catchError(() => tight.inspect(png))?.code).toBe(
			"E_PRISM_TOO_MANY_PIXELS",
		);
	});

	it("refuses an input over the byte limit", async () => {
		const png = await fixture(64, 64);
		const tight = new Prism({ limits: { maxBytes: 10 } });
		expect(catchError(() => tight.inspect(png))?.code).toBe(
			"E_PRISM_INPUT_TOO_LARGE",
		);
	});

	it("applies the limits to a pipeline too, not only to inspect", async () => {
		const png = await fixture(64, 64);
		const tight = new Prism({ limits: { maxPixels: 100 } });
		await expect(
			tight.edit(png).resize({ width: 8 }).toFormat("png"),
		).rejects.toMatchObject({ code: "E_PRISM_TOO_MANY_PIXELS" });
	});
});

describe("pipeline", () => {
	it("resizes, keeping the aspect ratio when one side is given", async () => {
		const png = await fixture(1000, 500);
		const out = await images
			.edit(png)
			.resize({ width: 300, fit: "contain" })
			.toFormat("png");
		expect(images.inspect(out)).toMatchObject({ width: 300, height: 150 });
	});

	it("cover fills the box exactly; contain does not", async () => {
		const png = await fixture(1000, 500);
		const cover = await images
			.edit(png)
			.resize({ width: 200, height: 200, fit: "cover" })
			.toFormat("png");
		expect(images.inspect(cover)).toMatchObject({ width: 200, height: 200 });

		const contain = await images
			.edit(png)
			.resize({ width: 200, height: 200, fit: "contain" })
			.toFormat("png");
		expect(images.inspect(contain)).toMatchObject({ width: 200, height: 100 });
	});

	it("refuses a crop that falls outside the image instead of clamping it", async () => {
		const png = await fixture(100, 100);
		await expect(
			images
				.edit(png)
				.crop({ x: 80, y: 80, width: 50, height: 50 })
				.toFormat("png"),
		).rejects.toMatchObject({ code: "E_PRISM_INVALID_GEOMETRY" });
	});

	it("rotates by right angles and normalises the value", async () => {
		const png = await fixture(100, 50);
		for (const degrees of [90, 450, -270]) {
			const out = await images.edit(png).rotate(degrees).toFormat("png");
			expect(images.inspect(out)).toMatchObject({ width: 50, height: 100 });
		}
	});

	it("refuses a rotation that is not a right angle", async () => {
		const png = await fixture(10, 10);
		await expect(
			images.edit(png).rotate(45).toFormat("png"),
		).rejects.toMatchObject({
			code: "E_PRISM_INVALID_GEOMETRY",
		});
	});

	it("queues operations and crosses into Rust once", async () => {
		const png = await fixture(400, 400);
		const pipeline = images
			.edit(png)
			.resize({ width: 200, height: 200, fit: "fill" })
			.rotate(90)
			.flip("horizontal");
		// Inert until asked for bytes: three operations, no work yet.
		expect(pipeline.operations()).toHaveLength(3);
		const out = await pipeline.toFormat("png");
		expect(images.inspect(out)).toMatchObject({ width: 200, height: 200 });
	});

	it("writes every supported output format", async () => {
		const png = await fixture(20, 20);
		for (const format of ["jpeg", "png", "webp"] as const) {
			const out = await images.edit(png).toFormat(format);
			expect(images.inspect(out).format).toBe(format);
		}
	});

	it("refuses an output format it does not write", async () => {
		const png = await fixture(20, 20);
		await expect(
			// The union blocks this at compile time; a plain-JS caller is what
			// this guards, so the check has to exist at runtime too.
			images.edit(png).toBuffer({ format: "avif" as "png" }),
		).rejects.toMatchObject({ code: "E_PRISM_UNSUPPORTED_FORMAT" });
	});
});

describe("composition", () => {
	it("overlays another image", async () => {
		const base = await fixture(100, 100);
		const overlay = await fixture(20, 20);
		const out = await images
			.edit(base)
			.composite({ image: overlay, x: 10, y: 10, opacity: 0.5 })
			.toFormat("png");
		expect(images.inspect(out)).toMatchObject({ width: 100, height: 100 });
	});

	it("guards the overlay exactly like the input", async () => {
		// The limit sits BETWEEN the two: the base passes, the overlay does
		// not. A limit both pass would prove nothing about the overlay.
		const base = await fixture(100, 100); // 10 000 pixels
		const overlay = await fixture(200, 200); // 40 000 pixels
		const tight = new Prism({ limits: { maxPixels: 20_000 } });
		await expect(
			tight.edit(base).composite({ image: overlay }).toFormat("png"),
		).rejects.toMatchObject({ code: "E_PRISM_TOO_MANY_PIXELS" });
	});

	it("draws a text watermark from a caller-supplied font", async () => {
		const base = await fixture(300, 120);
		const out = await images
			.edit(base)
			.watermarkText({ text: "ACME", font, size: 32, x: 10, y: 10 })
			.toFormat("png");
		expect(images.inspect(out)).toMatchObject({ width: 300, height: 120 });
		// The watermark changed the pixels — an overlay that silently drew
		// nothing would otherwise pass every dimension assertion.
		expect(out.equals(base)).toBe(false);
	});

	it("refuses bytes that are not a font", async () => {
		const base = await fixture(50, 50);
		await expect(
			images
				.edit(base)
				.watermarkText({ text: "x", font: Buffer.from("not a font") })
				.toFormat("png"),
		).rejects.toMatchObject({ code: "E_PRISM_INVALID_FONT" });
	});

	it("refuses multi-line watermark text rather than dropping the newline", async () => {
		const base = await fixture(50, 50);
		await expect(
			images.edit(base).watermarkText({ text: "a\nb", font }).toFormat("png"),
		).rejects.toMatchObject({ code: "E_PRISM_INVALID_GEOMETRY" });
	});
});

describe("alpha", () => {
	it("resolves transparency against a background instead of dropping it", async () => {
		// Dropping the alpha channel keeps the colour underneath, so a
		// transparent red pixel would be written as opaque red.
		const transparent = solidPng(255, 0, 0, 0);
		const onWhite = await images.edit(transparent).toBuffer({ format: "jpeg" });
		const onBlack = await images.edit(transparent).toBuffer({
			format: "jpeg",
			background: { r: 0, g: 0, b: 0 },
		});
		// Same pixels, different backgrounds — so the background is doing work.
		expect(onWhite.equals(onBlack)).toBe(false);
	});

	it("keeps the alpha channel for a format that has one", async () => {
		const png = await fixture(10, 10);
		expect(
			images.inspect(await images.edit(png).toFormat("png")).hasAlpha,
		).toBe(true);
		expect(
			images.inspect(await images.edit(png).toFormat("jpeg")).hasAlpha,
		).toBe(false);
	});
});

describe("defaults", () => {
	it("resizes from the height alone, deriving the width", async () => {
		const png = await fixture(1000, 500);
		const out = await images
			.edit(png)
			.resize({ height: 100, fit: "contain" })
			.toFormat("png");
		expect(images.inspect(out)).toMatchObject({ width: 200, height: 100 });
	});

	it("composites at the origin, fully opaque, when nothing is said", async () => {
		const base = await fixture(60, 60);
		// A DIFFERENT colour: an overlay identical to the base changes
		// nothing, and the assertion below would pass for a composite that
		// never ran.
		const overlay = await images
			.edit(solidPng(255, 0, 0))
			.resize({ width: 20, height: 20, fit: "fill" })
			.toFormat("png");
		const out = await images
			.edit(base)
			.composite({ image: overlay })
			.toFormat("png");
		expect(images.inspect(out)).toMatchObject({ width: 60, height: 60 });
		expect(out.equals(base)).toBe(false);
	});

	it("watermarks with a default size, colour and position", async () => {
		const base = await fixture(200, 80);
		const out = await images
			.edit(base)
			.watermarkText({ text: "ACME", font })
			.toFormat("png");
		expect(out.equals(base)).toBe(false);
	});

	it("uses the configured quality when a call does not name one", async () => {
		// Detailed, not flat: a solid image encodes to the same size at every
		// quality, so a flat fixture would make this assertion meaningless.
		const png = detailedPng(80, 80);
		const low = new Prism({ quality: 10 });
		const high = new Prism({ quality: 95 });
		const small = await low.edit(png).toFormat("jpeg");
		const large = await high.edit(png).toFormat("jpeg");
		// The knob is connected: a lower quality writes fewer bytes.
		expect(small.length).toBeLessThan(large.length);
	});

	it("lets a call override the configured quality", async () => {
		const png = detailedPng(80, 80);
		const engine = new Prism({ quality: 10 });
		const overridden = await engine
			.edit(png)
			.toBuffer({ format: "jpeg", quality: 95 });
		const configured = await engine.edit(png).toFormat("jpeg");
		expect(overridden.length).toBeGreaterThan(configured.length);
	});
});

/**
 * A valid RGBA PNG, built here rather than pasted.
 *
 * A base64 blob edited by hand is a CRC error waiting to be debugged as an
 * engine bug, and a fixture that is one flat colour silently invalidates any
 * test about compression: a solid image encodes to the same size at every
 * JPEG quality, because every DCT coefficient but the first is zero.
 */
function makePng(
	width: number,
	height: number,
	pixel: (x: number, y: number) => [number, number, number, number],
): Buffer {
	const chunk = (kind: string, payload: Buffer): Buffer => {
		const body = Buffer.concat([Buffer.from(kind, "ascii"), payload]);
		const length = Buffer.alloc(4);
		length.writeUInt32BE(payload.length);
		const checksum = Buffer.alloc(4);
		checksum.writeUInt32BE(crc32(body) >>> 0);
		return Buffer.concat([length, body, checksum]);
	};

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 6; // colour type: RGBA

	// Each scanline is preceded by its filter byte, which is not a pixel.
	const raw = Buffer.alloc(height * (1 + width * 4));
	let offset = 0;
	for (let y = 0; y < height; y++) {
		raw[offset++] = 0;
		for (let x = 0; x < width; x++) {
			const [r, g, b, a] = pixel(x, y);
			raw[offset++] = r;
			raw[offset++] = g;
			raw[offset++] = b;
			raw[offset++] = a;
		}
	}

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/** One flat colour. */
function solidPng(r: number, g: number, b: number, a = 255): Buffer {
	return makePng(1, 1, () => [r, g, b, a]);
}

/**
 * Detail in every pixel, so compression has something to throw away.
 *
 * Deterministic, so a size comparison between two qualities is reproducible
 * rather than flaky.
 */
function detailedPng(width: number, height: number): Buffer {
	return makePng(width, height, (x, y) => {
		const noise = (x * 2654435761 + y * 40503) % 256;
		return [noise, (noise * 7) % 256, (x * y) % 256, 255];
	});
}

/** Capture a synchronous throw as a `PrismError`, or `undefined`. */
function catchError(work: () => unknown): PrismError | undefined {
	try {
		work();
		return undefined;
	} catch (error) {
		return error instanceof PrismError ? error : undefined;
	}
}
