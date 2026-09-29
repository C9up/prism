/**
 * `qrcode` — the npm `qrcode` package's shape over Prism's engine: SVG first,
 * PNG / WebP / AVIF through the encoders, data URLs, and the refusals that
 * bound what a request can ask for. That each format reads back as the text
 * is proved in the engine (crates/prism-engine/src/qr/, decoded by rxing —
 * ZXing, the decoder behind most phone scanners).
 */
import { describe, expect, it } from "vitest";
import {
	Prism,
	PrismError,
	type QRCodeImageType,
	qrcode,
} from "../../src/index.js";

const URI = "otpauth://totp/Acme:ada?secret=JBSWY3DPEHPK3PXP&issuer=Acme";
const prism = new Prism({
	limits: { allowedFormats: ["png", "webp", "avif"] },
});

async function refusal(promise: Promise<unknown>): Promise<PrismError> {
	const error = await promise.catch((caught: unknown) => caught);
	if (!(error instanceof PrismError)) throw new Error("expected a PrismError");
	return error;
}

describe("prism > qrcode.toString", () => {
	it("writes upstream's SVG: one path of runs, a viewBox, crisp edges", async () => {
		const svg = await qrcode.toString("hello");
		expect(svg).toMatch(
			/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 29 29" shape-rendering="crispEdges">/,
		);
		expect(svg).toContain('<path fill="#ffffff" d="M0 0h29v29H0z"/>');
		expect(svg).toMatch(/<path stroke="#000000" d="M4 4\.5h7/);
		expect(svg.endsWith("</svg>\n")).toBe(true);
	});

	it("takes width, margin and colours as upstream names them", async () => {
		const svg = await qrcode.toString("hello", {
			width: 200,
			margin: 1,
			color: { dark: "#1e40af", light: "#0000" },
		});
		expect(svg).toContain('width="200" height="200" viewBox="0 0 23 23"');
		expect(svg).toContain('stroke="#1e40af"');
		// A transparent background is left out, as upstream does.
		expect(svg).not.toContain("M0 0h");
	});

	it("grows the symbol with the error-correction level", async () => {
		const low = await qrcode.toString(URI, { errorCorrectionLevel: "L" });
		const high = await qrcode.toString(URI, { errorCorrectionLevel: "high" });
		const side = (svg: string) => Number(/viewBox="0 0 (\d+)/.exec(svg)?.[1]);
		expect(side(high)).toBeGreaterThan(side(low));
	});
});

describe("prism > qrcode.toBuffer and toDataURL", () => {
	it("writes PNG by default, sized by scale and margin", async () => {
		const png = await qrcode.toBuffer("hello");
		const meta = prism.inspect(png);
		expect(meta.format).toBe("png");
		// 21 modules + 2 × 4 margin, at 4 pixels a module.
		expect(meta.width).toBe(116);
	});

	it("writes WebP and AVIF, at the width asked for", async () => {
		const types: QRCodeImageType[] = ["webp", "image/avif"];
		for (const type of types) {
			const bytes = await qrcode.toBuffer(URI, { type, width: 300 });
			const meta = prism.inspect(bytes);
			expect(meta.format).toBe(type === "webp" ? "webp" : "avif");
			expect(meta.width).toBe(300);
		}
	});

	it("gives SVG bytes for type svg", async () => {
		const bytes = await qrcode.toBuffer("hello", { type: "svg" });
		expect(bytes.toString("utf8")).toBe(await qrcode.toString("hello"));
	});

	it("builds a data URL with the format's MIME type", async () => {
		expect(await qrcode.toDataURL("hello")).toMatch(
			/^data:image\/png;base64,iVBORw0KGgo/,
		);
		expect(await qrcode.toDataURL("hello", { type: "svg" })).toMatch(
			/^data:image\/svg\+xml;base64,PHN2Zy/,
		);
		expect(await qrcode.toDataURL("hello", { type: "image/webp" })).toMatch(
			/^data:image\/webp;base64,/,
		);
	});
});

describe("prism > qrcode styled, in qr-code-styling's names", () => {
	// A 2 × 1 PNG, red and blue, stretched to a 60 × 30 logo.
	const logo = () =>
		prism
			.edit(
				Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAEUlEQVR4nGO4o6b2XzX59X8AEmQEmj/jxXgAAAAASUVORK5CYII=",
					"base64",
				),
			)
			.resize({ width: 60, height: 30, fit: "fill" })
			.toFormat("png");

	it("draws the shapes, gradients and a round background as one SVG", async () => {
		const svg = await qrcode.toString(URI, {
			dotsOptions: {
				type: "rounded",
				gradient: {
					type: "linear",
					rotation: Math.PI / 4,
					colorStops: [
						{ offset: 0, color: "#1e3a8a" },
						{ offset: 1, color: "#7c3aed" },
					],
				},
			},
			cornersSquareOptions: { type: "extra-rounded", color: "#111827" },
			cornersDotOptions: { type: "dot" },
			backgroundOptions: { round: 0.2 },
		});
		expect(svg).toMatch(/<linearGradient id="qr[0-9a-f]{12}-\d+"/);
		expect(svg).toContain('fill-rule="evenodd"');
		expect(svg).toContain(' rx="');
		// Upstream's rounded modules: quarter arcs of half a module.
		expect(svg).toContain("A0.5 0.5 0 0 0");
	});

	it("embeds a logo re-encoded as PNG, and renders the same SVG as an image", async () => {
		const image = await logo();
		const svg = await qrcode.toString(URI, { image });
		expect(svg).toContain('href="data:image/png;base64,iVBORw0KGgo');
		const webp = await qrcode.toBuffer(URI, {
			type: "webp",
			width: 400,
			image,
			dotsOptions: { type: "dots" },
		});
		expect(prism.inspect(webp)).toMatchObject({ format: "webp", width: 400 });
	});

	it("refuses a pale code, an oversized logo and a logo that is not an image", async () => {
		const pale = await refusal(
			qrcode.toString(URI, { dotsOptions: { color: "#d4d4d4" } }),
		);
		expect(pale.code).toBe("E_PRISM_INVALID_QR_OPTION");
		const image = await logo();
		const big = await refusal(
			qrcode.toString(URI, { image, imageOptions: { imageSize: 0.9 } }),
		);
		expect(big.code).toBe("E_PRISM_INVALID_QR_OPTION");
		const svg = await refusal(
			qrcode.toString(URI, { image: Buffer.from("<svg onload=alert(1)>") }),
		);
		expect(svg.code).toBe("E_PRISM_UNKNOWN_FORMAT");
	});
});

describe("prism > qrcode refuses what a request should not get", () => {
	it("refuses text a QR code cannot hold", async () => {
		const error = await refusal(qrcode.toString("x".repeat(3000)));
		expect(error.code).toBe("E_PRISM_QR_TOO_LONG");
	});

	it("refuses an image over 4096 pixels a side", async () => {
		const error = await refusal(qrcode.toBuffer("hello", { scale: 200 }));
		expect(error.code).toBe("E_PRISM_INVALID_QR_OPTION");
	});

	it("refuses a colour that is not strict hex — it would land in the SVG", async () => {
		const error = await refusal(
			qrcode.toString("hello", {
				color: { dark: '"/><script>alert(1)</script>' },
			}),
		);
		expect(error.code).toBe("E_PRISM_INVALID_QR_OPTION");
	});

	it("refuses numbers upstream would quietly replace", async () => {
		for (const options of [{ margin: -1 }, { version: 41 }, { scale: 0 }]) {
			const error = await refusal(qrcode.toString("hello", options));
			expect(error.code).toBe("E_PRISM_INVALID_QR_OPTION");
		}
	});
});
