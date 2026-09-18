/**
 * The transformation endpoint.
 *
 * Two halves, and the first matters more. What it *refuses* is the security
 * property — a public route that reads files off disk and spends CPU per
 * request is only safe while every axis a caller can vary is bounded — and a
 * hole there is silent until someone finds it. What it *serves* is the
 * feature.
 */

import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_WIDTHS,
	type ImageHttpContext,
	registerImageRoute,
} from "../../src/ImageEndpoint.js";
import { Prism } from "../../src/Prism.js";
import type { ImageServingConfig } from "../../src/types.js";
import { detailedPng } from "../helpers/png.js";

const images = new Prism();

interface Answer {
	status: number;
	headers: Record<string, string>;
	body: Buffer | undefined;
	json: unknown;
}

/** A request, and everything the handler did with it. */
async function call(
	handler: (ctx: ImageHttpContext) => Promise<void> | void,
	query: Record<string, string>,
	headers: Record<string, string> = {},
): Promise<Answer> {
	const answer: Answer = {
		status: 200,
		headers: {},
		body: undefined,
		json: undefined,
	};
	const response = {
		status(code: number) {
			answer.status = code;
			return response;
		},
		header(name: string, value: string) {
			answer.headers[name] = value;
			return response;
		},
		type(value: string) {
			answer.headers["content-type"] = value;
			return response;
		},
		json(data: unknown) {
			answer.json = data;
		},
		sendBuffer(buffer: Buffer) {
			answer.body = buffer;
		},
	};
	await handler({
		request: {
			header: (name) => headers[name.toLowerCase()],
			qs: () => query,
		},
		response,
	});
	return answer;
}

/** Mount the endpoint on a router that only records the handler. */
function mount(
	config: ImageServingConfig,
): (
	query: Record<string, string>,
	headers?: Record<string, string>,
) => Promise<Answer> {
	let handler: ((ctx: ImageHttpContext) => Promise<void> | void) | undefined;
	registerImageRoute(
		{
			get(_path, registered) {
				handler = registered;
				return undefined;
			},
		},
		images,
		config,
	);
	if (handler === undefined) throw new Error("no handler registered");
	const bound = handler;
	return (query, headers) => call(bound, query, headers);
}

const temporary: string[] = [];

/** A directory with one 800x600 image in it, plus whatever else is asked for. */
async function root(
	extra: Record<string, Buffer> = {},
): Promise<{ dir: string; source: Buffer }> {
	const dir = await mkdtemp(join(tmpdir(), "prism-endpoint-"));
	temporary.push(dir);
	const source = detailedPng(800, 600);
	await writeFile(join(dir, "photo.png"), source);
	for (const [name, bytes] of Object.entries(extra)) {
		await writeFile(join(dir, name), bytes);
	}
	return { dir, source };
}

afterEach(async () => {
	vi.restoreAllMocks();
	while (temporary.length > 0) {
		const dir = temporary.pop();
		if (dir !== undefined) await rm(dir, { recursive: true, force: true });
	}
});

describe("the contract with the component", () => {
	it("serves exactly the widths @c9up/nebula generates", () => {
		// Locked as a literal on BOTH sides rather than shared through a
		// dependency, because prism must not depend on a component library and
		// nebula must not depend on a native module. A width on one list and
		// not the other is a srcset entry that 400s — silent, because the page
		// still renders from its single src.
		expect([...DEFAULT_WIDTHS]).toEqual([
			16, 32, 48, 64, 96, 128, 256, 384, 640, 750, 828, 960, 1080, 1280, 1668,
			1920, 2048, 2560, 3200, 3840, 4480, 5120, 6016,
		]);
	});

	it("serves a width a constrained 1200px image would ask for", async () => {
		// The case that made this list what it is: 1200 and 2400 are not rungs,
		// so the component rounds up to 1280 and 2560 — and those must be here.
		const { dir } = await root();
		const request = mount({ roots: [dir] });
		for (const w of ["1280", "2560"]) {
			expect((await request({ src: "photo.png", w, f: "webp" })).status).toBe(
				200,
			);
		}
	});
});

