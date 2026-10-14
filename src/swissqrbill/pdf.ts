/**
 * The QR-bill drawn into a PDFKit document — `swissqrbill/pdf` (4.4.2, read
 * from its tarball): the same classes, options, coordinates and drawing
 * calls, so the slip comes out as upstream's does, vector text included.
 *
 *   import PDFDocument from "pdfkit"
 *   import { SwissQRBill } from "@c9up/prism/swissqrbill/pdf"
 *
 *   const bill = new SwissQRBill(data, { language: "FR" }) // validates
 *   bill.attachTo(doc)                                     // page bottom
 *
 * PDFKit is not a dependency: the document is the caller's, and this only
 * calls methods on it — `PDFKitDocument` names the ones it needs.
 *
 * Named differences:
 *  - the QR code is encoded when the bill is built, so a payload too long
 *    for the symbol is refused by the constructor (`E_PRISM_QR_TOO_LONG`)
 *    rather than half-way through drawing;
 *  - no `Table`: a generic PDFKit table, unrelated to the bill.
 */

import { cleanData } from "./cleaner.js";
import {
	encodeQRCode,
	type QRMatrix,
	renderQRCode,
	renderSwissCross,
} from "./qrCode.js";
import { translations } from "./translations.js";
import type { Data, Debtor, FontName, Language, PDFOptions } from "./types.js";
import {
	formatAmount,
	formatIBAN,
	formatReference,
	getReferenceType,
	mm2pt,
	pt2mm,
} from "./utils.js";
import { validateData } from "./validator.js";

export type { Data, PDFOptions } from "./types.js";

/** The text options the bill passes to PDFKit. */
export interface PDFKitTextOptions {
	align?: "center" | "left" | "right";
	characterSpacing?: number;
	continued?: boolean;
	ellipsis?: boolean;
	height?: number;
	lineBreak?: boolean;
	lineGap?: number;
	width?: number;
}

/** The part of a PDFKit document the bill draws with. */
export interface PDFKitDocument {
	readonly page?: { readonly width: number; readonly height: number };
	readonly x: number;
	readonly y: number;
	addContent(data: string): PDFKitDocument;
	addPage(options: { margin: number; size: [number, number] }): PDFKitDocument;
	/** `size` is what upstream passes; PDFKit reads `space` and `phase`. */
	dash(
		length: number,
		options?: { space?: number; phase?: number; size?: number },
	): PDFKitDocument;
	fill(): PDFKitDocument;
	fillColor(color: string): PDFKitDocument;
	font(name: string): PDFKitDocument;
	fontSize(size: number): PDFKitDocument;
	heightOfString(text: string, options: PDFKitTextOptions): number;
	lineTo(x: number, y: number): PDFKitDocument;
	lineWidth(width: number): PDFKitDocument;
	moveDown(lines?: number): PDFKitDocument;
	moveTo(x: number, y: number): PDFKitDocument;
	rect(x: number, y: number, width: number, height: number): PDFKitDocument;
	restore(): PDFKitDocument;
	save(): PDFKitDocument;
	stroke(): PDFKitDocument;
	strokeColor(color: string): PDFKitDocument;
	strokeOpacity(opacity: number): PDFKitDocument;
	text(
		text: string,
		x: number,
		y: number,
		options: PDFKitTextOptions,
	): PDFKitDocument;
	text(text: string, options: PDFKitTextOptions): PDFKitDocument;
	translate(x: number, y: number): PDFKitDocument;
	undash(): PDFKitDocument;
}

