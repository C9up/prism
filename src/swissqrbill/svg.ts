/**
 * The QR-bill as an SVG document — `swissqrbill/svg` (4.4.2, read from its
 * tarball): the same classes, options and markup, element for element.
 *
 *   import { SwissQRBill } from "@c9up/prism/swissqrbill/svg"
 *
 *   const svg = new SwissQRBill(data, { language: "IT" }).toString()
 *
 * Named differences:
 *  - a string only: no `instance` and no `element` — upstream builds through
 *    `svg-engine`, whose DOM a server has no use for;
 *  - attribute values are escaped as text is (upstream writes them raw, and
 *    `fontName` reaches one);
 *  - an unknown character is measured as the widest one when lines are
 *    wrapped (see `characterWidth.ts`).
 */

import { calculateTextWidth, type MeasuredSize } from "./characterWidth.js";
import { cleanData } from "./cleaner.js";
import { encodeQRCode, renderQRCode, renderSwissCross } from "./qrCode.js";
import { translations } from "./translations.js";
import type { Data, Debtor, FontName, Language, SVGOptions } from "./types.js";
import {
	formatAmount,
	formatIBAN,
	formatReference,
	getReferenceType,
	mm2px,
	pt2mm,
} from "./utils.js";
import { validateData } from "./validator.js";

export type { Data, SVGOptions } from "./types.js";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

const SCISSORS =
	"M8.55299 18.3969C9.54465 17.5748 9.51074 16.0915 9.08357 14.9829L6.47473 8.02261C7.58167 5.9986 7.26467 3.99833 7.80373 3.99833C8.22582 3.99833 8.13259 4.38482 9.23105 4.32719C10.2854 4.27125 11.0652 3.1711 10.9957 2.13197C11.0025 1.09115 10.2041 0.0130391 9.1056 0.00456339C7.99867 -0.0734135 6.96972 0.858918 6.89683 1.95907C6.70527 3.24907 7.48674 5.53413 5.56613 6.60547C4.09305 5.80705 4.08797 4.38991 4.16255 3.10838C4.22358 2.04552 3.91845 0.76738 2.87424 0.260531C1.87241 -0.229367 0.446794 0.25036 0.139972 1.37594C-0.277034 2.51168 0.250156 4.07122 1.55541 4.34244C2.56233 4.55095 3.03528 3.83729 3.40143 4.1119C3.67774 4.31871 3.5167 5.62906 4.566 7.96667L1.908 15.5033C1.64356 16.456 1.65204 17.6206 2.58776 18.463L5.5424 10.6484L8.55299 18.3969ZM10.1634 2.87953C9.55143 3.97629 7.88849 3.88645 7.56641 2.74731C7.20704 1.71666 8.20887 0.397838 9.32767 0.726697C10.2447 0.919943 10.5821 2.12858 10.1634 2.87953ZM3.36753 2.927C2.94544 4.07122 1.00789 3.87797 0.746835 2.71341C0.479001 1.94042 0.8638 0.836881 1.77409 0.758904C2.88102 0.608036 3.87946 1.90821 3.36753 2.927Z";

