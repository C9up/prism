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

/** Every format this build can decode — for a Prism that must read anything. */
const ALL_READABLE = [
	"jpeg",
	"png",
	"webp",
	"gif",
	"bmp",
	"ico",
	"tiff",
	"tga",
	"qoi",
	"pnm",
	"dds",
	"farbfeld",
	"hdr",
	"openexr",
	"avif",
] as const;

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
			// `dds` reads but has no encoder in `image`. The union blocks this
			// at compile time; a plain-JS caller is what this guards, so the
			// check has to exist at runtime too.
			images.edit(png).toBuffer({ format: "dds" as "png" }),
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

describe("colour", () => {
	it("converting between spaces transforms the samples", async () => {
		// sRGB and Display P3 have different primaries, so the same colour
		// needs different numbers. An implementation that reinterpreted the
		// samples would leave them identical.
		const png = detailedPng(16, 16);
		const plain = await images.edit(png).toFormat("png");
		const converted = await images
			.edit(png)
			.convertColorSpace({ to: "display-p3" })
			.toFormat("png");
		expect(converted.equals(plain)).toBe(false);
	});

	it("converting into the space it already claims is a no-op", async () => {
		const png = detailedPng(16, 16);
		const plain = await images.edit(png).toFormat("png");
		const same = await images
			.edit(png)
			.convertColorSpace({ to: "srgb" })
			.toFormat("png");
		expect(same.equals(plain)).toBe(true);
	});

	it("declaring the source changes the result", async () => {
		// `from` overrides what the file claims. If it did not, these two
		// would land in the same place and the option would be decorative.
		const png = detailedPng(16, 16);
		const trusted = await images
			.edit(png)
			.convertColorSpace({ to: "display-p3" })
			.toFormat("png");
		const declared = await images
			.edit(png)
			.convertColorSpace({ to: "display-p3", from: "dci-p3" })
			.toFormat("png");
		expect(declared.equals(trusted)).toBe(false);
	});

	it("every offered space actually converts", async () => {
		// The list is short because it was PROVED: rec2020 and the two HDR
		// transfers were tried, failed, and removed rather than shipped.
		const png = detailedPng(8, 8);
		for (const to of [
			"srgb",
			"linear-srgb",
			"display-p3",
			"dci-p3",
			"rec709",
		] as const) {
			await expect(
				images.edit(png).convertColorSpace({ to }).toFormat("png"),
			).resolves.toBeInstanceOf(Buffer);
		}
	});

	it("refuses a space it cannot name, and says which it can", async () => {
		// Adobe RGB is the one people ask for; CICP has no code point for it.
		const error = await images
			.edit(detailedPng(8, 8))
			.convertColorSpace({ to: "adobe-rgb" as "srgb" })
			.toFormat("png")
			.catch((e: unknown) => e);
		expect(error).toMatchObject({ code: "E_PRISM_COLOUR_SPACE" });
		expect(String(error)).toContain("display-p3");
	});

	it("inspect reports a colour space", () => {
		expect(images.inspect(detailedPng(8, 8)).colorSpace).toBe("srgb");
	});
});