/** The scissors on the horizontal cut, drawn at the slip's centre. */
const SCISSORS_TOP =
	"4.545 -1.803 m 4.06 -2.388 3.185 -2.368 2.531 -2.116 c -1.575 -0.577 l -2.769 -1.23 -3.949 -1.043 -3.949 -1.361 c -3.949 -1.61 -3.721 -1.555 -3.755 -2.203 c -3.788 -2.825 -4.437 -3.285 -5.05 -3.244 c -5.664 -3.248 -6.3 -2.777 -6.305 -2.129 c -6.351 -1.476 -5.801 -0.869 -5.152 -0.826 c -4.391 -0.713 -3.043 -1.174 -2.411 -0.041 c -2.882 0.828 -3.718 0.831 -4.474 0.787 c -5.101 0.751 -5.855 0.931 -6.154 1.547 c -6.443 2.138 -6.16 2.979 -5.496 3.16 c -4.826 3.406 -3.906 3.095 -3.746 2.325 c -3.623 1.731 -4.044 1.452 -3.882 1.236 c -3.76 1.073 -2.987 1.168 -1.608 0.549 c 2.838 2.117 l 3.4 2.273 4.087 2.268 4.584 1.716 c -0.026 -0.027 l 4.545 -1.803 l h -4.609 -2.753 m -3.962 -2.392 -4.015 -1.411 -4.687 -1.221 c -5.295 -1.009 -6.073 -1.6 -5.879 -2.26 c -5.765 -2.801 -5.052 -3 -4.609 -2.753 c h -4.581 1.256 m -3.906 1.505 -4.02 2.648 -4.707 2.802 c -5.163 2.96 -5.814 2.733 -5.86 2.196 c -5.949 1.543 -5.182 0.954 -4.581 1.256 c h";

/** The scissors on the vertical cut, between receipt and payment part. */
const SCISSORS_CENTER =
	" 1.803 4.545 m 2.388 4.06 2.368 3.185 2.116 2.531 c 0.577 -1.575 l 1.23 -2.769 1.043 -3.949 1.361 -3.949 c 1.61 -3.949 1.555 -3.721 2.203 -3.755 c 2.825 -3.788 3.285 -4.437 3.244 -5.05 c 3.248 -5.664 2.777 -6.3 2.129 -6.305 c 1.476 -6.351 0.869 -5.801 0.826 -5.152 c 0.713 -4.391 1.174 -3.043 0.041 -2.411 c -0.828 -2.882 -0.831 -3.718 -0.787 -4.474 c -0.751 -5.101 -0.931 -5.855 -1.547 -6.154 c -2.138 -6.443 -2.979 -6.16 -3.16 -5.496 c -3.406 -4.826 -3.095 -3.906 -2.325 -3.746 c -1.731 -3.623 -1.452 -4.044 -1.236 -3.882 c -1.073 -3.76 -1.168 -2.987 -0.549 -1.608 c -2.117 2.838 l -2.273 3.4 -2.268 4.087 -1.716 4.584 c 0.027 -0.026 l 1.803 4.545 l h 2.753 -4.609 m 2.392 -3.962 1.411 -4.015 1.221 -4.687 c 1.009 -5.295 1.6 -6.073 2.26 -5.879 c 2.801 -5.765 3 -5.052 2.753 -4.609 c h -1.256 -4.581 m -1.505 -3.906 -2.648 -4.02 -2.802 -4.707 c -2.96 -5.163 -2.733 -5.814 -2.196 -5.86 c -1.543 -5.949 -0.954 -5.182 -1.256 -4.581 c h";

export class SwissQRCode {
	readonly #size: number;
	readonly #matrix: QRMatrix;

	/**
	 * Creates a Swiss QR Code.
	 *
	 * @param data The data to be encoded in the QR code.
	 * @param size The size of the QR code in mm.
	 * @throws {ValidationError} Throws an error if the data is invalid.
	 */
	constructor(data: Data, size = 46) {
		this.#size = mm2pt(size);
		const cleaned = cleanData(data);
		validateData(cleaned);
		this.#matrix = encodeQRCode(cleaned);
	}

