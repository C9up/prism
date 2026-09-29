/**
 * QR codes — SVG first, and PNG, WebP or AVIF through Prism's encoders.
 *
 *   import { qrcode } from "@c9up/prism"
 *
 *   const svg = await qrcode.toString(uri)                          // SVG
 *   const png = await qrcode.toBuffer(uri, { width: 300 })          // PNG
 *   const src = await qrcode.toDataURL(uri, { type: "image/webp" })
 *
 * The shape is the npm `qrcode` package's (1.5.4, read from its tarball):
 * `toString`, `toBuffer` and `toDataURL`, the same options and defaults —
 * `errorCorrectionLevel` M, `margin` 4, `scale` 4, a `width` that wins once it
 * holds the symbol, `color.dark` / `color.light` in hex — and the same SVG,
 * so markup styled for one keeps working with the other.
 *
 * Named differences:
 *  - `toString` writes SVG only, and by default (upstream defaults to text
 *    art for a terminal, which a server has no use for);
 *  - WebP and AVIF on the server, which upstream only offers in a browser;
 *  - promises only, no callbacks;
 *  - invalid options are refused (`E_PRISM_INVALID_QR_OPTION`) where upstream
 *    quietly falls back — every one of them may come from a request.
 *
 * Styling takes the options of `qr-code-styling` (1.9.2, read from its
 * tarball), in its names — `dotsOptions`, `cornersSquareOptions`,
 * `cornersDotOptions`, `backgroundOptions`, `image`, `imageOptions` — and
 * draws its shapes. The raster is the same SVG, rendered.
 *
 *   await qrcode.toString(url, {
 *     dotsOptions: { type: "rounded", color: "#1e3a8a" },
 *     cornersSquareOptions: { type: "extra-rounded" },
 *     image: await readFile("logo.png"),
 *   })
 *
 * Named differences from `qr-code-styling`:
 *  - lengths are in modules, with the npm `qrcode` meaning of `margin`,
 *    `scale` and `width` (upstream counts pixels of a canvas);
 *  - `image` is the logo's bytes, decoded under Prism's default limits and
 *    re-encoded as PNG — never a URL to fetch;
 *  - a logo defaults the error correction to H, and `imageSize` stops at 0.5
 *    (upstream takes any size, and at 1 the code no longer scans);
 *  - colours are hex only, and anything drawn must keep a 3:1 contrast with
 *    the background (WCAG's figure for graphics) — a pale code is refused;
 *  - the finder centres are never nine separate dots, which ZXing — behind
 *    most phone scanners — cannot find: with `dots` modules and no
 *    `cornersDotOptions.type`, they are one `dot`, and `dots` by name is
 *    refused;
 *  - no `shape: "circle"`, `roundSize`, `qrOptions.mode` or canvas options.
 */

import type { JsQrOptions } from "./native/generated.js";
import { qrImageNative, qrSvgNative } from "./native.js";

/** Error correction: about 7 %, 15 %, 25 % or 30 % of the symbol can be lost. */
export type QRCodeErrorCorrectionLevel =
	| "L"
	| "M"
	| "Q"
	| "H"
	| "low"
	| "medium"
	| "quartile"
	| "high";

/** How a module is drawn; the rounded shapes follow their neighbours. */
export type QRCodeDotType =
	| "square"
	| "dots"
	| "rounded"
	| "extra-rounded"
	| "classy"
	| "classy-rounded";

/** A finder's 7 × 7 frame: its own shapes, or its modules drawn as dots are. */
export type QRCodeCornerSquareType =
	| "dot"
	| "square"
	| "extra-rounded"
	| QRCodeDotType;

/** A finder's 3 × 3 centre. Nine separate `dots` do not scan, so not those. */
export type QRCodeCornerDotType =
	| "dot"
	| "square"
	| Exclude<QRCodeDotType, "dots">;

export interface QRCodeGradient {
	/** Default `linear`. */
	type?: "linear" | "radial";
	/** Radians, for a linear gradient. Default 0: left to right. */
	rotation?: number;
	/** 1 to 16 stops; `offset` from 0 to 1, `color` in hex. */
	colorStops: Array<{ offset: number; color: string }>;
}

export interface QRCodeFigureOptions<Type extends string> {
	type?: Type;
	/** Hex. Default: the modules' colour. */
	color?: string;
	/** Wins over `color`. */
	gradient?: QRCodeGradient;
}