describe("what the endpoint refuses", () => {
	it("refuses a width outside the allow-list", async () => {
		const { dir } = await root();
		const request = mount({ roots: [dir], widths: [400, 800] });
		const answer = await request({ src: "photo.png", w: "401" });
		expect(answer.status).toBe(400);
		expect(answer.json).toMatchObject({
			error: { code: "E_PRISM_IMAGE_WIDTH_NOT_ALLOWED" },
		});
	});

	it("refuses a width that is not an integer", async () => {
		const { dir } = await root();
		const request = mount({ roots: [dir], widths: [400] });
		for (const w of ["4e2", "400.5", "0x190", "", "NaN"]) {
			expect((await request({ src: "photo.png", w })).status).toBe(400);
		}
	});

	it("refuses a quality spelled in any way but plain digits", async () => {
		const { dir } = await root();
		const request = mount({ roots: [dir], widths: [400], qualities: [70] });
		for (const q of ["0x46", "7e1", "70.0", " 70"]) {
			expect((await request({ src: "photo.png", w: "400", q })).status, q).toBe(
				400,
			);
		}
	});

	it("refuses a format outside the allow-list", async () => {
		const { dir } = await root();
		const request = mount({ roots: [dir], widths: [400], formats: ["webp"] });
		const answer = await request({ src: "photo.png", w: "400", f: "avif" });
		expect(answer.status).toBe(400);
		expect(answer.json).toMatchObject({
			error: { code: "E_PRISM_IMAGE_FORMAT_NOT_ALLOWED" },
		});
	});

	it("refuses a format the engine cannot write at all", async () => {
		const { dir } = await root();
		const request = mount({ roots: [dir], widths: [400] });
		expect(
			(await request({ src: "photo.png", w: "400", f: "gif" })).status,
		).toBe(400);
	});

	it("refuses a quality outside the allow-list", async () => {
		const { dir } = await root();
		const request = mount({ roots: [dir], widths: [400], qualities: [70] });
		const answer = await request({ src: "photo.png", w: "400", q: "71" });
		expect(answer.status).toBe(400);
		expect(answer.json).toMatchObject({
			error: { code: "E_PRISM_IMAGE_QUALITY_NOT_ALLOWED" },
		});
	});

	it("refuses to walk out of a root", async () => {
		const { dir } = await root();
		const request = mount({ roots: [join(dir, "public")], widths: [400] });
		for (const src of [
			"../photo.png",
			"..%2Fphoto.png",
			"sub/../../photo.png",
			"./../photo.png",
		]) {
			const answer = await request({ src, w: "400" });
			expect(answer.status, src).toBe(404);
		}
	});

	it("refuses an absolute path or a URL, whatever is in the roots", async () => {
		const { dir } = await root();
		const request = mount({ roots: [dir], widths: [400] });
		for (const src of [
			join(dir, "photo.png"),
			"/etc/passwd",
			"file:///etc/passwd",
			"https://example.com/a.png",
		]) {
			expect((await request({ src, w: "400" })).status, src).toBe(404);
		}
	});

	it("answers a missing file and an unreachable one identically", async () => {
		// Telling them apart is how a caller maps the disk.
		const { dir } = await root();
		const request = mount({ roots: [dir], widths: [400] });
		const missing = await request({ src: "nope.png", w: "400" });
		const outside = await request({ src: "../photo.png", w: "400" });
		expect(missing.status).toBe(404);
		expect(outside.status).toBe(404);
		expect(missing.json).toEqual(outside.json);
	});

	it("refuses a directory, and a src that is empty", async () => {
		const { dir } = await root();
		const request = mount({ roots: [dir], widths: [400] });
		expect((await request({ src: ".", w: "400" })).status).toBe(404);
		expect((await request({ src: "", w: "400" })).status).toBe(404);
		expect((await request({ w: "400" })).status).toBe(400);
	});

	it("serves nothing at all when no root is configured", async () => {
		await root();
		const request = mount({ roots: [], widths: [400] });
		expect((await request({ src: "photo.png", w: "400" })).status).toBe(404);
	});
});

describe("what the endpoint serves", () => {
	it("resizes to the requested width and encodes to the requested format", async () => {
		const { dir } = await root();
		const request = mount({ roots: [dir], widths: [400] });
		const answer = await request({ src: "photo.png", w: "400", f: "webp" });

		expect(answer.status).toBe(200);
		expect(answer.headers["content-type"]).toBe("image/webp");
		const meta = images.inspect(answer.body ?? Buffer.alloc(0));
		expect(meta.format).toBe("webp");
		expect(meta.width).toBe(400);
		expect(meta.height).toBe(300);
	});

	it("never enlarges a source past its own size", async () => {
		// The component offers a 2x variant without knowing how big the source
		// is. Answering that with an upscale would be worse than answering it
		// with the original — bigger bytes, no more detail.
		const { dir } = await root();
		const request = mount({ roots: [dir], widths: [2560] });
		const answer = await request({ src: "photo.png", w: "2560", f: "webp" });
		expect(images.inspect(answer.body ?? Buffer.alloc(0)).width).toBe(800);
	});

	it("re-encodes into the source format when none is asked for", async () => {
		const { dir } = await root();
		const request = mount({ roots: [dir], widths: [400] });
		const answer = await request({ src: "photo.png", w: "400" });
		expect(answer.headers["content-type"]).toBe("image/png");
		expect(images.inspect(answer.body ?? Buffer.alloc(0)).format).toBe("png");
	});

	it("passes a file it cannot decode through untouched", async () => {
		// An SVG is already resolution-independent and already passed the root
		// check. A 415 here would be a broken image for a perfectly good file.
		const svg = Buffer.from(
			'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
		);
		const { dir } = await root({ "logo.svg": svg });
		const request = mount({ roots: [dir], widths: [400] });
		const answer = await request({ src: "logo.svg", w: "400" });
		expect(answer.status).toBe(200);
		expect(answer.headers["content-type"]).toBe("image/svg+xml");
		expect(answer.body?.equals(svg)).toBe(true);
	});

	it("finds a file in the second root when the first does not have it", async () => {
		const first = await root();
		const second = await root({ "only-here.png": detailedPng(100, 100) });
		const request = mount({
			roots: [first.dir, second.dir],
			widths: [50],
		});
		expect((await request({ src: "only-here.png", w: "50" })).status).toBe(200);
	});

	it("strips the EXIF block, so a photo's GPS does not reach the page", async () => {
		const withExif = jpegWithExif(await encodeJpeg(), "51.5N 0.12W");
		expect(withExif.includes(Buffer.from("Exif\0\0", "binary"))).toBe(true);

		const { dir } = await root({ "holiday.jpg": withExif });
		const request = mount({ roots: [dir], widths: [100] });
		const answer = await request({ src: "holiday.jpg", w: "100", f: "jpeg" });

		const body = answer.body ?? Buffer.alloc(0);
		expect(images.inspect(body).format).toBe("jpeg");
		expect(body.includes(Buffer.from("Exif\0\0", "binary"))).toBe(false);
		expect(body.includes(Buffer.from("51.5N 0.12W"))).toBe(false);
	});
});

