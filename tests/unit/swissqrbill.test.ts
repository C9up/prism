/**
 * `swissqrbill` — the QR-bill ported from `swissqrbill` 4.4.2, proved against
 * that package itself: the same SVG byte for byte outside the QR code, and
 * the QR code's modules one for one (drawn as one path, where upstream draws a
 * rectangle each), the same PDFKit calls in the same order, the same refusals,
 * the same utilities. That the symbol reads back as the payload is proved in the
 * engine (crates/prism-engine/src/qr/swiss.rs, decoded by rxing).
 */

import PDFDocument from "pdfkit";
import { ValidationError as UpstreamValidationError } from "swissqrbill/errors";
import {
	SwissQRBill as UpstreamPDFBill,
	SwissQRCode as UpstreamPDFCode,
} from "swissqrbill/pdf";
import {
	SwissQRBill as UpstreamSVGBill,
	SwissQRCode as UpstreamSVGCode,
} from "swissqrbill/svg";
import * as upstreamUtils from "swissqrbill/utils";
import { describe, expect, it } from "vitest";
import { PrismError } from "../../src/errors.js";
import { ValidationError } from "../../src/swissqrbill/errors.js";
import {
	SwissQRBill as PDFBill,
	SwissQRCode as PDFCode,
	type PDFKitDocument,
} from "../../src/swissqrbill/pdf.js";
import {
	SwissQRBill as SVGBill,
	SwissQRCode as SVGCode,
} from "../../src/swissqrbill/svg.js";
import type {
	Data,
	PDFOptions,
	SVGOptions,
} from "../../src/swissqrbill/types.js";
import * as utils from "../../src/swissqrbill/utils.js";

const QR_IBAN = "CH44 3199 9123 0008 8901 2";
const IBAN = "CH58 0079 1123 0008 8901 2";

const creditor = {
	account: QR_IBAN,
	address: "Musterstrasse",
	buildingNumber: 7,
	city: "Musterstadt",
	country: "CH",
	name: "SwissQRBill & <Co>",
	zip: 1234,
};

const debtor = {
	address: "Grosse Marktgasse",
	buildingNumber: "28a",
	city: "Rorschach",
	country: "CH",
	name: "Pia-Maria Rutschmann-Schnyder",
	zip: "9400",
};

/** Every branch of the layout, each with the options that steer it. */
const CASES: Array<{
	name: string;
	data: Data;
	options?: PDFOptions & SVGOptions;
}> = [
	{
		name: "QR reference, amount, debtor, message",
		data: {
			amount: 1199.95,
			creditor,
			currency: "CHF",
			debtor,
			message: "Auftrag vom 15.06.2020",
			reference: "21 00000 00003 13947 14300 09017",
		},
	},
	{
		name: "creditor reference, no amount, no debtor, schemes",
		data: {
			additionalInformation:
				"//S1/10/10201409/11/200701/20/140.000-53/30/102673831/31/200615/32/7.7/33/7.7:100/40/0:30",
			av1: "eBill/B/41010560425610173",
			av2: "XY/some data for the alternative scheme",
			creditor: { ...creditor, account: IBAN, country: "DE", zip: "D-1234" },
			currency: "EUR",
			reference: "RF18 5390 0754 7034",
		},
		options: { language: "FR", scissors: false },
	},
	{
		name: "no reference, a message that wraps and is shortened",
		data: {
			additionalInformation: "Bill information for the booking",
			amount: 12,
			creditor: { ...creditor, account: IBAN },
			currency: "CHF",
			debtor: { ...debtor, country: "AT" },
			message:
				"A message long enough to wrap over the lines of the payment part that the information leaves",
		},
		options: { language: "IT", separate: true },
	},
	{
		name: "no reference, a message too wide for four lines",
		data: {
			amount: 12,
			creditor: { ...creditor, account: IBAN },
			currency: "CHF",
			message: Array.from({ length: 28 }, () => "WWWW").join(" "),
		},
		options: { language: "DE" },
	},
	{
		name: "a structured reference shortens the message to one line",
		data: {
			additionalInformation: "Bill information for the booking",
			amount: 1234567.8,
			creditor,
			currency: "CHF",
			message:
				"A message long enough to need an ellipsis on the one line it gets here",
			reference: "210000000003139471430009017",
		},
		options: { language: "EN", renderAdditionalInformation: false },
	},
	{
		name: "Liechtenstein, long names, no outlines",
		data: {
			amount: 0.5,
			creditor: {
				...creditor,
				account: "LI21 0881 0000 2324 013A A",
				country: "LI",
				name: "A creditor whose name is as long as the guidelines allow, exactly 70c",
			},
			currency: "CHF",
			debtor: {
				...debtor,
				address:
					"An address that is long enough to need two lines on the receipt",
			},
		},
		options: { language: "RM", outlines: false, scissors: false },
	},
	{
		name: "a word too long for a line, information and message shortened",
		data: {
			additionalInformation: "//S1/10/10201409/11/200701/20/140.000-53",
			amount: 99,
			creditor,
			currency: "CHF",
			debtor: {
				...debtor,
				name: "Donaudampfschifffahrtsgesellschaftskapitänswitwenrentenkasse",
			},
			message: Array.from({ length: 18 }, () => "WWWW").join(" "),
			reference: "210000000003139471430009017",
		},
		options: { scissors: false, separate: false },
	},
];

