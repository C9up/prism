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
 * Height and crop are deliberately absent. They are the two axes that cannot
 * be allow-listed without making the component unusable, and neither is needed
 * — a responsive image crops with `object-fit`, in the browser, for free.
 *
 * What comes back carries no EXIF. The engine re-encodes from decoded pixels
 * and metadata does not survive that, which is what keeps a holiday photo's
 * GPS coordinates out of a public thumbnail.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve as resolvePath, sep } from "node:path";
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
 * The same ladder `@c9up/nebula` generates from, so the default component and
 * the default endpoint agree without either being configured. Changing one
 * without the other is what makes every second image a 400.
 */
export const DEFAULT_WIDTHS: readonly number[] = [
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
	maxAge: number;
}

function resolveConfig(config: ImageServingConfig): ResolvedConfig {
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
		maxAge: config.maxAge ?? 31_536_000,
	};
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
	format: ImageFormat | undefined;
	quality: number;
}): string {
	return createHash("sha256")
		.update(
			[
				input.path,
				input.size,
				input.mtimeMs,
				input.width,
				input.format ?? "source",
				input.quality,
			].join("\u0000"),
		)
		.digest("hex")
		.slice(0, 32);
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

/** MIME type for an output format, or for bytes passed through untouched. */
function contentType(format: ImageFormat | undefined, source: string): string {
	if (format !== undefined) return `image/${format}`;
	const dot = source.lastIndexOf(".");
	const extension = dot === -1 ? "" : source.slice(dot + 1).toLowerCase();
	if (extension === "svg") return "image/svg+xml";
	if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
	return extension === "" ? "application/octet-stream" : `image/${extension}`;
}

/**
 * Render one variant.
 *
 * `fit: "inside"` is what enforces "never upscale" — the engine returns the
 * image untouched when it is already smaller than the target, so asking for a
 * 2560px variant of an 800px source costs one decode and yields 800px rather
 * than a soft enlargement.
 */
async function render(
	images: Prism,
	bytes: Buffer,
	width: number,
	format: ImageFormat | undefined,
	quality: number,
): Promise<Buffer> {
	const pipeline = images.edit(bytes).resize({ width, fit: "inside" });
	if (format === undefined) {
		// No format asked for: re-encode into whatever the source was. The
		// metadata read is also what tells us the source is decodable at all.
		const source = images.inspect(bytes).format;
		if (!isEncodable(source)) {
			throw new Error("source format cannot be re-encoded");
		}
		return pipeline.toFormat(source, quality);
	}
	return pipeline.toFormat(format, quality);
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
	const settings = resolveConfig(config);

	return router.get(settings.path, async (ctx) => {
		const fail = (status: number, code: string, message: string): void => {
			ctx.response.status(status).json({ error: { code, message } });
		};

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
			fail(404, "E_PRISM_IMAGE_NOT_FOUND", "no such image");
			return;
		}

		const info = await stat(file);
		const key = variantKey({
			path: file,
			size: info.size,
			mtimeMs: info.mtimeMs,
			width,
			format,
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

		let bytes = await readCached(settings.cacheDir, key);
		if (bytes === undefined) {
			const pending = inFlight.get(key);
			if (pending !== undefined) {
				bytes = await pending;
			} else {
				const work = (async (): Promise<Buffer> => {
					const source = await readFile(file);
					try {
						const rendered = await render(
							images,
							source,
							width,
							format,
							quality,
						);
						await writeCached(settings.cacheDir, key, rendered);
						return rendered;
					} catch {
						// Not decodable — an SVG, or a format the engine reads
						// but cannot write. Passing the original through is
						// right: it already passed the root check, and the
						// alternative is a broken image for a file that is
						// perfectly serveable as it stands.
						return source;
					}
				})();
				inFlight.set(key, work);
				try {
					bytes = await work;
				} finally {
					inFlight.delete(key);
				}
			}
		}

		ctx.response
			.type(contentType(format, file))
			.header("etag", etag)
			// `immutable` because the key covers the source's mtime: an edited
			// file produces a different key, so nothing a browser holds can
			// ever be stale.
			.header("cache-control", `public, max-age=${settings.maxAge}, immutable`)
			.sendBuffer(bytes);
	});
}