function escapeEntities(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

/**
 * One element, serialised as `svg-engine` serialises: attributes in the
 * order they were first set, `<tag />` when empty — an empty text counts as
 * content, as it does upstream.
 */
class Element {
	readonly #tag: string;
	readonly #attributes = new Map<string, string>();
	readonly #children: Array<Element | string> = [];

	constructor(tag: string) {
		this.#tag = tag;
	}

	attr(name: string, value: string | number): this {
		this.#attributes.set(name, `${value}`);
		return this;
	}

	x(value: string | number): this {
		return this.attr("x", value);
	}

	y(value: string | number): this {
		return this.attr("y", value);
	}

	dy(value: string): this {
		return this.attr("dy", value);
	}

	text(content: string): this {
		this.#children.splice(0, this.#children.length, content);
		return this;
	}

	font(family: string, weight: "bold" | "normal", size: string): this {
		return this.attr("font-family", family)
			.attr("font-weight", weight)
			.attr("font-size", size);
	}

	append(child: Element): Element {
		this.#children.push(child);
		return child;
	}

	add(tag: string): Element {
		return this.append(new Element(tag));
	}

	/** A child `<svg>`, sized when both sides are given. */
	svg(width?: string, height?: string): Element {
		const svg = this.add("svg");
		if (width !== undefined && height !== undefined) {
			svg.attr("width", width).attr("height", height);
		}
		return svg;
	}

	/** A `<tspan>`, with its text when there is one. */
	tspan(content?: string): Element {
		const tspan = this.add("tspan");
		if (content !== undefined) {
			tspan.text(content);
		}
		return tspan;
	}

	line(x1: string, y1: string, x2: string, y2: string): Element {
		return this.add("line")
			.attr("x1", x1)
			.attr("y1", y1)
			.attr("x2", x2)
			.attr("y2", y2);
	}

	toString(): string {
		const opening = [
			this.#tag,
			...[...this.#attributes].map(
				([name, value]) => `${name}="${escapeEntities(value)}"`,
			),
		].join(" ");
		if (this.#children.length === 0) {
			return `<${opening} />`;
		}
		const content = this.#children
			.map((child) =>
				typeof child === "string" ? escapeEntities(child) : `${child}`,
			)
			.join("");
		return `<${opening}>${content}</${this.#tag}>`;
	}
}

function root(width: string, height: string): Element {
	return new Element("svg")
		.attr("xmlns", SVG_NAMESPACE)
		.attr("width", width)
		.attr("height", height);
}

/** The symbol and its cross, drawn in millimetres on a `size` mm square. */
function qrCodeElement(data: Data, size: number): Element {
	const svg = root(`${size}mm`, `${size}mm`);
	renderQRCode(encodeQRCode(data), size, (xPos, yPos, blockSize) => {
		svg
			.add("rect")
			.x(`${xPos}mm`)
			.y(`${yPos}mm`)
			.attr("width", `${blockSize}mm`)
			.attr("height", `${blockSize}mm`)
			.attr("fill", "black");
	});
	renderSwissCross(size, (xPos, yPos, width, height, fillColor) => {
		svg
			.add("rect")
			.x(`${xPos}mm`)
			.y(`${yPos}mm`)
			.attr("width", `${width}mm`)
			.attr("height", `${height}mm`)
			.attr("fill", fillColor);
	});
	return svg;
}

export class SwissQRCode {
	readonly #svg: Element;

	/**
	 * Creates a Swiss QR Code.
	 *
	 * @param data The data to be encoded in the QR code.
	 * @param size The size of the QR code in mm.
	 * @throws {ValidationError} Throws an error if the data is invalid.
	 */
	constructor(data: Data, size = 46) {
		const cleaned = cleanData(data);
		validateData(cleaned);
		this.#svg = qrCodeElement(cleaned, size);
	}

	/** Outputs the SVG as a string. */
	toString(): string {
		return this.#svg.toString();
	}
}

export class SwissQRBill {
	readonly #data: Data;
	readonly #svg: Element;
	readonly #qrCode: Element;
	#scissors = true;
	#outlines = true;
	#language: Language = "DE";
	#font: FontName = "Arial";
	#renderAdditionalInformation = true;

	/**
	 * Creates a new SwissQRBill instance.
	 *
	 * @param data The data to be used for the QR Bill.
	 * @param options Options to define how the QR Bill should be rendered.
	 * @throws {ValidationError} Throws an error if the data is invalid.
	 */
	constructor(data: Data, options?: SVGOptions) {
		this.#data = cleanData(data);
		validateData(this.#data);
		this.#qrCode = qrCodeElement(this.#data, 46);
		this.#language = options?.language ?? this.#language;
		this.#outlines = options?.outlines ?? this.#outlines;
		this.#font = options?.fontName ?? this.#font;
		this.#scissors = options?.scissors ?? this.#scissors;
		this.#renderAdditionalInformation =
			options?.renderAdditionalInformation ?? this.#renderAdditionalInformation;
		this.#svg = root("210mm", "105mm");
		this.#render();
	}

	/** Outputs the SVG as a string. */
	toString(): string {
		return this.#svg.toString();
	}

	#render(): void {
		const data = this.#data;
		const t = translations[this.#language];
		const font = this.#font;
		const svg = this.#svg;
		const creditorAddress = formatAddress(data.creditor);
		let receiptLineCount = 0;
		let paymentPartLineCount = 0;

		svg
			.add("rect")
			.x(0)
			.y(0)
			.attr("width", "100%")
			.attr("height", "100%")
			.attr("fill", "#fff");

		if (this.#outlines) {
			svg
				.line("62mm", "0mm", "62mm", "105mm")
				.attr("stroke-width", 1)
				.attr("stroke", "black")
				.attr("stroke-dasharray", 3);
		}

		if (this.#scissors) {
			svg
				.svg("11px", "19px")
				.x(mm2px(62) - 5.25)
				.y("30pt")
				.add("path")
				.attr("d", SCISSORS)
				.attr("fill", "black");
		}

		// Receipt
		const receipt = svg.svg().x("5mm").y("5mm");
		const receiptText = receipt.add("text");
		receiptText
			.tspan(t.receipt)
			.x(0)
			.y(0)
			.dy("11pt")
			.font(font, "bold", "11pt");
		receiptText
			.tspan(t.account)
			.x(0)
			.y("7mm")
			.dy("9pt")
			.font(font, "bold", "6pt");
		receiptText
			.tspan(formatIBAN(data.creditor.account))
			.x(0)
			.dy("9pt")
			.font(font, "normal", "8pt");
		receiptLineCount++;
		for (const line of creditorAddress.flatMap((part) =>
			fitTextToWidth(part, mm2px(52), 2, "8pt"),
		)) {
			receiptLineCount++;
			receiptText.tspan(line).x(0).dy("9pt").font(font, "normal", "8pt");
		}

		if (data.reference !== undefined) {
			receiptText.tspan(t.reference).x(0).dy("18pt").font(font, "bold", "6pt");
			receiptText
				.tspan(formatReference(data.reference))
				.x(0)
				.dy("9pt")
				.font(font, "normal", "8pt");
			receiptLineCount++;
		}

		if (data.debtor !== undefined) {
			receiptText.tspan(t.payableBy).x(0).dy("18pt").font(font, "bold", "6pt");
			for (const line of formatAddress(data.debtor).flatMap((part) =>
				fitTextToWidth(part, mm2px(52), 2, "8pt"),
			)) {
				receiptText.tspan(line).x(0).dy("9pt").font(font, "normal", "8pt");
			}
		} else {
			receiptText
				.tspan(t.payableByName)
				.x(0)
				.dy("18pt")
				.font(font, "bold", "6pt");
			// Upstream's arithmetic, `pt2mm` of a length already in mm included:
			// the box sits where `swissqrbill` puts it.
			const referenceHeight = data.reference !== undefined ? pt2mm(18) : 0;
			this.#addRectangle(
				5,
				12 +
					pt2mm(9) +
					receiptLineCount * pt2mm(9) +
					pt2mm(referenceHeight) +
					pt2mm(18) +
					1,
				52,
				20,
			);
		}

		const amountText = receipt.add("text").y("63mm");
		amountText.tspan(t.currency).x(0).dy("6pt").font(font, "bold", "6pt");
		const amountXPosition = data.amount === undefined ? 13 : 22;
		amountText
			.tspan(t.amount)
			.x(`${amountXPosition}mm`)
			.font(font, "bold", "6pt");
		amountText.tspan(data.currency).x(0).dy("11pt").font(font, "normal", "8pt");
		if (data.amount !== undefined) {
			amountText
				.tspan(formatAmount(data.amount))
				.x(`${amountXPosition}mm`)
				.font(font, "normal", "8pt");
		} else {
			this.#addRectangle(27, 68, 30, 10);
		}
		amountText
			.tspan(t.acceptancePoint)
			.x("52mm")
			.y("82mm")
			.attr("text-anchor", "end")
			.font(font, "bold", "6pt");

		// Payment part
		const paymentPart = svg.svg().x("67mm").y("5mm");
		paymentPart
			.add("text")
			.text(t.paymentPart)
			.x(0)
			.y(0)
			.dy("11pt")
			.font(font, "bold", "11pt");

		svg.append(this.#qrCode.x("67mm").y("17mm"));

		const middleText = paymentPart.add("text").y("63mm");
		middleText.tspan(t.currency).x(0).dy("8pt").font(font, "bold", "8pt");
		middleText.tspan(t.amount).x("22mm").font(font, "bold", "8pt");
		middleText
			.tspan(data.currency)
			.x(0)
			.dy("13pt")
			.font(font, "normal", "10pt");
		if (data.amount !== undefined) {
			middleText
				.tspan(formatAmount(data.amount))
				.x("22mm")
				.font(font, "normal", "10pt");
		} else {
			this.#addRectangle(78, 68 + pt2mm(8) + pt2mm(5), 40, 15);
		}

		const schemes = paymentPart.add("text").x(0).y("90mm");
		if (data.av1 !== undefined) {
			const [scheme = "", rest = ""] = data.av1.split(/(\/.+)/);
			schemes.tspan(scheme).x(0).font(font, "bold", "7pt");
			schemes
				.tspan(data.av1.length > 90 ? `${rest.substring(0, 87)}...` : rest)
				.font(font, "normal", "7pt");
		}
		if (data.av2 !== undefined) {
			const [scheme = "", rest = ""] = data.av2.split(/(\/.+)/);
			schemes.tspan(scheme).x(0).dy("8pt").font(font, "bold", "7pt");
			schemes
				.tspan(data.av2.length > 90 ? `${rest.substring(0, 87)}...` : rest)
				.font(font, "normal", "7pt");
		}

		const right = svg.svg().x("118mm").y("5mm").add("text");
		right.tspan(t.account).x(0).y(0).dy("11pt").font(font, "bold", "8pt");
		right
			.tspan(formatIBAN(data.creditor.account))
			.x(0)
			.dy("11pt")
			.font(font, "normal", "10pt");
		paymentPartLineCount++;
		// Upstream wraps the payment part's addresses at the receipt's width
		// and size; kept, so the two print the same lines.
		for (const line of creditorAddress.flatMap((part) =>
			fitTextToWidth(part, mm2px(52), 2, "8pt"),
		)) {
			right.tspan(line).x(0).dy("11pt").font(font, "normal", "10pt");
			paymentPartLineCount++;
		}

		if (data.reference !== undefined) {
			right.tspan(t.reference).x(0).dy("22pt").font(font, "bold", "8pt");
			right
				.tspan(formatReference(data.reference))
				.x(0)
				.dy("11pt")
				.font(font, "normal", "10pt");
			paymentPartLineCount++;
		}

		const additionalInformation = this.#renderAdditionalInformation
			? data.additionalInformation
			: undefined;
		if (data.message !== undefined || additionalInformation !== undefined) {
			right
				.tspan(t.additionalInformation)
				.x(0)
				.dy("22pt")
				.font(font, "bold", "8pt");
			const referenceType = getReferenceType(data.reference);
			const structured = referenceType === "QRR" || referenceType === "SCOR";
			const maxLines = structured ? 3 : 4;
			const width = mm2px(87);
			const linesOfAdditionalInformation = getLineCountOfText(
				additionalInformation,
				width,
				"10pt",
			);
			const line = (content: string | undefined) => {
				right.tspan(content).x(0).dy("11pt").font(font, "normal", "10pt");
				paymentPartLineCount++;
			};
			if (additionalInformation !== undefined) {
				if (data.message !== undefined) {
					if (structured) {
						line(ellipsis(data.message, width, "10pt"));
					} else {
						const maxLinesOfMessage = maxLines - linesOfAdditionalInformation;
						const messageLines = fitTextToWidth(
							data.message,
							width,
							maxLinesOfMessage,
							"10pt",
						);
						for (let index = 0; index < maxLinesOfMessage; index++) {
							line(messageLines[index]);
						}
					}
				}
				const additionalLines = fitTextToWidth(
					additionalInformation,
					width,
					linesOfAdditionalInformation,
					"10pt",
				);
				for (let index = 0; index < linesOfAdditionalInformation; index++) {
					line(additionalLines[index]);
				}
			} else if (data.message !== undefined) {
				const messageLines = fitTextToWidth(
					data.message,
					width,
					maxLines,
					"10pt",
				);
				for (let index = 0; index < maxLines; index++) {
					line(messageLines[index]);
				}
			}
		}

		if (data.debtor !== undefined) {
			right.tspan(t.payableBy).x(0).dy("22pt").font(font, "bold", "8pt");
			for (const line of formatAddress(data.debtor).flatMap((part) =>
				fitTextToWidth(part, mm2px(52), 2, "8pt"),
			)) {
				right.tspan(line).x(0).dy("11pt").font(font, "normal", "10pt");
			}
		} else {
			right.tspan(t.payableByName).x(0).dy("22pt").font(font, "bold", "8pt");
			const referenceHeight = data.reference !== undefined ? pt2mm(22) : 0;
			const additionalHeight =
				data.message !== undefined || additionalInformation !== undefined
					? pt2mm(22)
					: 0;
			this.#addRectangle(
				118,
				5 +
					pt2mm(11) +
					paymentPartLineCount * pt2mm(11) +
					referenceHeight +
					additionalHeight +
					pt2mm(22) +
					1,
				65,
				25,
			);
		}
	}

	/** The corner marks of a box the payer fills in by hand. */
	#addRectangle(x: number, y: number, width: number, height: number): void {
		const box = this.#svg
			.svg(`${width}mm`, `${height}mm`)
			.x(`${x}mm`)
			.y(`${y}mm`);
		const length = 3;
		const mark = (x1: number, y1: number, x2: number, y2: number) => {
			box
				.line(`${x1}mm`, `${y1}mm`, `${x2}mm`, `${y2}mm`)
				.attr("stroke-width", ".75pt")
				.attr("stroke", "black");
		};
		mark(0, 0, length, 0);
		mark(width - length, 0, width, 0);
		mark(width, 0, width, length);
		mark(width, height - length, width, height);
		mark(width - length, height, width, height);
		mark(0, height, length, height);
		mark(0, height - length, 0, height);
		mark(0, 0, 0, length);
	}
}