/** A PDFKit document whose every call is recorded, chained calls included. */
function recorded(): { doc: PDFKit.PDFDocument; calls: unknown[][] } {
	const calls: unknown[][] = [];
	const target = new PDFDocument({ size: "A4" });
	const doc: PDFKit.PDFDocument = new Proxy(target, {
		get(object, property) {
			const value: unknown = Reflect.get(object, property, object);
			if (typeof value !== "function") {
				return value;
			}
			return (...args: unknown[]) => {
				calls.push([String(property), ...args]);
				const result: unknown = Reflect.apply(value, object, args);
				return result === object ? doc : result;
			};
		},
	});
	return { doc, calls };
}

function thrown(build: () => unknown): Error {
	try {
		build();
	} catch (error) {
		if (error instanceof Error) return error;
	}
	throw new Error("expected a throw");
}

/** One row of the path: `M<x> <y>.5h<n>`, then `m<gap> 0h<n>` per run. */
const ROW = /M(\d+) (\d+)\.5h(\d+)((?:m\d+ 0h\d+)*)/g;

/** The QR code's path, its modules as "column,row", and the SVG without it. */
function ourModules(svg: string): {
	count: number;
	modules: Set<string>;
	rest: string;
} {
	const match =
		/<svg width="[^"]+" height="[^"]+" viewBox="0 0 (\d+) \1" shape-rendering="crispEdges"><path stroke="black" d="([^"]*)" \/><\/svg>/.exec(
			svg,
		);
	if (!match) throw new Error("no QR path");
	const [whole, count = "", d = ""] = match;
	// Nothing in the path but rows of runs.
	expect(d.replace(ROW, "")).toBe("");
	const modules = new Set<string>();
	for (const [, x = "", y = "", first = "", more = ""] of d.matchAll(ROW)) {
		let cursor = Number(x);
		const runs = [Number(first)];
		const gaps = [0];
		for (const [, gap = "", length = ""] of more.matchAll(/m(\d+) 0h(\d+)/g)) {
			gaps.push(Number(gap));
			runs.push(Number(length));
		}
		runs.forEach((length, i) => {
			cursor += gaps[i] ?? 0;
			for (let k = 0; k < length; k++) modules.add(`${cursor + k},${y}`);
			cursor += length;
		});
	}
	return { count: Number(count), modules, rest: svg.replace(whole, "") };
}