	/**
	 * Attaches the Swiss QR Code to a PDF document.
	 *
	 * @param doc The PDF document to attach the Swiss QR Code to.
	 * @param x The horizontal position in points. Default: the document's.
	 * @param y The vertical position in points. Default: the document's.
	 */
	attachTo(doc: PDFKitDocument, x: number = doc.x, y: number = doc.y): void {
		doc.save();
		doc.translate(x, y);
		renderQRCode(this.#matrix, this.#size, (xPos, yPos, blockSize) => {
			doc.rect(xPos, yPos, blockSize, blockSize);
		});
		doc.fillColor("black");
		doc.fill();
		renderSwissCross(this.#size, (xPos, yPos, width, height, fillColor) => {
			doc.rect(xPos, yPos, width, height).fillColor(fillColor).fill();
		});
		doc.restore();
	}
}

export class SwissQRBill {
	static readonly width = mm2pt(210);
	static readonly height = mm2pt(105);

	readonly #data: Data;
	readonly #qrCode: SwissQRCode;
	#scissors = true;
	#separate = false;
	#outlines = true;
	#language: Language = "DE";
	#font: FontName = "Helvetica";
	#renderAdditionalInformation = true;
	#x = 0;
	#y = 0;

	/**
	 * Creates a new SwissQRBill instance.
	 *
	 * @param data The data to be used for the QR Bill.
	 * @param options Options to define how the QR Bill should be rendered.
	 * @throws {ValidationError} Throws an error if the data is invalid.
	 */
	constructor(data: Data, options?: PDFOptions) {
		this.#data = cleanData(data);
		validateData(this.#data);
		this.#qrCode = new SwissQRCode(this.#data);
		this.#language = options?.language ?? this.#language;
		this.#outlines = options?.outlines ?? this.#outlines;
		this.#font = options?.fontName ?? this.#font;
		this.#renderAdditionalInformation =
			options?.renderAdditionalInformation ?? this.#renderAdditionalInformation;
		if (options?.scissors !== undefined) {
			this.#scissors = options.scissors;
			this.#separate = !options.scissors;
		}
		if (options?.separate !== undefined) {
			this.#separate = options.separate;
			this.#scissors = !options.separate;
		}
		if (options?.scissors === false && options.separate === false) {
			this.#separate = false;
			this.#scissors = false;
		}
	}

	/**
	 * Attaches the QR-Bill to a PDFKit document instance. It will create a new
	 * page with the size of the QR-Slip if not enough space is left on the
	 * current page.
	 *
	 * @param doc The PDFKit instance.
	 * @param x The horizontal position in points where the QR Bill will be placed.
	 * @param y The vertical position in points where the QR Bill will be placed.
	 */
	attachTo(
		doc: PDFKitDocument,
		x = 0,
		y: number = doc.page?.height ? doc.page.height - mm2pt(105) : 0,
	): void {
		if (!SwissQRBill.isSpaceSufficient(doc, x, y)) {
			doc.addPage({
				margin: 0,
				size: [SwissQRBill.width, SwissQRBill.height],
			});
			this.#x = 0;
			this.#y = 0;
		} else {
			this.#x = x;
			this.#y = y;
		}
		this.#render(doc);
	}

	/**
	 * Checks whether there is enough space on the current page to add the QR
	 * Bill.
	 *
	 * @param doc The PDFKit document instance.
	 * @param x The horizontal position where the QR Bill will be placed.
	 * @param y The vertical position where the QR Bill will be placed.
	 * @returns `true` if there is enough space, otherwise `false`.
	 */
	static isSpaceSufficient(
		doc: PDFKitDocument,
		x = 0,
		y: number = doc.page?.height ? doc.page.height - SwissQRBill.height : 0,
	): boolean {
		if (!doc.page) {
			return false;
		}
		return (
			Math.round(x + SwissQRBill.width) <= Math.round(doc.page.width) &&
			Math.round(doc.y + SwissQRBill.height) <= Math.round(doc.page.height) &&
			Math.round(y + SwissQRBill.height) <= Math.round(doc.page.height)
		);
	}

	#xAt(millimeters = 0): number {
		return this.#x + mm2pt(millimeters);
	}

