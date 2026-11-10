/**
 * The transformation endpoint `<Image>` points at.
 *
 * One route that takes a source, a width, a format and a quality, and answers
 * with the bytes. It exists so a page can offer a dozen variants of every
 * image without anyone generating them ahead of time.
 *
 * **An open transformation endpoint is a cache bomb before it is a feature.**
 * Anything a caller can vary is a dimension of a cache nobody bounded: ten
 * thousand requests for ten thousand widths is ten thousand decodes and ten
 * thousand files, from one curl loop. So every axis here is allow-listed
 * against configuration, not validated for plausibility:
 *
 * - `src` must resolve inside a configured root. Nothing else is reachable.
 * - `w` must be one of the configured widths.
 * - `f` must be one of the configured formats.
 * - `q` must be one of the configured qualities.
 *
 * That leaves the number of distinct answers at (files × widths × formats ×
 * qualities), which is a number the operator chose. A request outside the
 * lists is a 400 and is never decoded — refusing before the work is the whole
 * point.
 *
 * Bounding the number of answers does not bound what producing one costs,
 * nor how often it is produced. So a variant is rendered at most once — keyed
 * by the width it will REALLY have, so every width past the source's own
 * collapses to one render, and kept in a cache that is on by default — and
 * renders run a few at a time. An AVIF encode is seconds of CPU on the libuv
 * pool that also serves the application's fs, dns and crypto; four of them at
 * once froze an application for a minute and a half. Past the queue, the
 * answer is a 503 the client can retry, not a longer wait for everyone.
 *
 * Height and crop are deliberately absent. They are the two axes that cannot
 * be allow-listed without making the component unusable, and neither is needed
 * — a responsive image crops with `object-fit`, in the browser, for free.
 *
 * What comes back carries no EXIF. The engine re-encodes from decoded pixels
 * and metadata does not survive that, which is what keeps a holiday photo's
 * GPS coordinates out of a public thumbnail. That only holds if nothing but a
 * re-encode ever leaves: a source the engine cannot render — an SVG, a photo
 * over the pixel ceiling, a `.env` that happens to sit in a root — is refused,
 * never passed through as it is.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve as resolvePath, sep } from "node:path";
import { PrismError } from "./errors.js";
import type { Prism } from "./Prism.js";
import type { ImageFormat, ImageServingConfig } from "./types.js";

/** Formats the endpoint will encode to. A subset of what the engine reads. */
const ENCODABLE: readonly ImageFormat[] = ["avif", "webp", "jpeg", "png"];

/**
 * Is this string a format the endpoint can produce?
 *
 * A predicate rather than a cast: the value comes off a query string, and the
 * only thing that makes it an `ImageFormat` is this check passing.
 */
function isEncodable(value: string): value is ImageFormat {
	return ENCODABLE.some((format) => format === value);
}

/**
 * The widths served when configuration names none.
 *
 * The same list `@c9up/nebula` draws from — its `IMAGE_SIZES` for elements
 * that are not the width of a screen, then its device ladder. That is the
 * contract between the two halves, and it is the one thing here that cannot
 * be changed on one side alone: a component emitting a width this list does
 * not contain produces a `srcset` where every entry is a 400, and the page
 * quietly falls back to its single `src`.
 *
 * `tests/unit/image-endpoint.test.ts` locks the literal, and nebula's
 * `tests/unit/image.test.ts` locks the same one.
 */
export const DEFAULT_WIDTHS: readonly number[] = [
	// Elements that are not the width of a screen: avatars, icons, thumbnails.
	16, 32, 48, 64, 96, 128, 256, 384,
	// Device widths.
	640, 750, 828, 960, 1080, 1280, 1668, 1920, 2048, 2560, 3200, 3840, 4480,
	5120, 6016,
];

interface ResolvedConfig {
	path: string;
	roots: readonly string[];
	widths: ReadonlySet<number>;
	formats: ReadonlySet<ImageFormat>;
	qualities: ReadonlySet<number>;
	quality: number;
	cacheDir: string | undefined;
	memoryCacheBytes: number;
	maxAge: number;
	maxBytes: number;
	concurrency: number;
	queueLimit: number;
	effort: number;
	autoOrient: boolean;
}

