/**
 * The transformation endpoint.
 *
 * Two halves, and the first matters more. What it *refuses* is the security
 * property — a public route that reads files off disk and spends CPU per
 * request is only safe while every axis a caller can vary is bounded — and a
 * hole there is silent until someone finds it. What it *serves* is the
 * feature.
 */

import {
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	realpath,
	rename,
	rm,
	stat,
	symlink,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_WIDTHS,
	type ImageHttpContext,
	registerImageRoute,
} from "../../src/ImageEndpoint.js";
import { openedPathNative } from "../../src/native.js";
import { Pipeline, Prism } from "../../src/Prism.js";
import type {
	ImageServingConfig,
	OutputOptions,
	PrismConfig,
} from "../../src/types.js";
import { detailedPng } from "../helpers/png.js";

/**
 * Hooks into the filesystem calls the endpoint makes, so a test can change
 * the disk at the exact moment between a check and the read that follows it.
 */
const fsHooks = vi.hoisted(() => {
	const hooks: {
		afterRealpath?: (real: string) => Promise<void>;
		afterOpen?: (path: string) => Promise<void>;
		/** Answer like a system without procfs. */
		noProcfs?: boolean;
	} = {};
	return hooks;
});

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		realpath: async (path: string) => {
			const real = await actual.realpath(path);
			await fsHooks.afterRealpath?.(real);
			return real;
		},
		open: async (path: string, flags?: number) => {
			const handle = await actual.open(path, flags);
			await fsHooks.afterOpen?.(path);
			return handle;
		},
		readlink: async (path: string) => {
			if (fsHooks.noProcfs === true && path.startsWith("/proc/")) {
				throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
			}
			return actual.readlink(path);
		},
	};
});

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
	engine: Prism = images,
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
		engine,
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
	fsHooks.afterRealpath = undefined;
	fsHooks.afterOpen = undefined;
	fsHooks.noProcfs = undefined;
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

	it("serves the src @c9up/nebula sends for a root-relative path", async () => {
		// Locked as a literal on both sides, like the widths: nebula's default
		// resolver turns `/photos/hero.png` into exactly this URL, and its
		// `tests/unit/image.test.ts` locks the same string.
		const { dir } = await root();
		await mkdir(join(dir, "photos"));
		await writeFile(join(dir, "photos", "hero.png"), detailedPng(800, 600));
		const request = mount({ roots: [dir] });
		const url = new URL("/__image?src=photos%2Fhero.png&w=640", "http://x");
		const answer = await request(Object.fromEntries(url.searchParams));
		expect(answer.status).toBe(200);
		expect(images.inspect(answer.body ?? Buffer.alloc(0)).width).toBe(640);
	});

	it("reads one leading slash as the root, as Next's image optimizer does", async () => {
		const { dir } = await root();
		await mkdir(join(dir, "photos"));
		await writeFile(join(dir, "photos", "hero.png"), detailedPng(80, 60));
		const request = mount({ roots: [dir], widths: [64] });
		expect((await request({ src: "/photos/hero.png", w: "64" })).status).toBe(
			200,
		);
		// Never more than one: a protocol-relative URL, or a slash that
		// re-opens an absolute path, is still refused.
		for (const src of [
			"//photos/hero.png",
			"//example.com/a.png",
			"///etc/passwd",
			"/",
			"/../photo.png",
			"/%2e%2e/photo.png",
		]) {
			expect((await request({ src, w: "64" })).status, src).toBe(404);
		}
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

	it("refuses a symbolic link in a root that points outside it", async () => {
		const outside = await root();
		const secret = join(outside.dir, "secret.txt");
		await writeFile(secret, "outside-root secret\n");
		const { dir } = await root();
		await symlink(secret, join(dir, "avatar.png"));
		await symlink(join(outside.dir, "photo.png"), join(dir, "elsewhere.png"));
		await symlink(outside.dir, join(dir, "linked-dir"));
		const request = mount({ roots: [dir], widths: [400] });
		for (const src of ["avatar.png", "elsewhere.png", "linked-dir/photo.png"]) {
			const answer = await request({ src, w: "400", f: "webp" });
			expect(answer.status, src).toBe(404);
			expect(answer.body, src).toBeUndefined();
		}
		const missing = await request({ src: "nope.png", w: "400" });
		expect((await request({ src: "avatar.png", w: "400" })).json).toEqual(
			missing.json,
		);
	});

	it("follows a symbolic link that stays inside the root", async () => {
		const { dir } = await root();
		await mkdir(join(dir, "aliases"));
		await symlink(join(dir, "photo.png"), join(dir, "aliases", "hero.png"));
		const request = mount({ roots: [dir], widths: [400] });
		const answer = await request({
			src: "aliases/hero.png",
			w: "400",
			f: "webp",
		});
		expect(answer.status).toBe(200);
	});

	for (const procfs of [true, false]) {
		const label = procfs ? "" : " (no procfs)";

		it(`refuses a source swapped for an outside link after its check${label}`, async () => {
			fsHooks.noProcfs = !procfs;
			// Someone who can write in the root replaces the checked file with a
			// link to an image elsewhere, between the confinement check and the
			// read. What is read must be what was checked, or nothing.
			const outside = await root();
			await writeFile(join(outside.dir, "small.png"), detailedPng(300, 200));
			const { dir } = await root();
			const checked = join(dir, "photo.png");
			fsHooks.afterRealpath = async (real) => {
				if (!real.endsWith("photo.png")) return;
				fsHooks.afterRealpath = undefined;
				await rm(real);
				await symlink(join(outside.dir, "small.png"), real);
			};
			const request = mount({ roots: [dir], widths: [400] });
			const answer = await request({ src: "photo.png", w: "400", f: "png" });
			expect(fsHooks.afterRealpath).toBeUndefined();
			expect(answer.status).toBe(404);
			expect(answer.body).toBeUndefined();
			expect((await lstat(checked)).isSymbolicLink()).toBe(true);
		});

		it(`refuses a source whose directory is swapped for an outside link after its check${label}`, async () => {
			fsHooks.noProcfs = !procfs;
			// The same race one level up: no-follow on the last segment alone
			// would still walk through a swapped directory.
			const outside = await mkdtemp(join(tmpdir(), "prism-outside-"));
			temporary.push(outside);
			await mkdir(join(outside, "sub"));
			await writeFile(join(outside, "sub", "photo.png"), detailedPng(300, 200));
			const { dir, source } = await root();
			await mkdir(join(dir, "sub"));
			await writeFile(join(dir, "sub", "photo.png"), source);
			fsHooks.afterRealpath = async (real) => {
				if (!real.endsWith(join("sub", "photo.png"))) return;
				fsHooks.afterRealpath = undefined;
				await rename(join(dir, "sub"), join(dir, "sub-before"));
				await symlink(join(outside, "sub"), join(dir, "sub"));
			};
			const request = mount({ roots: [dir], widths: [400] });
			const answer = await request({
				src: "sub/photo.png",
				w: "400",
				f: "png",
			});
			expect(fsHooks.afterRealpath).toBeUndefined();
			expect(answer.status).toBe(404);
			expect(answer.body).toBeUndefined();
		});
	}

	it("serves an unchanged source when procfs cannot be asked", async () => {
		fsHooks.noProcfs = true;
		const { dir } = await root();
		const request = mount({ roots: [dir], widths: [400] });
		const answer = await request({ src: "photo.png", w: "400", f: "png" });
		expect(answer.status).toBe(200);
	});

	it("renders the file it checked even when the path changes after it is opened", async () => {
		// Once open, the endpoint reads from that handle: moving the file
		// aside and pointing its path outside no longer changes what is
		// rendered. Moved, not deleted: a deleted file has no name left in the
		// root on every system (Windows parks it under `$Extend\$Deleted`),
		// and an unnamed file is refused.
		const outside = await root();
		await writeFile(join(outside.dir, "small.png"), detailedPng(300, 200));
		const { dir } = await root();
		fsHooks.afterOpen = async (path) => {
			if (!path.endsWith("photo.png")) return;
			fsHooks.afterOpen = undefined;
			await rename(path, join(dir, "photo-before.png"));
			await symlink(join(outside.dir, "small.png"), path);
		};
		const request = mount({ roots: [dir], widths: [400] });
		const answer = await request({ src: "photo.png", w: "400", f: "png" });
		expect(fsHooks.afterOpen).toBeUndefined();
		expect(answer.status).toBe(200);
		if (answer.body === undefined) throw new Error("no body");
		expect(images.inspect(answer.body).width).toBe(400);
	});

	it("names an open file by its handle where the engine can ask", async () => {
		// The answer the confinement check relies on without procfs: where
		// the file is NOW, not where it was opened from.
		const { dir } = await root();
		const handle = await open(join(dir, "photo.png"), "r");
		try {
			await rename(join(dir, "photo.png"), join(dir, "moved.png"));
			const located = openedPathNative(handle.fd);
			if (process.platform === "darwin" || process.platform === "win32") {
				expect(located).toBe(await realpath(join(dir, "moved.png")));
			} else {
				// Linux is asked through procfs by the endpoint itself.
				expect(located).toBeUndefined();
			}
		} finally {
			await handle.close();
		}
	});

	it("accepts a root that is itself a symbolic link", async () => {
		const { dir } = await root();
		const parent = await mkdtemp(join(tmpdir(), "prism-linked-root-"));
		temporary.push(parent);
		const linked = join(parent, "current");
		await symlink(dir, linked);
		const request = mount({ roots: [linked], widths: [400] });
		expect(
			(await request({ src: "photo.png", w: "400", f: "webp" })).status,
		).toBe(200);
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

describe("what never leaves the route", () => {
	// A source that fails to render used to be sent as it was. That is the
	// one file nobody vetted: an SVG with a script, a photo still carrying its
	// GPS block, anything else that happened to sit in a root.
	const evilSvg = Buffer.from(
		'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>fetch("/account")</script></svg>',
	);

	it("refuses an SVG instead of serving it from the application's origin", async () => {
		const { dir } = await root({ "evil.svg": evilSvg });
		const request = mount({ roots: [dir], widths: [640] });
		const queries: Record<string, string>[] = [
			{ src: "evil.svg", w: "640" },
			{ src: "evil.svg", w: "640", f: "webp" },
		];
		for (const query of queries) {
			const answer = await request(query);
			expect(answer.status, JSON.stringify(query)).toBe(404);
			expect(answer.body).toBeUndefined();
			expect(JSON.stringify(answer.json)).not.toContain("script");
		}
	});

	it("refuses a file in a root that is not an image at all", async () => {
		const { dir } = await root({
			".env": Buffer.from("DB_PASSWORD=hunter2\n"),
		});
		const request = mount({ roots: [dir], widths: [640] });
		const answer = await request({ src: ".env", w: "640" });
		// Answered like a missing file: a root holds images, and telling a
		// secret from an absent file is how a caller maps the disk.
		expect(answer.status).toBe(404);
		expect(answer.body).toBeUndefined();
		const missing = await request({ src: "nope.png", w: "640" });
		expect(answer.json).toEqual(missing.json);
	});

	it("refuses a photo it cannot render rather than sending its EXIF out", async () => {
		const withExif = jpegWithExif(await encodeJpeg(), "48.8567N 2.3508E");
		const { dir } = await root({ "huge.jpg": withExif });
		// Over the pixel ceiling: the engine refuses it, and the original —
		// GPS block and all — used to go out instead.
		const tight = new Prism({ limits: { maxPixels: 1000 } });
		const request = mount({ roots: [dir], widths: [100] }, tight);
		const queries: Record<string, string>[] = [
			{ src: "huge.jpg", w: "100" },
			{ src: "huge.jpg", w: "100", f: "jpeg" },
		];
		for (const query of queries) {
			const answer = await request(query);
			expect(answer.status, JSON.stringify(query)).toBe(422);
			expect(answer.body).toBeUndefined();
			expect(answer.json).toMatchObject({
				error: { code: "E_PRISM_IMAGE_UNPROCESSABLE" },
			});
			expect(answer.headers["cache-control"]).toBe("no-store");
		}
	});

	it("refuses an image that is corrupt", async () => {
		const png = detailedPng(40, 40);
		const corrupt = Buffer.concat([png.subarray(0, 60), Buffer.alloc(200, 7)]);
		const { dir } = await root({ "broken.png": corrupt });
		const request = mount({ roots: [dir], widths: [16] });
		const answer = await request({ src: "broken.png", w: "16", f: "webp" });
		expect(answer.status).toBe(422);
		expect(answer.body).toBeUndefined();
	});

	it("refuses a source over the byte limit before reading it", async () => {
		const { dir } = await root();
		const small = new Prism({ limits: { maxBytes: 100 } });
		const request = mount({ roots: [dir], widths: [400] }, small);
		const spy = vi.spyOn(small, "inspect");
		const answer = await request({ src: "photo.png", w: "400" });
		expect(answer.status).toBe(422);
		expect(spy).not.toHaveBeenCalled();
	});

	it("labels the bytes with the format the engine wrote, never the file's name", async () => {
		// A PNG named .jpg is re-encoded as what it IS.
		const { dir } = await root({ "misnamed.jpg": detailedPng(40, 30) });
		const request = mount({ roots: [dir], widths: [16] });
		const answer = await request({ src: "misnamed.jpg", w: "16" });
		expect(answer.status).toBe(200);
		expect(answer.headers["content-type"]).toBe("image/png");
		expect(images.inspect(answer.body ?? Buffer.alloc(0)).format).toBe("png");
	});

	it("sends the hardening headers on every answer", async () => {
		const { dir } = await root({ "evil.svg": evilSvg });
		const request = mount({ roots: [dir], widths: [400] });
		const served = await request({ src: "photo.png", w: "400", f: "webp" });
		const answers = [
			served,
			await request({ src: "evil.svg", w: "400" }),
			await request({ src: "photo.png", w: "401" }),
			await request(
				{ src: "photo.png", w: "400", f: "webp" },
				{ "if-none-match": served.headers.etag ?? "" },
			),
		];
		expect(answers.map((answer) => answer.status)).toEqual([
			200, 404, 400, 304,
		]);
		for (const answer of answers) {
			expect(answer.headers["content-security-policy"]).toBe(
				"default-src 'none'; sandbox",
			);
			expect(answer.headers["x-content-type-options"]).toBe("nosniff");
		}
	});
});

/**
 * An engine whose renders wait until the test lets them finish, and which
 * counts them. Inspection is the real one, so sources are read for real.
 */
class HeldPrism extends Prism {
	renders = 0;
	running = 0;
	mostAtOnce = 0;
	outputs: OutputOptions[] = [];
	readonly #held: (() => void)[] = [];

	override edit(bytes: Buffer): Pipeline {
		return new HeldPipeline(bytes, this.config(), this);
	}

	/** A render starts: counted, then parked until released. */
	async hold(output: OutputOptions): Promise<void> {
		this.renders++;
		this.running++;
		this.mostAtOnce = Math.max(this.mostAtOnce, this.running);
		this.outputs.push(output);
		await new Promise<void>((resolve) => this.#held.push(resolve));
		this.running--;
	}

	releaseAll(): void {
		for (const resolve of this.#held.splice(0)) resolve();
	}

	/** Let the event loop run until `count` renders are parked. */
	async parked(count: number): Promise<void> {
		const deadline = Date.now() + 5_000;
		while (this.#held.length < count && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 2));
		}
		expect(this.#held.length).toBe(count);
	}
}

class HeldPipeline extends Pipeline {
	readonly #engine: HeldPrism;

	constructor(input: Buffer, config: PrismConfig, engine: HeldPrism) {
		super(input, config);
		this.#engine = engine;
	}

	override async toBuffer(output: OutputOptions): Promise<Buffer> {
		await this.#engine.hold(output);
		return super.toBuffer(output);
	}
}

describe("what producing a variant costs", () => {
	it("runs at most `concurrency` renders and turns away what the queue cannot hold", async () => {
		const { dir } = await root();
		const engine = new HeldPrism();
		const widths = [100, 200, 300, 400, 500];
		const request = mount(
			{ roots: [dir], widths, concurrency: 2, queueLimit: 2 },
			engine,
		);
		const answers = widths.map((w) =>
			request({ src: "photo.png", w: String(w), f: "webp" }),
		);
		await engine.parked(2);
		// Two rendering, two waiting, the last to arrive refused at once —
		// which one that is depends on how the file reads interleave.
		while (engine.renders < 4 || engine.running > 0) {
			engine.releaseAll();
			await new Promise((resolve) => setTimeout(resolve, 2));
		}
		const settled = await Promise.all(answers);
		const statuses = settled.map((answer) => answer.status).sort();
		expect(statuses).toEqual([200, 200, 200, 200, 503]);
		const refused = settled.find((answer) => answer.status === 503);
		expect(refused?.headers["retry-after"]).toBe("2");
		expect(refused?.headers["cache-control"]).toBe("no-store");
		expect(refused?.json).toMatchObject({
			error: { code: "E_PRISM_IMAGE_BUSY" },
		});
		expect(engine.mostAtOnce).toBe(2);
		expect(engine.renders).toBe(4);
	});

	it("renders every width past the source's own once", async () => {
		// 1280, 1668 and 1920 of an 800px source are the same 800px image.
		const { dir } = await root();
		const request = mount({ roots: [dir] });
		const spy = vi.spyOn(images, "edit");
		const answers = [];
		for (const w of ["1280", "1668", "1920"]) {
			answers.push(await request({ src: "photo.png", w, f: "webp" }));
		}
		expect(spy).toHaveBeenCalledTimes(1);
		expect(new Set(answers.map((answer) => answer.headers.etag)).size).toBe(1);
		expect(images.inspect(answers[2]?.body ?? Buffer.alloc(0)).width).toBe(800);
	});

	it("caches by default, so a repeated request is not a second render", async () => {
		const { dir } = await root();
		const request = mount({ roots: [dir], widths: [400] });
		const spy = vi.spyOn(images, "edit");
		const first = await request({ src: "photo.png", w: "400", f: "webp" });
		const second = await request({ src: "photo.png", w: "400", f: "webp" });
		expect(spy).toHaveBeenCalledTimes(1);
		expect(second.body?.equals(first.body ?? Buffer.alloc(0))).toBe(true);
	});

	it("encodes AVIF at a fast effort unless configured otherwise", async () => {
		const { dir } = await root();
		const fast = new HeldPrism();
		const fastRequest = mount({ roots: [dir], widths: [64] }, fast);
		const pending = fastRequest({ src: "photo.png", w: "64", f: "avif" });
		await fast.parked(1);
		fast.releaseAll();
		expect((await pending).status).toBe(200);
		expect(fast.outputs[0]).toMatchObject({ format: "avif", effort: 1 });

		const slow = new HeldPrism();
		const slowRequest = mount({ roots: [dir], widths: [64], effort: 6 }, slow);
		const later = slowRequest({ src: "photo.png", w: "64", f: "avif" });
		await slow.parked(1);
		slow.releaseAll();
		await later;
		expect(slow.outputs[0]).toMatchObject({ effort: 6 });
	});

	it("refuses a nonsensical bound when it is mounted, not per request", () => {
		for (const serve of [
			{ concurrency: 0 },
			{ concurrency: 1.5 },
			{ queueLimit: -1 },
			{ effort: 10 },
			{ memoryCacheBytes: Number.NaN },
		]) {
			expect(() => mount({ roots: ["/nowhere"], ...serve })).toThrow(
				/images\.serve\./,
			);
		}
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
		const files = await cached(cacheDir);
		expect(files).toHaveLength(1);
		expect(files.filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("keeps one version of a source's variants, however often it is replaced", async () => {
		// The common layout: an avatar re-uploaded at the same path. Every
		// upload used to add its variants to the cache, and none ever left.
		const { dir } = await root();
		const cacheDir = join(dir, ".cache");
		const widths = [64, 128, 256, 384];
		const request = mount({ roots: [dir], widths, cacheDir });
		for (let upload = 1; upload <= 5; upload++) {
			await writeFile(join(dir, "photo.png"), detailedPng(400 + upload, 300));
			const when = new Date(Date.now() + upload * 10_000);
			await utimes(join(dir, "photo.png"), when, when);
			for (const w of widths) {
				const answer = await request({
					src: "photo.png",
					w: String(w),
					f: "webp",
				});
				expect(answer.status).toBe(200);
			}
			expect(await cached(cacheDir), `upload ${upload}`).toHaveLength(4);
		}
	});

	it("removes the temporary file when the rename fails", async () => {
		const { dir } = await root();
		const cacheDir = join(dir, ".cache");
		const request = mount({ roots: [dir], widths: [400], cacheDir });
		await request({ src: "photo.png", w: "400", f: "webp" });
		const [variant] = await cached(cacheDir);
		if (variant === undefined) throw new Error("nothing was cached");
		// A non-empty directory where the variant goes: the rename onto it
		// fails, after the temporary file was written.
		await rm(join(cacheDir, variant));
		await mkdir(join(cacheDir, variant));
		await writeFile(join(cacheDir, variant, "occupied"), "x");

		const again = await request({ src: "photo.png", w: "400", f: "webp" });
		expect(again.status).toBe(200);
		expect(
			(await cached(cacheDir)).filter((name) => name.endsWith(".tmp")),
		).toEqual([]);
	});
});

/** Every file under a cache directory, relative to it. */
async function cached(cacheDir: string): Promise<string[]> {
	const entries = await readdir(cacheDir, {
		recursive: true,
		withFileTypes: true,
	});
	return entries
		.filter((entry) => entry.isFile())
		.map((entry) => relative(cacheDir, join(entry.parentPath, entry.name)))
		.filter((name) => !name.includes("occupied"));
}

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
