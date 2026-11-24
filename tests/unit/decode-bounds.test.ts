/**
 * What a file can make the engine allocate before it is refused.
 *
 * Every attack here is built SMALL: a header that lies, a chunk that expands,
 * an index that repeats. The proof is either the engine's refusal code coming
 * back from `inspect` — which decodes nothing — or, on Linux, the peak
 * resident memory of this process staying flat while the file claims tens of
 * megabytes.
 */

import { readFileSync, writeFileSync } from "node:fs";
import {
	constants,
	crc32,
	deflateRawSync,
	deflateSync,
	inflateSync,
} from "node:zlib";
import { describe, expect, it } from "vitest";
import { Gate } from "../../src/gate.js";
import { qrImageNative } from "../../src/native.js";
import { Pipeline, Prism } from "../../src/Prism.js";
import type { ReadableFormat } from "../../src/types.js";
import { detailedPng, makePng } from "../helpers/png.js";

const MiB = 1024 * 1024;

function chunk(kind: string, data: Buffer): Buffer {
	const head = Buffer.alloc(8);
	head.writeUInt32BE(data.length, 0);
	head.write(kind, 4, "latin1");
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0);
	return Buffer.concat([head, data, crc]);
}

const PNG_SIGNATURE = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function ihdr(
	width: number,
	height: number,
	depth = 8,
	colourType = 0,
): Buffer {
	const data = Buffer.alloc(13);
	data.writeUInt32BE(width, 0);
	data.writeUInt32BE(height, 4);
	data[8] = depth;
	data[9] = colourType;
	return chunk("IHDR", data);
}

/**
 * A zlib stream of `size` zero bytes, built a mebibyte at a time so the test
 * never holds what the stream expands to.
 */
function zeros(size: number): Buffer {
	const block = deflateRawSync(Buffer.alloc(MiB), {
		finishFlush: constants.Z_SYNC_FLUSH,
	});
	const adler = Buffer.alloc(4);
	// Adler-32 of n zero bytes: a stays 1, b adds it n times.
	adler.writeUInt32BE(((size % 65521) * 65536 + 1) >>> 0, 0);
	return Buffer.concat([
		Buffer.from([0x78, 0x9c]),
		...Array.from({ length: size / MiB }, () => block),
		// A final, empty, fixed-Huffman block.
		Buffer.from([0x03, 0x00]),
		adler,
	]);
}

