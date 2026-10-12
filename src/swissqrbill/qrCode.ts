/**
 * The Swiss QR code: the payload (Swiss Payments Code 0200), its module
 * matrix from Prism's engine, and the cross over the middle — drawn through
 * callbacks so the PDF and the SVG share every coordinate, as `swissqrbill`
 * (4.4.2) shares them.
 *
 * The matrix comes from Prism's engine, which encodes as upstream's bundled
 * `qrcodegen` does — ECI 26 (UTF-8), byte mode, level M, versions 10 to 25,
 * and the same mask choice — so the symbol is upstream's, module for module.
 */

import { qrSwissMatrixNative } from "../native.js";
import type { Data } from "./types.js";
import { getReferenceType, mm2pt } from "./utils.js";

/** The payload, one field a line. `data` is already cleaned and validated. */
export function generateQRData(data: Data): string {
	const { creditor, debtor } = data;
	const party = (who: typeof creditor | NonNullable<typeof debtor>) => [
		"S", // Structured address
		who.name,
		who.address,
		who.buildingNumber ? `${who.buildingNumber}` : "",
		`${who.zip}`,
		who.city,
		who.country,
	];
	return [
		"SPC", // Swiss Payments Code
		"0200", // Version
		"1", // Coding type: UTF-8
		creditor.account,
		...party(creditor),
		"", // Ultimate creditor: seven fields, reserved for future use
		"",
		"",
		"",
		"",
		"",
		"",
		data.amount?.toFixed(2) ?? "",
		data.currency,
		...(debtor ? party(debtor) : ["", "", "", "", "", "", ""]),
		getReferenceType(data.reference),
		data.reference ?? "",
		data.message ?? "",
		"EPD", // End of payment data
		...(data.additionalInformation ? [data.additionalInformation] : []),
		...(data.av1 ? [data.av1] : []),
		...(data.av2 ? [data.av2] : []),
	].join("\n");
}

/** The encoded symbol: `size` × `size` modules, row by row, 1 = dark. */
export interface QRMatrix {
	size: number;
	modules: Uint8Array;
}

/**
 * Encode the payload once, when the bill is built: a payload too long for
 * version 25 is refused there, before anything is drawn.
 */
export function encodeQRCode(data: Data): QRMatrix {
	return qrSwissMatrixNative(generateQRData(data));
}

/** The symbol's dark modules, column by column, as `swissqrbill` walks them. */
export function renderQRCode(
	matrix: QRMatrix,
	size: number,
	renderBlock: (x: number, y: number, blockSize: number) => void,
): void {
	const blockSize = size / matrix.size;
	for (let x = 0; x < matrix.size; x++) {
		for (let y = 0; y < matrix.size; y++) {
			if (matrix.modules[y * matrix.size + x] === 1) {
				renderBlock(x * blockSize, y * blockSize, blockSize);
			}
		}
	}
}

/** The swiss cross: 7 mm of white, 6 mm of black, the cross, on 46 mm. */
export function renderSwissCross(
	size: number,
	renderRect: (
		x: number,
		y: number,
		width: number,
		height: number,
		fillColor: "black" | "white",
	) => void,
): void {
	const scale = size / mm2pt(46);
	const white = mm2pt(7) * scale;
	const black = mm2pt(6) * scale;
	const thickness = mm2pt(1.17) * scale;
	const length = mm2pt(3.89) * scale;
	const centre = size / 2;
	renderRect(centre - white / 2, centre - white / 2, white, white, "white");
	renderRect(centre - black / 2, centre - black / 2, black, black, "black");
	renderRect(
		centre - length / 2,
		centre - thickness / 2,
		length,
		thickness,
		"white",
	);
	renderRect(
		centre - thickness / 2,
		centre - length / 2,
		thickness,
		length,
		"white",
	);
}