function formatAddress(party: Debtor): string[] {
	const countryPrefix = party.country !== "CH" ? `${party.country} - ` : "";
	return [
		party.name,
		party.buildingNumber !== undefined
			? `${party.address} ${party.buildingNumber}`
			: party.address,
		`${countryPrefix}${party.zip} ${party.city}`,
	];
}

function getLineCountOfText(
	text: string | undefined,
	width: number,
	size: MeasuredSize,
): number {
	if (text === undefined) {
		return 0;
	}
	let lines = 0;
	let remainder = calculateTextWidth(text, size);
	while (remainder > 1) {
		lines++;
		remainder -= width;
	}
	return lines;
}

/** Break at spaces, pipes and hyphens; break a word too long for a line. */
function fitTextToWidth(
	text: string,
	width: number,
	maxLines: number,
	size: MeasuredSize,
): string[] {
	const remainder = text.split(/([ |-])/g);
	let lines: string[] = [];
	let currentLine = "";

	const checkCurrentLine = (line: string) => {
		const fitted: string[] = [];
		let leftover = "";
		if (calculateTextWidth(line, size) > width) {
			const characters = line.split("");
			let currentWord = "";
			while (characters.length > 0) {
				if (calculateTextWidth(currentWord, size) <= width) {
					currentWord += characters.shift() ?? "";
				} else {
					fitted.push(currentWord);
					currentWord = "";
				}
			}
			if (currentWord !== "") {
				leftover = currentWord;
			}
		} else {
			fitted.push(line);
		}
		return { leftover, lines: fitted };
	};

	while (remainder.length > 0) {
		const nextWord = remainder.shift() ?? "";
		const separator = remainder.shift() ?? "";
		if (calculateTextWidth(currentLine + nextWord + separator, size) <= width) {
			currentLine += nextWord + separator;
		} else if (currentLine !== "") {
			const { leftover, lines: fitted } = checkCurrentLine(currentLine);
			lines.push(...fitted);
			currentLine = leftover + nextWord + separator;
		} else {
			currentLine = nextWord + separator;
		}
	}

	if (currentLine !== "" && currentLine !== " ") {
		const { leftover, lines: fitted } = checkCurrentLine(currentLine);
		lines.push(...fitted);
		if (leftover !== "") {
			lines.push(leftover);
		}
	}

	if (lines.length > maxLines) {
		lines = lines.slice(0, maxLines);
		const last = lines.length - 1;
		if (last >= 0) {
			lines[last] = ellipsis(lines[last] ?? "", width, size);
		}
	}
	return lines;
}

/** The text shortened to fit, ending in `...`. */
function ellipsis(text: string, width: number, size: MeasuredSize): string {
	if (calculateTextWidth(text, size) <= width) {
		return text;
	}
	let result = "";
	for (const character of text.split("")) {
		if (calculateTextWidth(`${result}${character}...`, size) > width) {
			break;
		}
		result += character;
	}
	if (result.endsWith(" ")) {
		result = result.slice(0, -1);
	}
	return `${result}...`;
}