/** Upstream's module rectangles as "column,row", and the SVG without them. */
function upstreamModules(
	svg: string,
	size: number,
	count: number,
): { modules: Set<string>; rest: string } {
	const block = size / count;
	const side = `${block}mm`.replace(/\./g, "\\.");
	const rect = new RegExp(
		`<rect x="([^"]+)mm" y="([^"]+)mm" width="${side}" height="${side}" fill="black" />`,
		"g",
	);
	const modules = new Set<string>();
	const rest = svg.replace(rect, (_rect, x: string, y: string) => {
		modules.add(
			`${Math.round(Number(x) / block)},${Math.round(Number(y) / block)}`,
		);
		return "";
	});
	return { modules, rest };
}

/** Upstream's SVG, but for the QR code: the same modules, as one path. */
function expectUpstreamSVG(ours: string, theirs: string, size = 46): void {
	const own = ourModules(ours);
	const upstream = upstreamModules(theirs, size, own.count);
	expect(upstream.modules.size).toBeGreaterThan(0);
	expect(own.modules).toEqual(upstream.modules);
	expect(own.rest).toBe(upstream.rest);
}

describe("prism > swissqrbill/svg", () => {
	it.each(CASES)(
		"writes upstream's SVG, the QR code as one path: $name",
		({ data, options }) => {
			expectUpstreamSVG(
				new SVGBill(data, options).toString(),
				new UpstreamSVGBill(data, options).toString(),
			);
		},
	);

	it("draws the QR code in a few kilobytes, where upstream needs some 190", () => {
		const { data } = CASES[0] ?? { data: undefined };
		if (!data) throw new Error("no case");
		const ours = new SVGCode(data).toString().length;
		const theirs = new UpstreamSVGCode(data).toString().length;
		expect(ours).toBeLessThan(10_000);
		expect(theirs).toBeGreaterThan(150_000);
	});

	it("wraps a long message and keeps the four lines it may take", () => {
		const wide = CASES.find((entry) => entry.name.includes("too wide"));
		if (!wide) throw new Error("no case");
		const lines = [
			...new SVGBill(wide.data).toString().matchAll(/>(W[W ]*)<\/tspan>/g),
		].map(([, line]) => line);
		// As upstream: the lines past the fourth are dropped, and the fourth,
		// which fits, is not marked as cut.
		expect(lines).toHaveLength(4);
		expect(lines.join("").length).toBeLessThan(wide.data.message?.length ?? 0);
	});

	it("writes upstream's QR code alone, at any size", () => {
		const { data } = CASES[0] ?? { data: undefined };
		if (!data) throw new Error("no case");
		expectUpstreamSVG(
			new SVGCode(data).toString(),
			new UpstreamSVGCode(data).toString(),
		);
		expectUpstreamSVG(
			new SVGCode(data, 30).toString(),
			new UpstreamSVGCode(data, 30).toString(),
			30,
		);
	});

	it("escapes attributes, where upstream writes them raw", () => {
		// Typed out of reach, but options can arrive from a request.
		const options: SVGOptions = JSON.parse('{"fontName":"x\\"/><script>"}');
		const svg = new SVGBill(
			{
				amount: 1,
				creditor,
				currency: "CHF",
				reference: "210000000003139471430009017",
			},
			options,
		).toString();
		expect(svg).not.toContain("<script>");
		expect(svg).toContain('font-family="x&quot;/&gt;&lt;script&gt;"');
	});

	it("measures a character outside upstream's tables instead of breaking every word", () => {
		const svg = new SVGBill({
			amount: 1,
			creditor: {
				...creditor,
				account: IBAN,
				city: "Łódź",
				country: "PL",
				zip: "90-001",
			},
			currency: "CHF",
		}).toString();
		expect(svg).toContain(">PL - 90-001 Łódź</tspan>");
	});
});

