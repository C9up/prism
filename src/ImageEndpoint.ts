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
 * qualities), which is a number the operator chose — per version of each
 * file, and the disk cache keeps only the current version's. A request outside the
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
import { constants, type Stats } from "node:fs";
import {
	type FileHandle,
	lstat,
	mkdir,
	open,
	readdir,
	readFile,
	readlink,
	realpath,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import {
	isAbsolute,
	join,
	relative,
	resolve as resolvePath,
	sep,
} from "node:path";
import { Exception } from "@c9up/flare";
import { E_PRISM_INVALID_SERVE_CONFIG } from "./errors.js";
import { Gate } from "./gate.js";
import { openedPathNative } from "./native.js";
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
	maxCacheBytes: number;
	maxAge: number;
	cacheControl: "public" | "private" | false;
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
		throw new E_PRISM_INVALID_SERVE_CONFIG([
			`images.serve.${name} must be an integer from ${minimum} to ${maximum}, got ${value}.`,
		]);
	}
	return value;
}

/** Who may store an answer, refused at mount when it is not a known value. */
function cacheScope(
	value: ImageServingConfig["cacheControl"],
): "public" | "private" | false {
	if (value === undefined) return "public";
	if (value === "public" || value === "private" || value === false) {
		return value;
	}
	throw new E_PRISM_INVALID_SERVE_CONFIG([
		`images.serve.cacheControl must be "public", "private" or false, got ${String(value)}.`,
	]);
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
		maxCacheBytes: count(
			"maxCacheBytes",
			config.maxCacheBytes ?? 1024 * 1024 * 1024,
			0,
		),
		maxAge: config.maxAge ?? 31_536_000,
		cacheControl: cacheScope(config.cacheControl),
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

/** Is `path` the directory `root` or inside it? Both already resolved. */
function within(root: string, path: string): boolean {
	return path === root || path.startsWith(root + sep);
}

/**
 * The file a `src` names, or `undefined` when it names nothing reachable.
 *
 * Three checks, because each catches what the others miss. The literal one
 * rejects the obvious traversal before any filesystem call; the prefix check
 * on the resolved path catches the encodings nobody thought of; and the same
 * check on the REAL path catches a symbolic link — planted by an archive
 * extracted into an upload directory, a shared volume, a careless deploy —
 * that is inside a root by name and anywhere on the disk by target.
 *
 * A checked path is still only a name: whoever can write in the root can swap
 * the file, or a directory above it, for a link between the check and the
 * read. So the source comes back OPEN, its confinement is checked on that
 * handle, and every later read goes through it. A `src` reaching outside is
 * not an error worth distinguishing from a missing file — telling them apart
 * is how a caller maps the disk.
 */
async function resolveSource(
	src: string,
	roots: readonly string[],
): Promise<OpenedSource | undefined> {
	// `/photos/hero.png` is how a page names a public file, and Next's image
	// optimizer takes it as such: one leading slash is read as "under the
	// roots". Exactly one — `//host/a.png` is a protocol-relative URL, and
	// stays refused as one.
	if (src.startsWith("/") && !src.startsWith("//")) src = src.slice(1);
	// A NUL truncates the path in some syscalls, so the name checked is not
	// the name opened.
	if (src.length === 0 || src.includes("\0")) return undefined;
	// Absolute or scheme-prefixed: the caller is choosing the root, which is
	// exactly what roots exist to prevent.
	if (isAbsolute(src) || /^[a-z][a-z0-9+.-]*:/i.test(src)) return undefined;

	for (const root of roots) {
		const candidate = resolvePath(join(root, src));
		if (!within(root, candidate)) continue;
		let handle: FileHandle | undefined;
		try {
			// The root's own real path too: a root that is itself a link
			// (a release directory, a mounted volume) is legitimate.
			const [realRoot, real] = await Promise.all([
				realpath(root),
				realpath(candidate),
			]);
			if (!within(realRoot, real)) continue;
			handle = await open(real, OPEN_SOURCE);
			const info = await handle.stat();
			if (
				info.isFile() &&
				(await openedWithin(handle, realRoot, candidate, real))
			) {
				return { path: real, handle, info };
			}
		} catch {
			// Not in this root; try the next.
		}
		await handle?.close().catch(() => undefined);
	}
	return undefined;
}

/**
 * Read-only, never through a link at the last segment (a swapped file fails
 * the open), and without blocking on a FIFO someone left in a root.
 */
const OPEN_SOURCE =
	constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** A source as it was checked: its real path and the handle all reads use. */
interface OpenedSource {
	path: string;
	handle: FileHandle;
	info: Stats;
}

/**
 * Is the file behind `handle` inside `realRoot`?
 *
 * Asked of the handle, not of the name: a directory above the file swapped
 * for a link after `realpath` is walked through by `open` whatever its flags.
 * Linux names the file an open descriptor refers to in `/proc/self/fd`;
 * macOS and Windows name it through the engine (`F_GETPATH`, the handle's
 * final path). Either settles it, and a file moved after the open is judged
 * where it is now. Where neither can answer, the path is resolved again and
 * must still be the checked one and the same inode as the handle — which
 * refuses a source whose path changed at all, rather than guess.
 */
async function openedWithin(
	handle: FileHandle,
	realRoot: string,
	candidate: string,
	real: string,
): Promise<boolean> {
	const located = (await procfsPath(handle)) ?? openedPathNative(handle.fd);
	if (located !== undefined) return within(realRoot, located);
	const again = await realpath(candidate);
	if (again !== real) return false;
	const [now, opened] = await Promise.all([
		stat(again, { bigint: true }),
		handle.stat({ bigint: true }),
	]);
	return now.dev === opened.dev && now.ino === opened.ino;
}

/**
 * What `/proc/self/fd` names the handle, or `undefined` without procfs.
 *
 * Linux only. Elsewhere `/proc` is an ordinary path, and on Windows
 * `C:\proc\self\fd\3` is a folder any local account may create and fill
 * with a junction answering whatever it likes.
 */
async function procfsPath(handle: FileHandle): Promise<string | undefined> {
	if (process.platform !== "linux") return undefined;
	try {
		return await readlink(`/proc/self/fd/${handle.fd}`);
	} catch {
		return undefined;
	}
}

/** The whole of an open source. Only ever called inside the render gate. */
function readSource(source: OpenedSource): Promise<Buffer> {
	return readHead(source, source.info.size);
}

/**
 * The first `limit` bytes of an open source (fewer when it is shorter), read
 * by position so every read of the same handle starts at its beginning.
 */
async function readHead(source: OpenedSource, limit: number): Promise<Buffer> {
	const size = Math.min(source.info.size, limit);
	const buffer = Buffer.alloc(size);
	let filled = 0;
	while (filled < size) {
		const { bytesRead } = await source.handle.read(
			buffer,
			filled,
			size - filled,
			filled,
		);
		if (bytesRead === 0) break;
		filled += bytesRead;
	}
	return buffer.subarray(0, filled);
}

/**
 * How much of a source its format is identified from. Every signature the
 * engine recognises sits in the first few dozen bytes.
 */
const SIGNATURE_BYTES = 64;

/**
 * Whether the first bytes of a source identify it as an image, for a source
 * too large to read whole. Anything but "this is not an image" counts as one:
 * a truncated header, a format the application does not allow.
 */
async function isSignedAsImage(
	images: Prism,
	source: OpenedSource,
	maxBytes: number,
): Promise<boolean> {
	const head = Buffer.alloc(Math.min(SIGNATURE_BYTES, maxBytes));
	const { bytesRead } = await source.handle.read(head, 0, head.length, 0);
	try {
		images.inspect(head.subarray(0, bytesRead));
	} catch (error) {
		return !isNotAnImage(error);
	}
	return true;
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
 * How much of a source is read, outside the render gate, to identify it.
 *
 * A source no larger than this is identified from all of it. A larger one is
 * identified from all of it too, but inside the gate: a header alone does not
 * reliably carry the answer — a JPEG's EXIF orientation and frame header can
 * sit behind large APP segments, a TIFF's first directory anywhere in the
 * file — and a wrong orientation would render the wrong width. What the head
 * of a larger source does settle on its own is the signature: "not an image"
 * and "a format this application refuses" are read from the first bytes.
 */
const HEAD_BYTES = 64 * 1024;

/** What a source version turned out to be. */
type Description =
	| { kind: "image"; source: SourceInfo }
	| { kind: "refused"; notAnImage: boolean };

/**
 * Engine refusals that depend only on the bytes of a source version, and so
 * are remembered like a success. Anything else — a panic, a missing engine —
 * says nothing about the file and is answered without being kept.
 */
const SETTLED_REFUSALS = new Set([
	"E_PRISM_EMPTY_INPUT",
	"E_PRISM_UNKNOWN_FORMAT",
	"E_PRISM_UNSUPPORTED_FORMAT",
	"E_PRISM_FORMAT_NOT_ALLOWED",
	"E_PRISM_INPUT_TOO_LARGE",
	"E_PRISM_TOO_MANY_PIXELS",
	"E_PRISM_MEMORY_LIMIT",
	"E_PRISM_ZERO_DIMENSION",
	"E_PRISM_UNREADABLE",
	"E_PRISM_DECODE_FAILED",
]);

/** Refusals a source's first bytes are enough to settle. */
const SIGNATURE_REFUSALS = new Set([
	"E_PRISM_EMPTY_INPUT",
	"E_PRISM_UNKNOWN_FORMAT",
	"E_PRISM_FORMAT_NOT_ALLOWED",
]);

/** The engine's answer about `bytes`, as something the catalogue can keep. */
function identify(images: Prism, bytes: Buffer): Description {
	try {
		const meta = images.inspect(bytes);
		return {
			kind: "image",
			source: {
				format: meta.format,
				width: meta.width,
				orientedWidth: meta.orientedWidth,
			},
		};
	} catch (error) {
		if (hasCode(error, SETTLED_REFUSALS)) {
			return { kind: "refused", notAnImage: isNotAnImage(error) };
		}
		throw error;
	}
}

/**
 * What each source version is, so a source is read and identified once per
 * version rather than once per request — a refusal included, or a video in a
 * root would be read again by every request naming it.
 *
 * One per mounted route: what a route refuses depends on its engine's
 * configuration, and another route's engine may accept it.
 */
class SourceCatalogue {
	/** Bounded: one entry per file version, the oldest dropped first. */
	static readonly ENTRIES = 1024;

	readonly #images: Prism;
	readonly #gate: Gate;
	readonly #entries = new Map<string, Description>();
	/** Identifications in flight, so N requests at once read the source once. */
	readonly #pending = new Map<string, Promise<Description | undefined>>();

	constructor(images: Prism, gate: Gate) {
		this.#images = images;
		this.#gate = gate;
	}

	/**
	 * What `file` is, or `undefined` when identifying it needs the gate and
	 * the gate's queue is full.
	 */
	async describe(file: OpenedSource): Promise<Description | undefined> {
		const id = [file.path, file.info.size, file.info.mtimeMs].join("\u0000");
		const known = this.#entries.get(id);
		if (known !== undefined) return known;
		let pending = this.#pending.get(id);
		if (pending === undefined) {
			pending = this.#identify(file).then((description) => {
				if (description !== undefined) this.#remember(id, description);
				return description;
			});
			const settled = pending.finally(() => this.#pending.delete(id));
			// Every waiter handles the rejection itself; this copy only clears
			// the slot.
			settled.catch(() => undefined);
			this.#pending.set(id, pending);
		}
		return pending;
	}

	async #identify(file: OpenedSource): Promise<Description | undefined> {
		const head = await readHead(file, HEAD_BYTES);
		if (head.length >= file.info.size) return identify(this.#images, head);
		try {
			this.#images.inspect(head);
		} catch (error) {
			if (hasCode(error, SIGNATURE_REFUSALS)) {
				return { kind: "refused", notAnImage: isNotAnImage(error) };
			}
		}
		// An image, or something the head cannot settle: the whole file, read
		// where `concurrency` x `maxBytes` bounds what reads hold at once.
		const slot = this.#gate.acquire();
		if (slot === undefined) return undefined;
		const release = await slot;
		try {
			return identify(this.#images, await readSource(file));
		} finally {
			release();
		}
	}

	#remember(id: string, description: Description): void {
		if (this.#entries.size >= SourceCatalogue.ENTRIES) {
			const oldest = this.#entries.keys().next();
			if (oldest.done !== true) this.#entries.delete(oldest.value);
		}
		this.#entries.set(id, description);
	}
}

/**
 * Renders in flight, so a cold cache under load decodes once.
 *
 * Ten `<source>` elements on a page all resolve at once; without this, the
 * first visit to a page decodes the same image ten times in parallel and each
 * one writes the result.
 */
const inFlight = new Map<string, Promise<Buffer>>();

/**
 * Where a variant lives on disk.
 *
 * One directory per source, and every file in it named after the source
 * VERSION it was rendered from. The key already changes when the file behind
 * a URL changes; what this layout adds is that the previous version's
 * variants can be found, and are deleted when the new one is written — an
 * avatar re-uploaded at the same path otherwise leaves every variant of
 * every past upload on disk, forever.
 */
interface DiskSlot {
	directory: string;
	version: string;
	file: string;
	/** The source's real path, recorded in its directory for the sweep. */
	source: string;
}

function hash(parts: readonly (string | number)[], length: number): string {
	return createHash("sha256")
		.update(parts.join("\u0000"))
		.digest("hex")
		.slice(0, length);
}

/**
 * The file in each source directory that names the source, so a sweep can
 * tell the directory of a deleted file. Not a variant name: those start with
 * a hexadecimal version.
 */
const SOURCE_MARKER = ".source";

/**
 * Rendered variants on disk, bounded.
 *
 * Keyed by source path, a directory outlives a source that is deleted or
 * renamed: an application that stores each upload under a fresh name and
 * deletes the previous one would grow the cache by a full set of variants per
 * upload. So a source found missing loses its directory, and past
 * `maxCacheBytes` a sweep drops the directories of sources that no longer
 * exist, then the oldest variants, until the cache is back under nine tenths
 * of the bound.
 */
class DiskCache {
	readonly #root: string;
	readonly #limit: number;
	/** Bytes on disk as last measured plus what was written since. */
	#bytes: number | undefined;
	#sweeping: Promise<void> | undefined;

	constructor(root: string, limit: number) {
		this.#root = root;
		this.#limit = limit;
	}

	slot(
		source: { path: string; size: number; mtimeMs: number },
		key: string,
	): DiskSlot {
		const directory = this.#directoryOf(source.path);
		const version = hash([source.size, source.mtimeMs], 16);
		return {
			directory,
			version,
			file: join(directory, `${version}-${key}`),
			source: source.path,
		};
	}

	async read(slot: DiskSlot): Promise<Buffer | undefined> {
		try {
			return await readFile(slot.file);
		} catch {
			return undefined;
		}
	}

	async write(slot: DiskSlot, bytes: Buffer): Promise<void> {
		// Write then rename: a reader that opens the file mid-write otherwise
		// gets a truncated image, and a truncated image is cached forever.
		const temporary = `${slot.file}.${process.pid}.tmp`;
		try {
			await mkdir(slot.directory, { recursive: true });
			await writeFile(join(slot.directory, SOURCE_MARKER), slot.source);
			await writeFile(temporary, bytes);
			await rename(temporary, slot.file);
		} catch {
			// A cache that cannot be written is slow, not broken — but it must
			// not keep the half it did write.
			await unlink(temporary).catch(() => undefined);
			return;
		}
		const pruned = await this.#pruneVersions(slot);
		if (this.#bytes !== undefined) this.#bytes += bytes.length - pruned;
		if (
			this.#limit > 0 &&
			(this.#bytes ?? Number.POSITIVE_INFINITY) > this.#limit
		) {
			await this.#sweep();
		}
	}

	/** Drop the directory of `path` when no file is there any more. */
	async forget(path: string): Promise<void> {
		try {
			await lstat(path);
			return;
		} catch {
			// Gone: its variants can never be served again.
		}
		await rm(this.#directoryOf(path), { recursive: true, force: true }).catch(
			() => undefined,
		);
	}

	#directoryOf(path: string): string {
		return join(this.#root, hash([path], 32));
	}

	/**
	 * Delete what an earlier version of the source left in its directory.
	 * The bytes deleted.
	 */
	async #pruneVersions(slot: DiskSlot): Promise<number> {
		let entries: string[];
		try {
			entries = await readdir(slot.directory);
		} catch {
			return 0;
		}
		const current = `${slot.version}-`;
		const sizes = await Promise.all(
			entries
				.filter((name) => name !== SOURCE_MARKER && !name.startsWith(current))
				.map((name) => removeFile(join(slot.directory, name))),
		);
		return sizes.reduce((total, size) => total + size, 0);
	}

	/** One sweep at a time; a write that finds one running leaves it be. */
	#sweep(): Promise<void> {
		this.#sweeping ??= this.#measureAndTrim().finally(() => {
			this.#sweeping = undefined;
		});
		return this.#sweeping;
	}

	async #measureAndTrim(): Promise<void> {
		let directories: string[];
		try {
			directories = await readdir(this.#root);
		} catch {
			return;
		}
		const variants: { file: string; size: number; mtimeMs: number }[] = [];
		for (const name of directories) {
			const directory = join(this.#root, name);
			if (await orphaned(directory)) {
				await rm(directory, { recursive: true, force: true }).catch(
					() => undefined,
				);
				continue;
			}
			let files: string[];
			try {
				files = await readdir(directory);
			} catch {
				continue;
			}
			for (const file of files) {
				if (file === SOURCE_MARKER) continue;
				try {
					const info = await stat(join(directory, file));
					variants.push({
						file: join(directory, file),
						size: info.size,
						mtimeMs: info.mtimeMs,
					});
				} catch {
					// Deleted meanwhile.
				}
			}
		}
		let total = variants.reduce((sum, variant) => sum + variant.size, 0);
		const target = Math.floor(this.#limit * 0.9);
		variants.sort((a, b) => a.mtimeMs - b.mtimeMs);
		for (const variant of variants) {
			if (total <= target) break;
			total -= await removeFile(variant.file);
		}
		this.#bytes = total;
	}
}

/** Delete a file; the bytes it held, 0 when it was already gone. */
async function removeFile(file: string): Promise<number> {
	try {
		const { size } = await stat(file);
		await unlink(file);
		return size;
	} catch {
		return 0;
	}
}

/** Whether a source directory's source no longer exists. */
async function orphaned(directory: string): Promise<boolean> {
	let source: string;
	try {
		source = await readFile(join(directory, SOURCE_MARKER), "utf8");
	} catch {
		// No record: a directory this layout did not write, or one whose
		// first write failed half-way. Neither can be served.
		return true;
	}
	try {
		await lstat(source);
		return false;
	} catch {
		return true;
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
	return hasCode(error, NOT_AN_IMAGE);
}

/** Whether `error` is a coded error whose code is one of `codes`. */
function hasCode(error: unknown, codes: ReadonlySet<string>): boolean {
	return (
		error instanceof Exception &&
		error.code !== undefined &&
		codes.has(error.code)
	);
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
 * What `src` would name under each root, as the real path a source there
 * would have — so the cache directory of a source that is gone can be found.
 */
async function namedPaths(
	src: string,
	roots: readonly string[],
): Promise<string[]> {
	if (src.startsWith("/") && !src.startsWith("//")) src = src.slice(1);
	if (src.length === 0 || src.includes("\0") || isAbsolute(src)) return [];
	const paths: string[] = [];
	for (const root of roots) {
		const candidate = resolvePath(join(root, src));
		if (!within(root, candidate)) continue;
		try {
			paths.push(join(await realpath(root), relative(root, candidate)));
		} catch {
			// A root that does not exist holds no source.
		}
	}
	return paths;
}

/**
 * Variants whose render was refused for a reason the source's bytes settle,
 * so a refused file is not decoded again by every request naming it. Keyed by
 * variant, since one width can fit the memory limit where another does not;
 * the key covers the source version, so replacing the file clears it.
 */
class RefusedRenders {
	static readonly ENTRIES = 1024;
	readonly #entries = new Map<string, boolean>();

	/** `true` when the refusal was "not an image", `undefined` when none. */
	get(key: string): boolean | undefined {
		return this.#entries.get(key);
	}

	remember(key: string, notAnImage: boolean): void {
		if (this.#entries.size >= RefusedRenders.ENTRIES) {
			const oldest = this.#entries.keys().next();
			if (oldest.done !== true) this.#entries.delete(oldest.value);
		}
		this.#entries.set(key, notAnImage);
	}
}

/**
 * Mount the endpoint.
 *
 * Returns whatever the router returns for the route, so a caller can apply its
 * own middleware — an image behind authentication is a normal thing to want.
 * Such a route must not answer `public` (the default): a shared cache in
 * front of the application may store the image and serve it to anyone. Set
 * `cacheControl: "private"` for it.
 */
export function registerImageRoute(
	router: ImageRouter,
	images: Prism,
	config: ImageServingConfig,
): unknown {
	const settings = resolveConfig(config, images);
	const gate = new Gate(settings.concurrency, settings.queueLimit);
	const catalogue = new SourceCatalogue(images, gate);
	const memory =
		settings.cacheDir === undefined && settings.memoryCacheBytes > 0
			? new MemoryCache(settings.memoryCacheBytes)
			: undefined;
	const disk =
		settings.cacheDir === undefined
			? undefined
			: new DiskCache(settings.cacheDir, settings.maxCacheBytes);
	const refused = new RefusedRenders();
	const cacheControl = (directives: string): string | undefined =>
		settings.cacheControl === false
			? undefined
			: `${settings.cacheControl}, ${directives}`;

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
		const busy = (): void => {
			ctx.response.header("retry-after", "2");
			fail(
				503,
				"E_PRISM_IMAGE_BUSY",
				"too many images are being rendered; retry shortly",
			);
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
			if (disk !== undefined) {
				for (const path of await namedPaths(src, settings.roots)) {
					await disk.forget(path);
				}
			}
			notFound();
			return;
		}
		// Closed whatever the answer: every read below goes through it.
		try {
			const info = file.info;
			// Refused before reading: the engine would refuse it anyway, after
			// the whole file had been pulled into memory. Its signature is
			// still read first, because a non-image is answered like a missing
			// file whatever its size — a 422 for a large one alone would tell
			// a caller it is there.
			if (info.size > settings.maxBytes) {
				if (await isSignedAsImage(images, file, settings.maxBytes)) {
					unprocessable();
				} else {
					notFound();
				}
				return;
			}

			let description: Description | undefined;
			try {
				description = await catalogue.describe(file);
			} catch {
				unprocessable();
				return;
			}
			if (description === undefined) {
				busy();
				return;
			}
			if (description.kind === "refused") {
				if (description.notAnImage) notFound();
				else unprocessable();
				return;
			}
			const source = description.source;
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
				path: file.path,
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
				const scope = cacheControl(`max-age=${settings.maxAge}`);
				if (scope !== undefined) ctx.response.header("cache-control", scope);
				ctx.response
					.header("etag", etag)
					.status(304)
					.sendBuffer(Buffer.alloc(0));
				return;
			}

			const known = refused.get(key);
			if (known !== undefined) {
				if (known) notFound();
				else unprocessable();
				return;
			}

			const target = output;
			const onDisk = disk?.slot(
				{ path: file.path, size: info.size, mtimeMs: info.mtimeMs },
				key,
			);
			let bytes =
				memory?.get(key) ??
				(onDisk === undefined ? undefined : await disk?.read(onDisk));
			if (bytes === undefined) {
				let work = inFlight.get(key);
				if (work === undefined) {
					const slot = gate.acquire();
					if (slot === undefined) {
						busy();
						return;
					}
					work = (async (): Promise<Buffer> => {
						const release = await slot;
						try {
							const rendered = await render(
								images,
								await readSource(file),
								effectiveWidth,
								target,
								quality,
								settings.effort,
							);
							memory?.set(key, rendered);
							if (onDisk !== undefined) await disk?.write(onDisk, rendered);
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
					if (hasCode(error, SETTLED_REFUSALS)) {
						refused.remember(key, isNotAnImage(error));
					}
					if (isNotAnImage(error)) notFound();
					else unprocessable();
					return;
				}
			}

			// `immutable` because the key covers the source's mtime: an edited
			// file produces a different key, so nothing a browser holds can
			// ever be stale.
			const scope = cacheControl(`max-age=${settings.maxAge}, immutable`);
			if (scope !== undefined) ctx.response.header("cache-control", scope);
			ctx.response
				.type(`image/${target}`)
				.header("etag", etag)
				.sendBuffer(bytes);
		} finally {
			await file.handle.close().catch(() => undefined);
		}
	});
}