	#yAt(millimeters = 0): number {
		return this.#y + mm2pt(millimeters);
	}

	#render(doc: PDFKitDocument): void {
		const data = this.#data;
		const t = translations[this.#language];
		const font = this.#font;
		const bold = `${font}-Bold`;
		// A page taller than the slip has a horizontal cut above it.
		const onLargerPage = (doc.page?.height ?? 0) > mm2pt(105);

		if (this.#outlines) {
			if (onLargerPage) {
				doc
					.moveTo(this.#xAt(), this.#yAt())
					.lineTo(this.#xAt(210), this.#yAt())
					.lineWidth(0.75)
					.strokeOpacity(1)
					.dash(1, { size: 1 })
					.strokeColor("black")
					.stroke();
			}
			doc
				.moveTo(this.#xAt(62), this.#yAt())
				.lineTo(this.#xAt(62), this.#yAt(105))
				.lineWidth(0.75)
				.strokeOpacity(1)
				.dash(1, { size: 1 })
				.strokeColor("black")
				.stroke();
		}

		if (this.#scissors) {
			if (onLargerPage) {
				doc.save();
				doc.translate(this.#xAt(105), this.#yAt());
				doc.addContent(SCISSORS_TOP).fillColor("black").fill();
				doc.restore();
			}
			doc.save();
			doc.translate(this.#xAt(62), this.#yAt() + 30);
			doc.addContent(SCISSORS_CENTER).fillColor("black").fill();
			doc.restore();
		}

		if (this.#separate && onLargerPage) {
			doc.fontSize(11);
			doc.font(font);
			doc.text(t.separate, 0, this.#yAt() - 12, {
				align: "center",
				width: mm2pt(210),
			});
		}

		// Receipt
		doc.fontSize(11);
		doc.font(bold);
		doc.text(t.receipt, this.#xAt(5), this.#yAt(5), {
			align: "left",
			width: mm2pt(52),
		});

		doc.fontSize(6);
		doc.font(bold);
		doc.text(t.account, this.#xAt(5), this.#yAt(12), {
			lineGap: 1,
			width: mm2pt(52),
		});
		doc.fontSize(8);
		doc.font(font);
		doc.text(
			`${formatIBAN(data.creditor.account)}\n${formatAddress(data.creditor)}`,
			{ lineGap: -0.5, width: mm2pt(52) },
		);
		doc.fontSize(9);
		doc.moveDown();

		if (data.reference !== undefined) {
			doc.fontSize(6);
			doc.font(bold);
			doc.text(t.reference, { lineGap: 1, width: mm2pt(52) });
			doc.fontSize(8);
			doc.font(font);
			doc.text(formatReference(data.reference), {
				lineGap: -0.5,
				width: mm2pt(52),
			});
			doc.fontSize(9);
			doc.moveDown();
		}

		if (data.debtor !== undefined) {
			doc.fontSize(6);
			doc.font(bold);
			doc.text(t.payableBy, { lineGap: 1, width: mm2pt(52) });
			doc.fontSize(8);
			doc.font(font);
			doc.text(formatAddress(data.debtor), {
				lineGap: -0.5,
				width: mm2pt(52),
			});
		} else {
			doc.fontSize(6);
			doc.font(bold);
			doc.text(t.payableByName, { lineGap: 1, width: mm2pt(52) });
			this.#addRectangle(doc, 5, pt2mm(doc.y - this.#yAt()), 52, 20);
		}

		doc.fontSize(6);
		doc.font(bold);
		doc.text(t.currency, this.#xAt(5), this.#yAt(68), {
			lineGap: 1,
			width: mm2pt(15),
		});
		const amountXPosition = data.amount === undefined ? 18 : 27;
		doc.text(t.amount, this.#xAt(amountXPosition), this.#yAt(68), {
			lineGap: 1,
			width: mm2pt(52 - amountXPosition),
		});
		doc.fontSize(8);
		doc.font(font);
		doc.text(data.currency, this.#xAt(5), this.#yAt(71), {
			lineGap: -0.5,
			width: mm2pt(15),
		});
		if (data.amount !== undefined) {
			doc.text(
				formatAmount(data.amount),
				this.#xAt(amountXPosition),
				this.#yAt(71),
				{ lineGap: -0.5, width: mm2pt(52 - amountXPosition) },
			);
		} else {
			this.#addRectangle(doc, 27, 68, 30, 10);
		}

		doc.fontSize(6);
		doc.font(bold);
		doc.text(t.acceptancePoint, this.#xAt(5), this.#yAt(82), {
			align: "right",
			height: mm2pt(18),
			lineGap: 1,
			width: mm2pt(52),
		});

		// Payment part
		doc.fontSize(11);
		doc.font(bold);
		doc.text(t.paymentPart, this.#xAt(67), this.#yAt(5), {
			align: "left",
			lineGap: 1,
			width: mm2pt(51),
		});

		this.#qrCode.attachTo(doc, this.#xAt(67), this.#yAt(17));

		doc.fontSize(8);
		doc.font(bold);
		doc.text(t.currency, this.#xAt(67), this.#yAt(68), {
			lineGap: 1,
			width: mm2pt(15),
		});
		doc.text(t.amount, this.#xAt(89), this.#yAt(68), { width: mm2pt(29) });
		doc.fontSize(10);
		doc.font(font);
		doc.text(data.currency, this.#xAt(67), this.#yAt(72), {
			lineGap: -0.5,
			width: mm2pt(15),
		});
		if (data.amount !== undefined) {
			doc.text(formatAmount(data.amount), this.#xAt(89), this.#yAt(72), {
				lineGap: -0.5,
				width: mm2pt(29),
			});
		} else {
			this.#addRectangle(doc, 78, 72, 40, 15);
		}

		if (data.av1 !== undefined) {
			const [scheme = "", rest = ""] = data.av1.split(/(\/.+)/);
			doc.fontSize(7);
			doc.font(bold);
			doc.text(scheme, this.#xAt(67), this.#yAt(90), {
				continued: true,
				height: mm2pt(3),
				lineGap: 1,
				width: mm2pt(138),
			});
			doc.font(font);
			doc.text(data.av1.length > 90 ? `${rest.substring(0, 87)}...` : rest, {
				continued: false,
			});
		}

		if (data.av2 !== undefined) {
			const [scheme = "", rest = ""] = data.av2.split(/(\/.+)/);
			doc.fontSize(7);
			doc.font(bold);
			doc.text(scheme, this.#xAt(67), this.#yAt(93), {
				continued: true,
				height: mm2pt(3),
				lineGap: 1,
				width: mm2pt(138),
			});
			doc.font(font);
			doc.text(data.av2.length > 90 ? `${rest.substring(0, 87)}...` : rest, {
				lineGap: -0.5,
			});
		}

		doc.fontSize(8);
		doc.font(bold);
		doc.text(t.account, this.#xAt(118), this.#yAt(5), {
			lineGap: 1,
			width: mm2pt(87),
		});
		doc.fontSize(10);
		doc.font(font);
		doc.text(
			`${formatIBAN(data.creditor.account)}\n${formatAddress(data.creditor)}`,
			{ lineGap: -0.75, width: mm2pt(87) },
		);
		doc.fontSize(9);
		doc.moveDown();

		if (data.reference !== undefined) {
			doc.fontSize(8);
			doc.font(bold);
			doc.text(t.reference, { lineGap: 1, width: mm2pt(87) });
			doc.fontSize(10);
			doc.font(font);
			doc.text(formatReference(data.reference), {
				lineGap: -0.75,
				width: mm2pt(87),
			});
			doc.fontSize(9);
			doc.moveDown();
		}

		const additionalInformation = this.#renderAdditionalInformation
			? data.additionalInformation
			: undefined;
		if (data.message !== undefined || additionalInformation !== undefined) {
			doc.fontSize(8);
			doc.font(bold);
			doc.text(t.additionalInformation, { lineGap: 1, width: mm2pt(87) });
			doc.fontSize(10);
			doc.font(font);
			const options: PDFKitTextOptions = { lineGap: -0.75, width: mm2pt(87) };
			const singleLineHeight = doc.heightOfString("A", options);
			const referenceType = getReferenceType(data.reference);
			const structured = referenceType === "QRR" || referenceType === "SCOR";
			const maxLines = structured ? 3 : 4;
			if (additionalInformation !== undefined) {
				const linesOfAdditionalInformation =
					doc.heightOfString(additionalInformation, options) / singleLineHeight;
				if (data.message !== undefined) {
					doc.text(
						data.message,
						structured
							? {
									...options,
									ellipsis: true,
									height: singleLineHeight,
									lineBreak: false,
								}
							: {
									...options,
									ellipsis: true,
									height:
										singleLineHeight *
										(maxLines - linesOfAdditionalInformation),
									lineBreak: true,
								},
					);
				}
				doc.text(additionalInformation, options);
			} else if (data.message !== undefined) {
				doc.text(data.message, {
					...options,
					ellipsis: true,
					height: singleLineHeight * maxLines,
					lineBreak: true,
				});
			}
			doc.fontSize(9);
			doc.moveDown();
		}

		if (data.debtor !== undefined) {
			doc.fontSize(8);
			doc.font(bold);
			doc.text(t.payableBy, { lineGap: 1, width: mm2pt(87) });
			doc.fontSize(10);
			doc.font(font);
			doc.text(formatAddress(data.debtor), {
				lineGap: -0.75,
				width: mm2pt(87),
			});
		} else {
			doc.fontSize(8);
			doc.font(bold);
			doc.text(t.payableByName, { lineGap: 1, width: mm2pt(87) });
			this.#addRectangle(doc, 118, pt2mm(doc.y - this.#yAt()), 65, 25);
		}
	}

	/** The corner marks of a box the payer fills in by hand. */
	#addRectangle(
		doc: PDFKitDocument,
		x: number,
		y: number,
		width: number,
		height: number,
	): void {
		const length = 3;
		doc
			.moveTo(this.#xAt(x + length), this.#yAt(y))
			.lineTo(this.#xAt(x), this.#yAt(y))
			.lineTo(this.#xAt(x), this.#yAt(y + length))
			.moveTo(this.#xAt(x), this.#yAt(y + height - length))
			.lineTo(this.#xAt(x), this.#yAt(y + height))
			.lineTo(this.#xAt(x + length), this.#yAt(y + height))
			.moveTo(this.#xAt(x + width - length), this.#yAt(y + height))
			.lineTo(this.#xAt(x + width), this.#yAt(y + height))
			.lineTo(this.#xAt(x + width), this.#yAt(y + height - length))
			.moveTo(this.#xAt(x + width), this.#yAt(y + length))
			.lineTo(this.#xAt(x + width), this.#yAt(y))
			.lineTo(this.#xAt(x + width - length), this.#yAt(y))
			.lineWidth(0.75)
			.undash()
			.strokeColor("black")
			.stroke();
	}
}

/** Name, street and number, then the locality — prefixed abroad. */
function formatAddress(party: Debtor): string {
	const countryPrefix = party.country !== "CH" ? `${party.country} - ` : "";
	const street =
		party.buildingNumber !== undefined
			? `${party.address} ${party.buildingNumber}`
			: party.address;
	return `${party.name}\n${street}\n${countryPrefix}${party.zip} ${party.city}`;
}