describe("prism > swissqrbill/pdf", () => {
	it.each(CASES)(
		"makes upstream's PDFKit calls, in order: $name",
		({ data, options }) => {
			const ours = recorded();
			new PDFBill(data, options).attachTo(ours.doc);
			const theirs = recorded();
			new UpstreamPDFBill(data, options).attachTo(theirs.doc);
			expect(ours.calls).toEqual(theirs.calls);
			expect(ours.calls.length).toBeGreaterThan(1000);
		},
	);

	it("adds a page of the slip's size when the current one is full, as upstream", () => {
		const { data } = CASES[0] ?? { data: undefined };
		if (!data) throw new Error("no case");
		const ours = recorded();
		ours.doc.text("Body", 50, 700);
		new PDFBill(data).attachTo(ours.doc);
		const theirs = recorded();
		theirs.doc.text("Body", 50, 700);
		new UpstreamPDFBill(data).attachTo(theirs.doc);
		expect(ours.calls).toEqual(theirs.calls);
		expect(ours.calls).toContainEqual([
			"addPage",
			{ margin: 0, size: [PDFBill.width, PDFBill.height] },
		]);
	});

	it("starts a page of its own in a document that has none, as upstream", () => {
		const { data } = CASES[0] ?? { data: undefined };
		if (!data) throw new Error("no case");
		const blank = () => new PDFDocument({ autoFirstPage: false });
		expect(PDFBill.isSpaceSufficient(blank())).toBe(false);
		expect(UpstreamPDFBill.isSpaceSufficient(blank())).toBe(false);
		const doc = blank();
		new PDFBill(data).attachTo(doc);
		expect(doc.page.height).toBeCloseTo(PDFBill.height);
	});

	it("places the QR code alone where it is told, as upstream", () => {
		const { data } = CASES[0] ?? { data: undefined };
		if (!data) throw new Error("no case");
		const ours = recorded();
		new PDFCode(data, 30).attachTo(ours.doc, 100, 120);
		const theirs = recorded();
		new UpstreamPDFCode(data, 30).attachTo(theirs.doc, 100, 120);
		expect(ours.calls).toEqual(theirs.calls);
	});

	it("writes the slip's text as text, in a PDF that ends", async () => {
		const doc = new PDFDocument({ size: "A4", compress: false });
		const chunks: Buffer[] = [];
		doc.on("data", (chunk: Buffer) => chunks.push(chunk));
		const ended = new Promise((resolve) => doc.on("end", resolve));
		const { data } = CASES[0] ?? { data: undefined };
		if (!data) throw new Error("no case");
		new PDFBill(data).attachTo(doc);
		doc.end();
		await ended;
		const pdf = Buffer.concat(chunks).toString("latin1");
		expect(pdf.startsWith("%PDF-")).toBe(true);
		// PDFKit writes a standard font's text as hex-encoded WinAnsi, split
		// where it kerns: `[<456d70> 30 <66616e...>] TJ`.
		const text = [...pdf.matchAll(/\[([^\]]*)\] TJ/g)]
			.map(([, operands = ""]) =>
				[...operands.matchAll(/<([0-9a-f]*)>/g)]
					.map(([, hex = ""]) => Buffer.from(hex, "hex").toString("latin1"))
					.join(""),
			)
			.join("\n");
		expect(text).toContain("Empfangsschein");
		expect(text).toContain("CH44 3199 9123 0008 8901 2");
	});

	it("takes a PDFKit document as it is typed", () => {
		const document: PDFKitDocument = new PDFDocument();
		expect(document.page?.width).toBeGreaterThan(0);
	});
});