/** A configured count, refused at mount rather than misread per request. */
function count(
	name: string,
	value: number,
	minimum: number,
	maximum = Number.MAX_SAFE_INTEGER,
): number {
	if (!Number.isInteger(value) || value < minimum || value > maximum) {
		throw new Error(
			`[prism] images.serve.${name} must be an integer from ${minimum} to ${maximum}, got ${value}.`,
		);
	}
	return value;
}

/** The engine's own default for `limits.maxBytes`. */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

function resolveConfig(
	config: ImageServingConfig,
	images: Prism,
): ResolvedConfig {
	const quality = config.quality ?? 82;
	return {
		path: config.path ?? "/__image",
		// Normalised once, so the prefix check below compares like with like.
		roots: config.roots.map((root) => resolvePath(root)),
		widths: new Set(config.widths ?? DEFAULT_WIDTHS),
		formats: new Set(config.formats ?? ENCODABLE),
		qualities: new Set(config.qualities ?? [quality]),
		quality,
		cacheDir: config.cacheDir,
		memoryCacheBytes: count(
			"memoryCacheBytes",
			config.memoryCacheBytes ?? 32 * 1024 * 1024,
			0,
		),
		maxAge: config.maxAge ?? 31_536_000,
		maxBytes: images.config().limits?.maxBytes ?? DEFAULT_MAX_BYTES,
		// Below libuv's default pool of four, so a burst of renders leaves
		// threads for the rest of the application.
		concurrency: count("concurrency", config.concurrency ?? 2, 1),
		queueLimit: count("queueLimit", config.queueLimit ?? 64, 0),
		// The fast end: an image encoded while a visitor waits. Measured on a
		// 1600px noise image, effort 4 took four times as long as effort 1
		// (10 s against 2.5 s) for bytes within one percent.
		effort: count("effort", config.effort ?? 1, 0, 9),
		autoOrient: images.config().autoOrient !== false,
	};
}

/**
 * At most `limit` renders at once, at most `queueLimit` waiting.
 *
 * A slot is a release function; `undefined` means the queue is full and the
 * request should be turned away now rather than wait behind it.
 */
class RenderGate {
	readonly #limit: number;
	readonly #queueLimit: number;
	#active = 0;
	readonly #waiting: (() => void)[] = [];

	constructor(limit: number, queueLimit: number) {
		this.#limit = limit;
		this.#queueLimit = queueLimit;
	}

	acquire(): Promise<() => void> | undefined {
		if (this.#active < this.#limit) {
			this.#active++;
			return Promise.resolve(this.#releaser());
		}
		if (this.#waiting.length >= this.#queueLimit) return undefined;
		return new Promise((resolve) => {
			this.#waiting.push(() => resolve(this.#releaser()));
		});
	}

	#releaser(): () => void {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const next = this.#waiting.shift();
			// The slot passes straight to the next in line, so `#active`
			// only drops when nobody is waiting.
			if (next !== undefined) next();
			else this.#active--;
		};
	}
}

/**
 * Rendered variants kept in memory, least recently used dropped first.
 *
 * The default when no `cacheDir` is configured: without any cache, every
 * request for the same variant is a fresh decode and encode.
 */
class MemoryCache {
	readonly #limit: number;
	#bytes = 0;
	readonly #entries = new Map<string, Buffer>();

	constructor(limit: number) {
		this.#limit = limit;
	}

	get(key: string): Buffer | undefined {
		const hit = this.#entries.get(key);
		if (hit === undefined) return undefined;
		this.#entries.delete(key);
		this.#entries.set(key, hit);
		return hit;
	}