/** A 1x1 grayscale PNG whose ICC profile inflates to `size` bytes. */
function pngWithIccp(size: number): Buffer {
	return Buffer.concat([
		PNG_SIGNATURE,
		ihdr(1, 1),
		chunk("iCCP", Buffer.concat([Buffer.from("x\0\0", "latin1"), zeros(size)])),
		chunk("IDAT", deflateSync(Buffer.from([0, 0]))),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/** The growth of this process's peak resident memory across `work`, in bytes. */
async function peakGrowth(work: () => Promise<unknown>): Promise<number> {
	const field = (name: string): number => {
		const status = readFileSync("/proc/self/status", "utf8");
		return (
			Number(new RegExp(`${name}:\\s+(\\d+) kB`).exec(status)?.[1] ?? 0) * 1024
		);
	};
	writeFileSync("/proc/self/clear_refs", "5");
	const before = field("VmRSS");
	await work();
	return field("VmHWM") - before;
}

describe("a PNG's ICC profile", () => {
	const bomb = pngWithIccp(48 * MiB);

	it("is a real deflate stream of what it claims", () => {
		expect(inflateSync(zeros(2 * MiB)).length).toBe(2 * MiB);
		expect(bomb.length).toBeLessThan(64 * 1024);
	});

	it("does not stop a 1x1 image from being read and written", async () => {
		const images = new Prism({ limits: { maxPixels: 1 } });
		expect(images.inspect(bomb)).toMatchObject({
			format: "png",
			width: 1,
			height: 1,
		});
		const out = await images.edit(bomb).toBuffer({ format: "png" });
		expect(images.inspect(out)).toMatchObject({ width: 1, height: 1 });
	});

	if (process.platform === "linux") {
		it("is not inflated by inspect or by a pipeline", async () => {
			const images = new Prism({ limits: { maxPixels: 1 } });
			images.inspect(pngWithIccp(0));
			const inspected = await peakGrowth(async () => images.inspect(bomb));
			const edited = await peakGrowth(() =>
				images.edit(bomb).toBuffer({ format: "png" }),
			);
			// 48 MiB before; now what `png` may spend on metadata: 4 MiB plus
			// copies of the chunks, a few times this 50 KB file.
			expect(inspected).toBeLessThan(8 * MiB);
			expect(edited).toBeLessThan(8 * MiB);
		});
	}
});

/** A GIF with a 1x1 screen and one `width` x `height` frame, holding no data. */
function gifWithFrame(width: number, height: number): Buffer {
	const descriptor = Buffer.alloc(10);
	descriptor[0] = 0x2c;
	descriptor.writeUInt16LE(width, 5);
	descriptor.writeUInt16LE(height, 7);
	return Buffer.concat([
		Buffer.from("GIF89a", "latin1"),
		Buffer.from([1, 0, 1, 0, 0, 0, 0]),
		descriptor,
		// LZW minimum code size 2, then a clear code and an end code.
		Buffer.from([2, 1, 0x2c, 0, 0x3b]),
	]);
}

function riff(...chunks: Buffer[]): Buffer {
	const body = Buffer.concat(chunks);
	const head = Buffer.alloc(12);
	head.write("RIFF", 0, "latin1");
	head.writeUInt32LE(4 + body.length, 4);
	head.write("WEBP", 8, "latin1");
	return Buffer.concat([head, body]);
}

function webpChunk(kind: string, data: Buffer): Buffer {
	const head = Buffer.alloc(8);
	head.write(kind, 0, "latin1");
	head.writeUInt32LE(data.length, 4);
	return Buffer.concat([head, data, Buffer.alloc(data.length % 2)]);
}

/** A VP8X header declaring a `width` x `height` canvas. */
function vp8x(width: number, height: number, flags = 0): Buffer {
	const data = Buffer.alloc(10);
	data[0] = flags;
	data.writeUIntLE(width - 1, 4, 3);
	data.writeUIntLE(height - 1, 7, 3);
	return webpChunk("VP8X", data);
}

/** A key-frame header stating `width` x `height`, and some bytes of nothing. */
function vp8(width: number, height: number): Buffer {
	const data = Buffer.alloc(64);
	Buffer.from([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a]).copy(data);
	data.writeUInt16LE(width, 6);
	data.writeUInt16LE(height, 8);
	return webpChunk("VP8 ", data);
}

function vp8l(width: number, height: number): Buffer {
	const data = Buffer.alloc(64);
	data[0] = 0x2f;
	data.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 1);
	return webpChunk("VP8L", data);
}

const WIDER: ReadableFormat[] = ["jpeg", "png", "webp", "gif"];

describe("a frame larger than the canvas it is declared in", () => {
	it("refuses a GIF whose frame is over the pixel ceiling, from its descriptor", async () => {
		const images = new Prism({
			limits: { allowedFormats: WIDER, maxPixels: 100 },
		});
		const file = gifWithFrame(3000, 3000);
		expect(() => images.inspect(file)).toThrow(
			expect.objectContaining({ code: "E_PRISM_TOO_MANY_PIXELS" }),
		);
		await expect(
			images.edit(file).toBuffer({ format: "png" }),
		).rejects.toMatchObject({
			code: "E_PRISM_TOO_MANY_PIXELS",
		});
	});

	it("reads a GIF whose frame differs from its screen but fits the ceiling", async () => {
		const writer = new Prism({ limits: { allowedFormats: WIDER } });
		const gif = await writer
			.edit(detailedPng(8, 8))
			.toBuffer({ format: "gif" });
		gif.writeUInt16LE(1, 6);
		gif.writeUInt16LE(1, 8);
		const fits = new Prism({
			limits: { allowedFormats: WIDER, maxPixels: 64 },
		});
		expect(fits.inspect(gif)).toMatchObject({ width: 1, height: 1 });
		const out = await fits.edit(gif).toBuffer({ format: "png" });
		expect(fits.inspect(out)).toMatchObject({ width: 1, height: 1 });
		const tighter = new Prism({
			limits: { allowedFormats: WIDER, maxPixels: 63 },
		});
		expect(() => tighter.inspect(gif)).toThrow(
			expect.objectContaining({ code: "E_PRISM_TOO_MANY_PIXELS" }),
		);
	});

	it("refuses a WebP canvas whose VP8 or VP8L bitstream states another size — with the default formats", async () => {
		const images = new Prism();
		for (const bitstream of [vp8(4000, 4000), vp8l(4000, 4000)]) {
			const file = riff(vp8x(1, 1), bitstream);
			expect(() => images.inspect(file)).toThrow(
				expect.objectContaining({ code: "E_PRISM_UNREADABLE" }),
			);
			await expect(
				images.edit(file).toBuffer({ format: "png" }),
			).rejects.toMatchObject({
				code: "E_PRISM_UNREADABLE",
			});
		}
	});

	it("refuses an animation frame whose bitstream is larger than its rectangle", () => {
		const header = Buffer.alloc(16);
		header.writeUIntLE(1, 6, 3); // width - 1: a 2x2 frame
		header.writeUIntLE(1, 9, 3);
		const frame = webpChunk(
			"ANMF",
			Buffer.concat([
				header,
				webpChunk("ALPH", Buffer.alloc(3)),
				vp8(4000, 4000),
			]),
		);
		const anim = webpChunk("ANIM", Buffer.alloc(6));
		const file = riff(vp8x(4, 4, 0x02), anim, frame);
		expect(() => new Prism().inspect(file)).toThrow(
			expect.objectContaining({ code: "E_PRISM_UNREADABLE" }),
		);
	});

	it("still reads an extended WebP the encoder wrote", async () => {
		// Transparency makes libwebp write VP8X + ALPH + VP8.
		const images = new Prism();
		const webp = await images
			.edit(makePng(24, 16, (x) => [200, 10, 10, x * 10]))
			.toBuffer({ format: "webp", quality: 80 });
		expect(webp.toString("latin1", 12, 16)).toBe("VP8X");
		expect(images.inspect(webp)).toMatchObject({ width: 24, height: 16 });
		const out = await images.edit(webp).toBuffer({ format: "png" });
		expect(images.inspect(out)).toMatchObject({ width: 24, height: 16 });
	});

	it("refuses an APNG frame outside its image, as the PNG decoder already did", () => {
		const actl = Buffer.alloc(8);
		actl.writeUInt32BE(1, 0);
		const fctl = Buffer.alloc(26);
		fctl.writeUInt32BE(4000, 4);
		fctl.writeUInt32BE(4000, 8);
		const file = Buffer.concat([
			PNG_SIGNATURE,
			ihdr(1, 1),
			chunk("acTL", actl),
			chunk("fcTL", fctl),
			chunk("IDAT", deflateSync(Buffer.from([0, 0]))),
			chunk("IEND", Buffer.alloc(0)),
		]);
		expect(() => new Prism().inspect(file)).toThrow(
			expect.objectContaining({ code: "E_PRISM_UNREADABLE" }),
		);
	});
});

/**
 * Rewrite the single-extent `iloc` the engine's encoder writes for an opaque
 * image into one listing the same range `extents` times.
 */
function repeatExtents(avif: Buffer, extents: number): Buffer {
	const metaAt = avif.indexOf("meta", 0, "latin1") - 4;
	const ilocAt = avif.indexOf("iloc", 0, "latin1") - 4;
	const ilocSize = avif.readUInt32BE(ilocAt);
	expect(ilocSize).toBe(30);
	const offset = avif.readUInt32BE(ilocAt + ilocSize - 8);
	const length = avif.readUInt32BE(ilocAt + ilocSize - 4);
	const grow = 8 * (extents - 1);
	const iloc = Buffer.alloc(22 + 8 * extents);
	avif.copy(iloc, 0, ilocAt, ilocAt + 20);
	iloc.writeUInt32BE(iloc.length, 0);
	iloc.writeUInt16BE(extents, 20);
	for (let i = 0; i < extents; i++) {
		iloc.writeUInt32BE(offset + grow, 22 + 8 * i);
		iloc.writeUInt32BE(length, 26 + 8 * i);
	}
	const out = Buffer.concat([
		avif.subarray(0, ilocAt),
		iloc,
		avif.subarray(ilocAt + ilocSize),
	]);
	out.writeUInt32BE(avif.readUInt32BE(metaAt) + grow, metaAt);
	return out;
}

describe("an AVIF whose iloc repeats its data", () => {
	const images = new Prism({ limits: { allowedFormats: ["png", "avif"] } });

	it("is refused before the container is assembled, and the honest file still reads", async () => {
		const qr = await qrImageNative("seed-seed-seed-seed-seed", "png", {
			scale: 4,
		});
		const seed = await images.edit(qr).toBuffer({ format: "avif", effort: 0 });
		const honest = repeatExtents(seed, 1);
		expect(images.inspect(honest).format).toBe("avif");
		const bomb = repeatExtents(seed, 600);
		expect(() => images.inspect(bomb)).toThrow(
			expect.objectContaining({ code: "E_PRISM_UNREADABLE" }),
		);
		await expect(
			images.edit(bomb).toBuffer({ format: "png" }),
		).rejects.toMatchObject({
			code: "E_PRISM_UNREADABLE",
		});
	});
});

/** A 16-bit RGBA PNG, every sample zero. */
function png16(width: number, height: number): Buffer {
	return Buffer.concat([
		PNG_SIGNATURE,
		ihdr(width, height, 16, 6),
		chunk("IDAT", deflateSync(Buffer.alloc((1 + width * 8) * height))),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

describe("the memory a pipeline may hold", () => {
	// 200x200 RGBA: 160 000 bytes decoded.
	const photo = detailedPng(200, 200);

	it("refuses an image whose decoded buffer alone is over maxMemory, from its header", async () => {
		const images = new Prism({ limits: { maxMemory: 100_000 } });
		expect(() => images.inspect(photo)).toThrow(
			expect.objectContaining({ code: "E_PRISM_MEMORY_LIMIT", status: 422 }),
		);
		await expect(
			images.edit(photo).toBuffer({ format: "png" }),
		).rejects.toMatchObject({
			code: "E_PRISM_MEMORY_LIMIT",
		});
	});

	it("counts a resize's float intermediate, not only its pixels", async () => {
		const images = new Prism({ limits: { maxMemory: 400_000 } });
		// Source 160 KB + 200x180 x 16 bytes of floats + the output: refused.
		await expect(
			images
				.edit(photo)
				.resize({ width: 180, height: 180, fit: "fill" })
				.toBuffer({ format: "png" }),
		).rejects.toMatchObject({ code: "E_PRISM_MEMORY_LIMIT" });
		// A box thumbnail writes straight into its output: it fits.
		const thumb = await images
			.edit(photo)
			.thumbnail({ width: 180 })
			.toBuffer({ format: "png" });
		expect(images.inspect(thumb).width).toBe(180);
		// And so does a resize small enough.
		const small = await images
			.edit(photo)
			.resize({ width: 40 })
			.toBuffer({ format: "png" });
		expect(images.inspect(small).width).toBe(40);
	});

	it("counts the composite and the encoder too", async () => {
		// 500 KB: the source (160 KB) and a PNG encoder's copy and output
		// (320 KB) fit; a second layer and the 8-bit copies of both, or the
		// lossy WebP encoder's planes, do not.
		const tight = new Prism({ limits: { maxMemory: 500_000 } });
		await expect(
			tight.edit(photo).composite({ image: photo }).toBuffer({ format: "png" }),
		).rejects.toMatchObject({ code: "E_PRISM_MEMORY_LIMIT" });
		await expect(
			tight.edit(photo).toBuffer({ format: "webp" }),
		).rejects.toMatchObject({
			code: "E_PRISM_MEMORY_LIMIT",
		});
		const rotated = await tight
			.edit(photo)
			.rotate(90)
			.toBuffer({ format: "png" });
		expect(tight.inspect(rotated).width).toBe(200);
	});

	it("writes a 16-bit source at 8 bits unless 16 are asked for", async () => {
		const images = new Prism();
		const source = png16(32, 32);
		const eight = await images.edit(source).toBuffer({ format: "png" });
		expect(eight[24]).toBe(8);
		const sixteen = await images
			.edit(source)
			.toBuffer({ format: "png", depth: 16 });
		expect(sixteen[24]).toBe(16);
	});

	it("narrows a 16-bit source before the steps after it, halving what they hold", async () => {
		// 64x64 RGBA16 is 32 KB decoded. Narrowed, a 64-wide intermediate of
		// 64 rows is 64 KB, and the steps fit 120 KB; kept at 16 bits they
		// would not.
		const images = new Prism({ limits: { maxMemory: 120_000 } });
		const out = await images
			.edit(png16(64, 64))
			.resize({ width: 60 })
			.toBuffer({ format: "png" });
		expect(images.inspect(out).width).toBe(60);
	});
});

describe("pipelines at once", () => {
	it("runs one at a time with a concurrency of 1", async () => {
		const images = new Prism({ concurrency: 1 });
		const order: string[] = [];
		const slow = images
			.edit(detailedPng(600, 600))
			.blur(4)
			.toBuffer({ format: "png" })
			.then(() => order.push("slow"));
		const fast = images
			.edit(detailedPng(8, 8))
			.toBuffer({ format: "png" })
			.then(() => order.push("fast"));
		await Promise.all([slow, fast]);
		expect(order).toEqual(["slow", "fast"]);
	});

	it("reads a concurrency that is not a positive integer as the default", async () => {
		for (const concurrency of [0, -1, 1.5]) {
			const images = new Prism({ concurrency });
			const out = await images
				.edit(detailedPng(8, 8))
				.toBuffer({ format: "png" });
			expect(images.inspect(out).width).toBe(8);
		}
	});

	it("gives a pipeline built on its own a gate of its own", async () => {
		const pipeline = new Pipeline(detailedPng(8, 8), {});
		expect((await pipeline.toBuffer({ format: "png" })).length).toBeGreaterThan(
			0,
		);
	});
});

describe("Gate", () => {
	it("turns a holder away past its queue, and run() waits past it anyway", async () => {
		const gate = new Gate(1, 0);
		let releaseFirst: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const first = gate.run(async () => {
			await held;
			return "first";
		});
		expect(gate.acquire()).toBeUndefined();
		const second = gate.run(async () => "second");
		releaseFirst();
		expect(await Promise.all([first, second])).toEqual(["first", "second"]);
		// Both slots are free again.
		const slot = gate.acquire();
		expect(slot).toBeDefined();
		(await slot)?.();
	});

	it("releases a slot once, however often its release is called", async () => {
		const gate = new Gate(1);
		const release = await gate.acquire();
		release?.();
		release?.();
		const again = await gate.acquire();
		expect(again).toBeDefined();
		const waiting = gate.acquire();
		again?.();
		expect(await waiting).toBeDefined();
	});
});