describe("prism > swissqrbill validation", () => {
	const valid: Data = {
		amount: 10,
		creditor,
		currency: "CHF",
		debtor,
		reference: "210000000003139471430009017",
	};
	const long = (length: number) => "x".repeat(length);

	it.each<[string, Data]>([
		[
			"a bad IBAN",
			{
				...valid,
				creditor: { ...creditor, account: "CH44 3199 9123 0008 8901 3" },
			},
		],
		[
			"a foreign IBAN",
			{
				...valid,
				creditor: { ...creditor, account: "DE89 3704 0044 0532 0130 00" },
			},
		],
		[
			"an IBAN of the wrong length",
			{
				...valid,
				creditor: { ...creditor, account: "CH44 3199 9123 0008 8901" },
			},
		],
		["a QR-IBAN without a reference", { ...valid, reference: undefined }],
		[
			"a QR-IBAN with a creditor reference",
			{ ...valid, reference: "RF18 5390 0754 7034 0000 0000 0" },
		],
		[
			"a QR-IBAN with a creditor reference of 27",
			{ ...valid, reference: "RF18539007547034ABCDEFGHIJK" },
		],
		[
			"a QR reference that does not check",
			{ ...valid, reference: "210000000003139471430009018" },
		],
		[
			"an IBAN with a QR reference",
			{ ...valid, creditor: { ...creditor, account: IBAN } },
		],
		[
			"a creditor reference too long",
			{
				...valid,
				creditor: { ...creditor, account: IBAN },
				reference: "RF18539007547034ABCDEFGHIJ",
			},
		],
		["a message too long", { ...valid, message: long(141) }],
		[
			"additional information too long",
			{ ...valid, additionalInformation: long(141) },
		],
		[
			"message and information too long together",
			{ ...valid, message: long(70), additionalInformation: long(71) },
		],
		["an alternative scheme too long", { ...valid, av1: long(101) }],
		["a second one too long", { ...valid, av2: long(101) }],
		["an amount too long", { ...valid, amount: 1234567890.5 }],
		[
			"a creditor name too long",
			{ ...valid, creditor: { ...creditor, name: long(71) } },
		],
		[
			"a creditor address too long",
			{ ...valid, creditor: { ...creditor, address: long(71) } },
		],
		[
			"a building number too long",
			{ ...valid, creditor: { ...creditor, buildingNumber: long(17) } },
		],
		["a zip too long", { ...valid, creditor: { ...creditor, zip: long(17) } }],
		[
			"a city too long",
			{ ...valid, creditor: { ...creditor, city: long(36) } },
		],
		[
			"a country of three letters",
			{ ...valid, creditor: { ...creditor, country: "CHE" } },
		],
		[
			"a debtor name too long",
			{ ...valid, debtor: { ...debtor, name: long(71) } },
		],
		[
			"a debtor country of one letter",
			{ ...valid, debtor: { ...debtor, country: "C" } },
		],
		[
			"a debtor city too long",
			{ ...valid, debtor: { ...debtor, city: long(36) } },
		],
	])("refuses %s with upstream's code and message", (_, data) => {
		const theirs = thrown(() => new UpstreamPDFBill(data));
		const ours = thrown(() => new PDFBill(data));
		expect(theirs).toBeInstanceOf(UpstreamValidationError);
		expect(ours).toBeInstanceOf(ValidationError);
		expect(ours).toBeInstanceOf(PrismError);
		expect(ours.message).toBe(theirs.message);
		expect(ours.name).toBe(theirs.name);
		expect(Reflect.get(ours, "code")).toBe(Reflect.get(theirs, "code"));
		// The SVG validates the same data the same way.
		expect(thrown(() => new SVGBill(data)).message).toBe(theirs.message);
	});

	it.each([
		["no creditor", { currency: "CHF" }],
		["no account", { creditor: { name: "A" }, currency: "CHF" }],
		[
			"no creditor name",
			{ creditor: { account: "CH4431999123000889012" }, currency: "CHF" },
		],
		[
			"a name that is a number",
			{
				creditor: { account: "CH4431999123000889012", name: 7 },
				currency: "CHF",
			},
		],
		[
			"no address",
			{
				creditor: { account: "CH4431999123000889012", name: "A" },
				currency: "CHF",
			},
		],
		[
			"an address that is a list",
			{
				creditor: { account: "CH4431999123000889012", name: "A", address: [] },
				currency: "CHF",
			},
		],
		[
			"a building number that is a flag",
			{
				creditor: {
					account: "CH4431999123000889012",
					name: "A",
					address: "B",
					buildingNumber: true,
				},
				currency: "CHF",
			},
		],
		[
			"no zip",
			{
				creditor: { account: "CH4431999123000889012", name: "A", address: "B" },
				currency: "CHF",
			},
		],
		[
			"a zip that is a flag",
			{
				creditor: {
					account: "CH4431999123000889012",
					name: "A",
					address: "B",
					zip: false,
				},
				currency: "CHF",
			},
		],
		[
			"no city",
			{
				creditor: {
					account: "CH4431999123000889012",
					name: "A",
					address: "B",
					zip: 1,
				},
				currency: "CHF",
			},
		],
		[
			"a city that is a number",
			{
				creditor: {
					account: "CH4431999123000889012",
					name: "A",
					address: "B",
					zip: 1,
					city: 2,
				},
				currency: "CHF",
			},
		],
		[
			"no country",
			{
				creditor: {
					account: "CH4431999123000889012",
					name: "A",
					address: "B",
					zip: 1,
					city: "C",
				},
				currency: "CHF",
			},
		],
		[
			"a country that is a number",
			{
				creditor: {
					account: "CH4431999123000889012",
					name: "A",
					address: "B",
					zip: 1,
					city: "C",
					country: 41,
				},
				currency: "CHF",
			},
		],
		[
			"no currency",
			{
				creditor: {
					account: "CH5800791123000889012",
					name: "A",
					address: "B",
					zip: 1,
					city: "C",
					country: "CH",
				},
			},
		],
		[
			"a currency that is a number",
			{
				creditor: {
					account: "CH5800791123000889012",
					name: "A",
					address: "B",
					zip: 1,
					city: "C",
					country: "CH",
				},
				currency: 756,
			},
		],
		[
			"a currency of four letters",
			{
				creditor: {
					account: "CH5800791123000889012",
					name: "A",
					address: "B",
					zip: 1,
					city: "C",
					country: "CH",
				},
				currency: "CHFF",
			},
		],
		[
			"another currency",
			{
				creditor: {
					account: "CH5800791123000889012",
					name: "A",
					address: "B",
					zip: 1,
					city: "C",
					country: "CH",
				},
				currency: "USD",
			},
		],
		[
			"an amount that is text",
			{
				amount: "12",
				creditor: {
					account: "CH5800791123000889012",
					name: "A",
					address: "B",
					zip: 1,
					city: "C",
					country: "CH",
				},
				currency: "CHF",
			},
		],
		[
			"a reference that is a number",
			{ reference: 12, creditor: {}, currency: "CHF" },
		],
		[
			"a message that is a number",
			{ message: 12, creditor: {}, currency: "CHF" },
		],
		[
			"information that is a number",
			{ additionalInformation: 12, creditor: {}, currency: "CHF" },
		],
		["a scheme that is a number", { av1: 12, creditor: {}, currency: "CHF" }],
		[
			"a debtor without a name",
			{
				creditor: {
					account: "CH5800791123000889012",
					name: "A",
					address: "B",
					zip: 1,
					city: "C",
					country: "CH",
				},
				currency: "CHF",
				debtor: {},
			},
		],
	])("refuses %s from untyped JSON as upstream does", (_, json) => {
		// Data that crossed a JSON boundary with nothing checking it.
		const data: Data = JSON.parse(JSON.stringify(json));
		const theirs = thrown(() => new UpstreamPDFBill(data));
		const ours = thrown(() => new PDFBill(data));
		expect(theirs).toBeInstanceOf(UpstreamValidationError);
		expect(ours.message).toBe(theirs.message);
		expect(Reflect.get(ours, "code")).toBe(Reflect.get(theirs, "code"));
	});

	it("cleans as upstream does: spaces and case in the account, line breaks anywhere", () => {
		const data: Data = {
			...valid,
			creditor: {
				...creditor,
				account: "ch44 3199 9123 0008 8901 2",
				country: "c h",
				name: "Line\r\nbreak",
			},
			message: "one\ntwo",
		};
		expectUpstreamSVG(
			new SVGBill(data).toString(),
			new UpstreamSVGBill(data).toString(),
		);
	});

	it("refuses a payload the symbol cannot hold, before drawing anything", () => {
		// Three bytes a character: well past the 997 bytes of version 25.
		const wide = (length: number) => "€".repeat(length);
		const error = thrown(
			() =>
				new PDFBill({
					amount: 1,
					creditor: {
						...creditor,
						address: wide(70),
						city: wide(35),
						name: wide(70),
					},
					currency: "CHF",
					debtor: {
						...debtor,
						address: wide(70),
						city: wide(35),
						name: wide(70),
					},
					message: wide(140),
					reference: "210000000003139471430009017",
				}),
		);
		expect(error).toBeInstanceOf(PrismError);
		expect(Reflect.get(error, "code")).toBe("E_PRISM_QR_TOO_LONG");
	});
});