	set(key: string, bytes: Buffer): void {
		if (bytes.length > this.#limit || this.#entries.has(key)) return;
		while (this.#bytes + bytes.length > this.#limit) {
			const oldest = this.#entries.entries().next();
			if (oldest.done === true) break;
			this.#entries.delete(oldest.value[0]);
			this.#bytes -= oldest.value[1].length;
		}
		this.#entries.set(key, bytes);
		this.#bytes += bytes.length;
	}
}

interface ImageRequest {
	header(name: string): string | undefined;
	qs?(): Record<string, unknown>;
}
interface ImageResponse {
	status(code: number): ImageResponse;
	header(name: string, value: string): ImageResponse;
	type(type: string, charset?: string): ImageResponse;
	json(data: unknown): void;
	sendBuffer(buffer: Buffer): void;
}
export interface ImageHttpContext {
	request: ImageRequest;
	response: ImageResponse;
}
export interface ImageRouter {
	get(
		path: string,
		handler: (ctx: ImageHttpContext) => Promise<void> | void,
	): unknown;
}

/**
 * A query parameter read as a plain decimal integer.
 *
 * `Number()` alone accepts `0x190`, `4e2`, `400.0` and ` 400`, all of which
 * become 400 and all of which pass an allow-list check. Nothing breaks today —
 * they collapse to the same cache entry — but "the allow-list is the bound" is
 * the property this endpoint rests on, and it should be true of the string a
 * caller sent, not only of what parsing happened to make of it.
 */
function integerParam(request: ImageRequest, name: string): number | undefined {
	const raw = queryParam(request, name);
	if (raw === undefined || !/^[0-9]{1,9}$/.test(raw)) return undefined;
	return Number(raw);
}

function queryParam(request: ImageRequest, name: string): string | undefined {
	const qs = request.qs?.();
	if (qs === undefined) return undefined;
	const value = qs[name];
	return typeof value === "string" ? value : undefined;
}

/**
 * The file a `src` names, or `undefined` when it names nothing reachable.
 *
 * Two independent checks, because each catches what the other misses. The
 * literal one rejects the obvious traversal before any filesystem call; the
 * prefix check on the resolved path is what actually holds, and catches the
 * encodings nobody thought of. A `src` reaching outside is not an error worth
 * distinguishing from a missing file — telling them apart is how a caller maps
 * the disk.
 */
async function resolveSource(
	src: string,
	roots: readonly string[],
): Promise<string | undefined> {
	// A NUL truncates the path in some syscalls, so the name checked is not
	// the name opened.
	if (src.length === 0 || src.includes("\0")) return undefined;
	// Absolute or scheme-prefixed: the caller is choosing the root, which is
	// exactly what roots exist to prevent.
	if (isAbsolute(src) || /^[a-z][a-z0-9+.-]*:/i.test(src)) return undefined;

	for (const root of roots) {
		const candidate = resolvePath(join(root, src));
		if (candidate !== root && !candidate.startsWith(root + sep)) continue;
		try {
			const info = await stat(candidate);
			if (info.isFile()) return candidate;
		} catch {
			// Not in this root; try the next.
		}
	}
	return undefined;
}

/**
 * The identity of a rendered variant.
 *
 * Includes the source's size and mtime so replacing a file on disk invalidates
 * every variant of it without anyone clearing a cache — the URL never changes,
 * so nothing else would.
 */
function variantKey(input: {
	path: string;
	size: number;
	mtimeMs: number;
	width: number;
	format: ImageFormat;
	quality: number;
}): string {
	return createHash("sha256")
		.update(
			[
				input.path,
				input.size,
				input.mtimeMs,
				input.width,
				input.format,
				input.quality,
			].join("\u0000"),
		)
		.digest("hex")
		.slice(0, 32);
}

/**
 * What each source version is, so a source is read and identified once per
 * version rather than once per request. Bounded: one entry per file version,
 * the oldest dropped first.
 */
const described = new Map<string, SourceInfo>();
const DESCRIBED_ENTRIES = 1024;

async function describe(
	images: Prism,
	file: string,
	info: { size: number; mtimeMs: number },
): Promise<SourceInfo> {
	const id = [file, info.size, info.mtimeMs].join("\u0000");
	const known = described.get(id);
	if (known !== undefined) return known;
	// Header only: `inspect` never decodes pixels, AVIF included.
	const meta = images.inspect(await readFile(file));
	const source: SourceInfo = {
		format: meta.format,
		width: meta.width,
		orientedWidth: meta.orientedWidth,
	};
	if (described.size >= DESCRIBED_ENTRIES) {
		const oldest = described.keys().next();
		if (oldest.done !== true) described.delete(oldest.value);
	}
	described.set(id, source);
	return source;
}

/**
 * Renders in flight, so a cold cache under load decodes once.
 *
 * Ten `<source>` elements on a page all resolve at once; without this, the
 * first visit to a page decodes the same image ten times in parallel and each
 * one writes the result.
 */
const inFlight = new Map<string, Promise<Buffer>>();

async function readCached(
	cacheDir: string | undefined,
	key: string,
): Promise<Buffer | undefined> {
	if (cacheDir === undefined) return undefined;
	try {
		return await readFile(join(cacheDir, key));
	} catch {
		return undefined;
	}
}

async function writeCached(
	cacheDir: string | undefined,
	key: string,
	bytes: Buffer,
): Promise<void> {
	if (cacheDir === undefined) return;
	try {
		await mkdir(cacheDir, { recursive: true });
		// Write then rename: a reader that opens the file mid-write otherwise
		// gets a truncated image, and a truncated image is cached forever.
		const temporary = join(cacheDir, `${key}.${process.pid}.tmp`);
		await writeFile(temporary, bytes);
		await rename(temporary, join(cacheDir, key));
	} catch {
		// A cache that cannot be written is slow, not broken.
	}
}

/**
 * Render one variant.
 *
 * `fit: "inside"` is what enforces "never upscale" — the engine returns the
 * image untouched when it is already smaller than the target, so asking for a
 * 2560px variant of an 800px source costs one decode and yields 800px rather
 * than a soft enlargement.
 */
function render(
	images: Prism,
	bytes: Buffer,
	width: number,
	format: ImageFormat,
	quality: number,
	effort: number,
): Promise<Buffer> {
	return images
		.edit(bytes)
		.resize({ width, fit: "inside" })
		.toBuffer({ format, quality, effort });
}

/**
 * What a source is, read from its header, or `undefined` when the engine
 * does not recognise it as an image at all.
 */
interface SourceInfo {
	format: string;
	width: number;
	/** The width after the EXIF orientation, which the pipeline applies. */
	orientedWidth: number;
}

/**
 * Engine refusals that mean "this is not an image" rather than "this image
 * cannot be served". Answered like a missing file: a root is for images, and
 * telling a `.env` from an absent file is how a caller maps one.
 */
const NOT_AN_IMAGE = new Set(["E_PRISM_UNKNOWN_FORMAT", "E_PRISM_EMPTY_INPUT"]);

function isNotAnImage(error: unknown): boolean {
	return error instanceof PrismError && NOT_AN_IMAGE.has(error.code);
}

/**
 * Headers on EVERY answer, the refusals included.
 *
 * The bytes are always an image the engine wrote, but the route is on the
 * application's origin: nothing it answers may run script there or be
 * sniffed into something that does.
 */
function harden(response: ImageResponse): void {
	response
		.header("content-security-policy", "default-src 'none'; sandbox")
		.header("x-content-type-options", "nosniff");
}

/**
 * Mount the endpoint.
 *
 * Returns whatever the router returns for the route, so a caller can apply its
 * own middleware — an image behind authentication is a normal thing to want.
 */
export function registerImageRoute(
	router: ImageRouter,
	images: Prism,
	config: ImageServingConfig,
): unknown {
	const settings = resolveConfig(config, images);
	const gate = new RenderGate(settings.concurrency, settings.queueLimit);
	const memory =
		settings.cacheDir === undefined && settings.memoryCacheBytes > 0
			? new MemoryCache(settings.memoryCacheBytes)
			: undefined;

	return router.get(settings.path, async (ctx) => {
		harden(ctx.response);
		const fail = (status: number, code: string, message: string): void => {
			ctx.response
				// A refusal is about this file at this moment; a cached one
				// would outlive the fix.
				.header("cache-control", "no-store")
				.status(status)
				.json({ error: { code, message } });
		};
		const notFound = (): void =>
			fail(404, "E_PRISM_IMAGE_NOT_FOUND", "no such image");
		const unprocessable = (): void =>
			fail(
				422,
				"E_PRISM_IMAGE_UNPROCESSABLE",
				"the source is not an image this endpoint can serve",
			);

		const src = queryParam(ctx.request, "src");
		if (src === undefined) {
			fail(400, "E_PRISM_IMAGE_NO_SOURCE", "src is required");
			return;
		}

		const width = integerParam(ctx.request, "w");
		if (width === undefined || !settings.widths.has(width)) {
			fail(
				400,
				"E_PRISM_IMAGE_WIDTH_NOT_ALLOWED",
				"w must be one of the configured widths",
			);
			return;
		}

		const rawFormat = queryParam(ctx.request, "f");
		if (
			rawFormat !== undefined &&
			(!isEncodable(rawFormat) || !settings.formats.has(rawFormat))
		) {
			fail(
				400,
				"E_PRISM_IMAGE_FORMAT_NOT_ALLOWED",
				"f must be one of the configured formats",
			);
			return;
		}
		const format =
			rawFormat !== undefined && isEncodable(rawFormat) ? rawFormat : undefined;

		const rawQuality = queryParam(ctx.request, "q");
		const quality =
			rawQuality === undefined
				? settings.quality
				: integerParam(ctx.request, "q");
		if (
			quality === undefined ||
			(rawQuality !== undefined && !settings.qualities.has(quality))
		) {
			fail(
				400,
				"E_PRISM_IMAGE_QUALITY_NOT_ALLOWED",
				"q must be one of the configured qualities",
			);
			return;
		}

		const file = await resolveSource(src, settings.roots);
		if (file === undefined) {
			notFound();
			return;
		}

		const info = await stat(file);
		// Refused before reading: the engine would refuse it anyway, after
		// the whole file had been pulled into memory.
		if (info.size > settings.maxBytes) {
			unprocessable();
			return;
		}

		let source: SourceInfo;
		try {
			source = await describe(images, file, info);
		} catch (error) {
			if (isNotAnImage(error)) notFound();
			else unprocessable();
			return;
		}
		// No format asked for: re-encode into whatever the source IS — read
		// from its content, never from its name.
		let output = format;
		if (output === undefined) {
			if (!isEncodable(source.format)) {
				unprocessable();
				return;
			}
			output = source.format;
		}
		// The width the variant will really have. `inside` never enlarges, so
		// 3200, 3840 and 5120 of a 3000px source are one image — and one
		// render, not three.
		const effectiveWidth = Math.min(
			width,
			settings.autoOrient ? source.orientedWidth : source.width,
		);

		const key = variantKey({
			path: file,
			size: info.size,
			mtimeMs: info.mtimeMs,
			width: effectiveWidth,
			format: output,
			quality,
		});
		const etag = `"${key}"`;

		// Answered before any read: a browser revalidating fifteen variants of
		// one image should cost fifteen header comparisons.
		if (ctx.request.header("if-none-match") === etag) {
			ctx.response
				.header("etag", etag)
				.header("cache-control", `public, max-age=${settings.maxAge}`)
				.status(304)
				.sendBuffer(Buffer.alloc(0));
			return;
		}

		const target = output;
		let bytes = memory?.get(key) ?? (await readCached(settings.cacheDir, key));
		if (bytes === undefined) {
			let work = inFlight.get(key);
			if (work === undefined) {
				const slot = gate.acquire();
				if (slot === undefined) {
					ctx.response.header("retry-after", "2");
					fail(
						503,
						"E_PRISM_IMAGE_BUSY",
						"too many images are being rendered; retry shortly",
					);
					return;
				}
				work = (async (): Promise<Buffer> => {
					const release = await slot;
					try {
						const rendered = await render(
							images,
							await readFile(file),
							effectiveWidth,
							target,
							quality,
							settings.effort,
						);
						memory?.set(key, rendered);
						await writeCached(settings.cacheDir, key, rendered);
						return rendered;
					} finally {
						release();
					}
				})();
				const settled = work.finally(() => inFlight.delete(key));
				// Every waiter handles the rejection itself; this copy only
				// clears the slot.
				settled.catch(() => undefined);
				inFlight.set(key, work);
			}
			try {
				bytes = await work;
			} catch (error) {
				// No passthrough. What leaves this route is something the
				// engine re-encoded, or nothing: the original of a file that
				// failed to render is exactly the file nobody vetted.
				if (isNotAnImage(error)) notFound();
				else unprocessable();
				return;
			}
		}

		ctx.response
			.type(`image/${target}`)
			.header("etag", etag)
			// `immutable` because the key covers the source's mtime: an edited
			// file produces a different key, so nothing a browser holds can
			// ever be stale.
			.header("cache-control", `public, max-age=${settings.maxAge}, immutable`)
			.sendBuffer(bytes);
	});
}