export interface QRCodeOptions {
	/** Default `M`. */
	errorCorrectionLevel?: QRCodeErrorCorrectionLevel;
	/** Symbol version, 1–40. Default: the smallest that holds the text. */
	version?: number;
	/** Quiet zone, in modules. Default 4 — what scanners expect. */
	margin?: number;
	/** Pixels per module. Default 4. */
	scale?: number;
	/** Side in pixels; wins over `scale` once it can hold the symbol (≥ 21). */
	width?: number;
	/** Hex colours, `#rgb` to `#rrggbbaa`. Default black on white. */
	color?: { dark?: string; light?: string };
	/** The data modules. Default `square`, in `color.dark`. */
	dotsOptions?: QRCodeFigureOptions<QRCodeDotType>;
	/** The finders' frames. Default: drawn as the modules are. */
	cornersSquareOptions?: QRCodeFigureOptions<QRCodeCornerSquareType>;
	/** The finders' centres. Default: drawn as the modules are. */
	cornersDotOptions?: QRCodeFigureOptions<QRCodeCornerDotType>;
	backgroundOptions?: {
		/** Corner radius, 0 (square) to 1 (a circle). */
		round?: number;
		/** Hex. Default `color.light`. */
		color?: string;
		gradient?: QRCodeGradient;
	};
	/** A logo for the middle: PNG, JPEG or WebP bytes, at most 50 megapixels. */
	image?: Uint8Array;
	imageOptions?: {
		/** Share of the error correction the logo covers, up to 0.5. Default 0.4. */
		imageSize?: number;
		/** Space around the logo, in modules. Default 0. */
		margin?: number;
		/** Leave out the modules under the logo. Default true. */
		hideBackgroundDots?: boolean;
	};
}

export type QRCodeStringType = "svg";

export type QRCodeImageType =
	| "png"
	| "image/png"
	| "webp"
	| "image/webp"
	| "avif"
	| "image/avif"
	| "svg"
	| "image/svg+xml";

export interface QRCodeToStringOptions extends QRCodeOptions {
	type?: QRCodeStringType;
}

export interface QRCodeToBufferOptions extends QRCodeOptions {
	/** Default `png`. */
	type?: QRCodeImageType;
	/** `quality` 1–100 for WebP and AVIF. Default 100 — lossless for WebP. */
	rendererOpts?: { quality?: number };
}

export type QRCodeToDataURLOptions = QRCodeToBufferOptions;

/** The format a type names, and the MIME type of its data URL. */
const IMAGE_TYPES: Record<QRCodeImageType, { format: string; mime: string }> = {
	png: { format: "png", mime: "image/png" },
	"image/png": { format: "png", mime: "image/png" },
	webp: { format: "webp", mime: "image/webp" },
	"image/webp": { format: "webp", mime: "image/webp" },
	avif: { format: "avif", mime: "image/avif" },
	"image/avif": { format: "avif", mime: "image/avif" },
	svg: { format: "svg", mime: "image/svg+xml" },
	"image/svg+xml": { format: "svg", mime: "image/svg+xml" },
};

function nativeOptions(options: QRCodeOptions): JsQrOptions {
	return {
		errorCorrectionLevel: options.errorCorrectionLevel,
		version: options.version,
		margin: options.margin,
		scale: options.scale,
		width: options.width,
		dark: options.color?.dark,
		light: options.color?.light,
		dotsOptions: options.dotsOptions,
		cornersSquareOptions: options.cornersSquareOptions,
		cornersDotOptions: options.cornersDotOptions,
		backgroundOptions: options.backgroundOptions,
		// A view, not a copy: the binding copies it once, for the worker.
		image:
			options.image === undefined
				? undefined
				: Buffer.from(
						options.image.buffer,
						options.image.byteOffset,
						options.image.byteLength,
					),
		imageOptions: options.imageOptions,
	};
}

function imageType(type: QRCodeImageType | undefined): {
	format: string;
	mime: string;
} {
	return IMAGE_TYPES[type ?? "png"];
}

async function render(
	text: string,
	options: QRCodeToBufferOptions,
): Promise<{ bytes: Buffer; mime: string }> {
	const { format, mime } = imageType(options.type);
	if (format === "svg") {
		return {
			bytes: Buffer.from(
				await qrSvgNative(text, nativeOptions(options)),
				"utf8",
			),
			mime,
		};
	}
	return {
		bytes: await qrImageNative(
			text,
			format,
			nativeOptions(options),
			options.rendererOpts?.quality,
		),
		mime,
	};
}

export const qrcode = {
	/** The QR code as an SVG document. */
	async toString(
		text: string,
		options: QRCodeToStringOptions = {},
	): Promise<string> {
		return qrSvgNative(text, nativeOptions(options));
	},

	/** The QR code as bytes — PNG by default, or WebP, AVIF, SVG. */
	async toBuffer(
		text: string,
		options: QRCodeToBufferOptions = {},
	): Promise<Buffer> {
		return (await render(text, options)).bytes;
	},

	/** The QR code as a `data:` URL, for an `<img src>`. */
	async toDataURL(
		text: string,
		options: QRCodeToDataURLOptions = {},
	): Promise<string> {
		const { bytes, mime } = await render(text, options);
		return `data:${mime};base64,${bytes.toString("base64")}`;
	},
};