describe("prism > swissqrbill/utils", () => {
	const references = [
		"210000000003139471430009017",
		"21 00000 00003 13947 14300 09017",
		"210000000003139471430009018",
		"RF18 5390 0754 7034",
		"RF18539007547034",
		"RF19539007547034",
		"RF00",
		"12345",
		"",
	];
	const ibans = [
		QR_IBAN,
		IBAN,
		"ch5800791123000889012",
		"CH58 0079 1123 0008 8901 3",
		"LI21 0881 0000 2324 013A A",
		"CH4431999123000889012",
		"DE89370400440532013000",
		"CH12-3",
	];

	it("answers as upstream for every IBAN", () => {
		for (const iban of ibans) {
			expect([
				iban,
				utils.isIBANValid(iban),
				utils.isQRIBAN(iban),
				utils.formatIBAN(iban),
			]).toEqual([
				iban,
				upstreamUtils.isIBANValid(iban),
				upstreamUtils.isQRIBAN(iban),
				upstreamUtils.formatIBAN(iban),
			]);
		}
	});

	it("answers as upstream for every reference", () => {
		for (const reference of references) {
			expect([
				reference,
				utils.isQRReference(reference),
				utils.isQRReferenceValid(reference),
				utils.isSCORReference(reference),
				utils.isSCORReferenceValid(reference),
				utils.getReferenceType(reference),
				utils.formatReference(reference),
				utils.formatQRReference(reference),
				utils.formatSCORReference(reference),
			]).toEqual([
				reference,
				upstreamUtils.isQRReference(reference),
				upstreamUtils.isQRReferenceValid(reference),
				upstreamUtils.isSCORReference(reference),
				upstreamUtils.isSCORReferenceValid(reference),
				upstreamUtils.getReferenceType(reference),
				upstreamUtils.formatReference(reference),
				upstreamUtils.formatQRReference(reference),
				upstreamUtils.formatSCORReference(reference),
			]);
		}
		expect(utils.getReferenceType(undefined)).toBe("NON");
	});

	it("computes upstream's check digits", () => {
		for (const base of [
			"21000000000313947143000901",
			"00000000000000000000000001",
			"1",
		]) {
			expect(utils.calculateQRReferenceChecksum(base)).toBe(
				upstreamUtils.calculateQRReferenceChecksum(base),
			);
		}
		for (const body of ["539007547034", "1", "ABC123"]) {
			expect(utils.calculateSCORReferenceChecksum(body)).toBe(
				upstreamUtils.calculateSCORReferenceChecksum(body),
			);
		}
	});

	it("checks a creditor reference with letters in lower case, which upstream refuses", () => {
		expect(utils.isSCORReferenceValid("RF27 INVO ICE2 026")).toBe(true);
		expect(utils.isSCORReferenceValid("rf27 invo ice2 026")).toBe(true);
		expect(upstreamUtils.isSCORReferenceValid("rf27 invo ice2 026")).toBe(
			false,
		);
	});

	it("formats amounts and converts units as upstream", () => {
		for (const amount of [
			0, 0.5, 12, 1234.5, 1199.95, 1234567.891, 999999999.99,
		]) {
			expect(utils.formatAmount(amount)).toBe(
				upstreamUtils.formatAmount(amount),
			);
		}
		for (const value of [0, 1, 46, 105.5]) {
			expect([
				utils.mm2pt(value),
				utils.pt2mm(value),
				utils.mm2px(value),
				utils.px2mm(value),
			]).toEqual([
				upstreamUtils.mm2pt(value),
				upstreamUtils.pt2mm(value),
				upstreamUtils.mm2px(value),
				upstreamUtils.px2mm(value),
			]);
		}
	});
});