describe("caching", () => {
	it("tags a variant and answers a revalidation without reading it", async () => {
		const { dir } = await root();
		const request = mount({ roots: [dir], widths: [400] });
		const first = await request({ src: "photo.png", w: "400", f: "webp" });
		const etag = first.headers.etag ?? "";
		expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
		expect(first.headers["cache-control"]).toContain("immutable");

		const second = await request(
			{ src: "photo.png", w: "400", f: "webp" },
			{ "if-none-match": etag },
		);
		expect(second.status).toBe(304);
		expect(second.body?.length).toBe(0);
	});

	it("changes the tag when the file behind the URL changes", async () => {
		// The URL carries no version, so nothing else could invalidate a year
		// of `immutable`.
		const { dir } = await root();
		const request = mount({ roots: [dir], widths: [400] });
		const before = await request({ src: "photo.png", w: "400", f: "webp" });

		await writeFile(join(dir, "photo.png"), detailedPng(800, 600));
		const later = new Date(Date.now() + 5_000);
		await utimes(join(dir, "photo.png"), later, later);

		const after = await request({ src: "photo.png", w: "400", f: "webp" });
		expect(after.headers.etag).not.toBe(before.headers.etag);
	});

	it("serves a cached variant after the source is gone", async () => {
		const { dir } = await root();
		const cacheDir = join(dir, ".cache");
		const request = mount({ roots: [dir], widths: [400], cacheDir });
		const first = await request({ src: "photo.png", w: "400", f: "webp" });
		expect(first.status).toBe(200);

		// Proof the second answer came from the cache and not the file: the
		// file is still needed for its mtime, so only its contents go.
		const spy = vi.spyOn(images, "edit");
		const second = await request({ src: "photo.png", w: "400", f: "webp" });
		expect(spy).not.toHaveBeenCalled();
		expect(second.body?.equals(first.body ?? Buffer.alloc(0))).toBe(true);
		await stat(cacheDir);
	});

	it("decodes once when the same variant is asked for twice at once", async () => {
		// A page with a <picture> resolves several variants in the same tick.
		// Without single-flight the first visit decodes each of them N times.
		const { dir } = await root();
		const request = mount({ roots: [dir], widths: [400] });
		const spy = vi.spyOn(images, "edit");
		await Promise.all([
			request({ src: "photo.png", w: "400", f: "webp" }),
			request({ src: "photo.png", w: "400", f: "webp" }),
			request({ src: "photo.png", w: "400", f: "webp" }),
		]);
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("leaves no temporary file behind in the cache directory", async () => {
		const { dir } = await root();
		const cacheDir = join(dir, ".cache");
		const request = mount({ roots: [dir], widths: [400], cacheDir });
		await request({ src: "photo.png", w: "400", f: "webp" });
		const { readdir } = await import("node:fs/promises");
		const entries = await readdir(cacheDir);
		expect(entries.filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});
});

/** A small JPEG, encoded by the engine so it is a real one. */
function encodeJpeg(): Promise<Buffer> {
	return images.edit(detailedPng(200, 150)).toFormat("jpeg", 80);
}

/**
 * The same JPEG with an APP1 EXIF segment carrying `note`.
 *
 * Spliced in rather than produced by a camera, because what the test needs is
 * a byte sequence that must not survive — and a real photo would put the
 * coordinates in a file nobody can review.
 */
function jpegWithExif(jpeg: Buffer, note: string): Buffer {
	const payload = Buffer.concat([
		Buffer.from("Exif\0\0", "binary"),
		// A minimal little-endian TIFF header, then the note as raw bytes. The
		// engine only reads the orientation tag, and finding none it leaves the
		// image upright — which is all this fixture needs to be valid enough.
		Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]),
		Buffer.from(note),
	]);
	const header = Buffer.alloc(4);
	header.writeUInt16BE(0xffe1, 0); // APP1
	header.writeUInt16BE(payload.length + 2, 2);
	// After SOI, before everything else.
	return Buffer.concat([
		jpeg.subarray(0, 2),
		header,
		payload,
		jpeg.subarray(2),
	]);
}