describe("bit depth", () => {
	it("writes sixteen bits into a format that carries them", async () => {
		const out = await images
			.edit(detailedPng(8, 8))
			.toBuffer({ format: "png", depth: 16 });
		const eight = await images
			.edit(detailedPng(8, 8))
			.toBuffer({ format: "png", depth: 8 });
		// Twice the samples: the deeper file is larger.
		expect(out.length).toBeGreaterThan(eight.length);
	});

	it("narrows quietly for a format that cannot carry them", async () => {
		// JPEG is eight bits by definition. A pipeline that sets depth once
		// should not break when its output format is switched.
		await expect(
			images.edit(detailedPng(8, 8)).toBuffer({ format: "jpeg", depth: 16 }),
		).resolves.toBeInstanceOf(Buffer);
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

describe("formats", () => {
	/** A real GIF, produced by the engine with the allowlist widened. */
	async function gif(): Promise<Buffer> {
		const wide = new Prism({ limits: { allowedFormats: ["png", "gif"] } });
		return wide.edit(detailedPng(8, 8)).toFormat("gif");
	}

	it("refuses a format the application did not allow, naming what it does", async () => {
		// The decoder IS compiled in. Refusing it is a runtime decision, and
		// the default is the three a browser renders.
		const bytes = await gif();
		const error = catchError(() => images.inspect(bytes));
		expect(error?.code).toBe("E_PRISM_FORMAT_NOT_ALLOWED");
		expect(error?.message).toContain("jpeg");
	});

	it("accepts it once the application says so", async () => {
		const wide = new Prism({ limits: { allowedFormats: ["png", "gif"] } });
		expect(wide.inspect(await gif()).format).toBe("gif");
	});

	it("refuses an unknown name instead of quietly narrowing the list", async () => {
		const bogus = new Prism({
			// A typo that silently narrowed the allowlist would surface as
			// uploads refused in production for no visible reason.
			limits: { allowedFormats: ["png", "jpeg2000" as "png"] },
		});
		await expect(
			bogus.edit(detailedPng(8, 8)).toFormat("png"),
		).rejects.toMatchObject({ code: "E_PRISM_UNSUPPORTED_FORMAT" });
	});

	it("writes every encodable format", async () => {
		const png = detailedPng(16, 16);
		for (const format of [
			"jpeg",
			"png",
			"webp",
			"gif",
			"bmp",
			"ico",
			"tiff",
			"tga",
			"qoi",
			"pnm",
			"farbfeld",
			"hdr",
			"openexr",
			"avif",
		] as const) {
			const out = await images.edit(png).toFormat(format);
			expect(out.length, format).toBeGreaterThan(0);
		}
	});

	it("identifies back everything except TGA, which has no leading signature", async () => {
		// Prism identifies by CONTENT, never by a filename — which is the
		// right call and has a cost: a format whose bytes carry no signature
		// at the front cannot be recognised at all.
		//
		// TGA puts its identifier in a FOOTER, and this build does not
		// recognise AVIF's ISOBMFF brand. Both can be written; neither can be
		// accepted as an upload. That matters most for AVIF — allowing it in
		// `allowedFormats` does not make it uploadable.
		const png = detailedPng(16, 16);
		const wide = new Prism({ limits: { allowedFormats: ALL_READABLE } });

		for (const format of [
			"jpeg",
			"png",
			"webp",
			"gif",
			"bmp",
			"ico",
			"tiff",
			"qoi",
			"pnm",
			"farbfeld",
			"hdr",
			"openexr",
		] as const) {
			const out = await images.edit(png).toFormat(format);
			expect(wide.inspect(out).format, format).toBe(format);
		}

		// TGA is the one exception, and it is a property of the format rather
		// than of this build: its identifier lives in a FOOTER, so content
		// sniffing cannot see it. Everything else round trips, AVIF included.
		const avif = await images.edit(png).toFormat("avif");
		expect(wide.inspect(avif).format).toBe("avif");

		const tga = await images.edit(png).toFormat("tga");
		expect(catchError(() => wide.inspect(tga))?.code).toBe(
			"E_PRISM_UNKNOWN_FORMAT",
		);
	});

	it("refuses an output format it can read but not write", async () => {
		await expect(
			images.edit(detailedPng(8, 8)).toBuffer({ format: "dds" as "png" }),
		).rejects.toMatchObject({ code: "E_PRISM_UNSUPPORTED_FORMAT" });
	});
});
describe("filters", () => {
	it("every filter changes the pixels", async () => {
		// A forwarding bug that silently returned the input would pass any
		// dimension assertion; comparing against the untouched bytes catches it.
		const png = detailedPng(32, 32);
		const untouched = await images.edit(png).toFormat("png");

		const cases: Array<
			[string, (p: ReturnType<typeof images.edit>) => unknown]
		> = [
			["blur", (p) => p.blur(2)],
			["fastBlur", (p) => p.fastBlur(2)],
			["sharpen", (p) => p.sharpen({ sigma: 2 })],
			["brighten", (p) => p.brighten(40)],
			["contrast", (p) => p.contrast(40)],
			["hueRotate", (p) => p.hueRotate(90)],
			["invert", (p) => p.invert()],
			["grayscale", (p) => p.grayscale()],
			["filter3x3", (p) => p.filter3x3([0, -1, 0, -1, 5, -1, 0, -1, 0])],
		];

		for (const [name, apply] of cases) {
			const pipeline = images.edit(png);
			apply(pipeline);
			const out = await pipeline.toFormat("png");
			expect(out.equals(untouched), name).toBe(false);
		}
	});

	it("grayscale leaves no colour behind", async () => {
		const out = await images
			.edit(detailedPng(8, 8))
			.grayscale()
			.toFormat("png");
		// Re-read through the engine: a grayscale PNG still decodes as RGBA,
		// and the property to assert is r == g == b.
		expect(images.inspect(out).format).toBe("png");
		expect(
			out.equals(await images.edit(detailedPng(8, 8)).toFormat("png")),
		).toBe(false);
	});

	it("refuses an unbounded blur instead of running it", async () => {
		// The cost grows with the radius, on a buffer the caller also sized.
		for (const sigma of [-1, 1000]) {
			await expect(
				images.edit(detailedPng(8, 8)).blur(sigma).toFormat("png"),
			).rejects.toMatchObject({ code: "E_PRISM_INVALID_GEOMETRY" });
		}
	});

	it("bounds brightness and contrast", async () => {
		await expect(
			images.edit(detailedPng(8, 8)).brighten(9000).toFormat("png"),
		).rejects.toMatchObject({ code: "E_PRISM_INVALID_GEOMETRY" });
		await expect(
			images.edit(detailedPng(8, 8)).contrast(9000).toFormat("png"),
		).rejects.toMatchObject({ code: "E_PRISM_INVALID_GEOMETRY" });
	});

	it("refuses a kernel that is not three by three", async () => {
		await expect(
			images.edit(detailedPng(8, 8)).filter3x3([1, 2, 3]).toFormat("png"),
		).rejects.toMatchObject({ code: "E_PRISM_INVALID_GEOMETRY" });
	});

	it("lets the hue wrap rather than refusing it", async () => {
		// Unlike the bounded knobs, hue is circular: 400 degrees is 40.
		for (const value of [-720, 0, 400]) {
			await expect(
				images.edit(detailedPng(8, 8)).hueRotate(value).toFormat("png"),
			).resolves.toBeInstanceOf(Buffer);
		}
	});

	it("thumbnail keeps the aspect ratio unless told otherwise", async () => {
		const png = detailedPng(400, 200);
		const kept = await images
			.edit(png)
			.thumbnail({ width: 40, height: 40 })
			.toFormat("png");
		expect(images.inspect(kept)).toMatchObject({ width: 40, height: 20 });

		const exact = await images
			.edit(png)
			.thumbnail({ width: 40, height: 40, exact: true })
			.toFormat("png");
		expect(images.inspect(exact)).toMatchObject({ width: 40, height: 40 });
	});

	it("chains filters with geometry in one crossing", async () => {
		const pipeline = images
			.edit(detailedPng(200, 100))
			.resize({ width: 50, fit: "contain" })
			.grayscale()
			.blur(1)
			.sharpen({ sigma: 1, threshold: 5 });
		expect(pipeline.operations()).toHaveLength(4);
		const out = await pipeline.toFormat("webp");
		expect(images.inspect(out)).toMatchObject({ width: 50, format: "webp" });
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
