/**
 * IBANs, references, amounts and units — `swissqrbill`'s utilities
 * (4.4.2, read from its tarball), same names, same results.
 *
 * Named difference: a creditor reference (ISO 11649) is checked without
 * regard to case, as the standard reads; upstream turns a lower-case letter
 * into the wrong number and refuses a valid `rf…` reference.
 */

/** Whether the IBAN is a QR-IBAN: its institution id is 30000–31999. */
export function isQRIBAN(iban: string): boolean {
	const qrIid = Number(iban.replace(/ /g, "").substring(4, 9));
	return qrIid >= 30000 && qrIid <= 31999;
}

/** Whether the IBAN's check digits hold (ISO 13616, mod 97). */
export function isIBANValid(iban: string): boolean {
	const compact = iban.replace(/ /g, "").toUpperCase();
	return mod97(compact.substring(4) + compact.substring(0, 4)) === 1;
}

/** The IBAN in blocks of four: `CH44 3199 9123 0008 8901 2`. */
export function formatIBAN(iban: string): string {
	return (
		iban
			.replace(/ /g, "")
			.match(/.{1,4}/g)
			?.join(" ") ?? iban
	);
}

/** Whether the reference has a QR reference's shape: 27 digits. */
export function isQRReference(reference: string): boolean {
	return /^\d{27}$/.test(reference.replace(/ /g, ""));
}

/** Whether the QR reference's check digit (mod 10, recursive) holds. */
export function isQRReferenceValid(reference: string): boolean {
	const compact = reference.replace(/ /g, "");
	if (!isQRReference(compact)) {
		return false;
	}
	return (
		calculateQRReferenceChecksum(compact.substring(0, 26)) ===
		compact.substring(26, 27)
	);
}

/** Whether the reference has a creditor reference's shape (ISO 11649). */
export function isSCORReference(reference: string): boolean {
	const compact = reference.replace(/ /g, "").toUpperCase();
	return (
		compact.startsWith("RF") &&
		compact.length >= 5 &&
		compact.length <= 25 &&
		/^[\dA-Z]+$/.test(compact)
	);
}

/** Whether the creditor reference's check digits hold. */
export function isSCORReferenceValid(reference: string): boolean {
	const compact = reference.replace(/ /g, "").toUpperCase();
	if (!isSCORReference(compact)) {
		return false;
	}
	return (
		calculateSCORReferenceChecksum(compact.substring(4)) ===
		compact.substring(2, 4)
	);
}

/** The two check digits of a creditor reference's body. */
export function calculateSCORReferenceChecksum(reference: string): string {
	const compact = reference.replace(/ /g, "").toUpperCase();
	return `${98 - mod97(`${compact}RF00`)}`.padStart(2, "0");
}

/** The check digit of a QR reference's first 26 digits. */
export function calculateQRReferenceChecksum(reference: string): string {
	return mod10(reference);
}

/** A QR reference in blocks: `21 00000 00003 13947 14300 09017`. */
export function formatQRReference(reference: string): string {
	const compact = reference.replace(/ /g, "");
	const blocks = compact.substring(2).match(/.{1,5}/g);
	return blocks ? `${compact.substring(0, 2)} ${blocks.join(" ")}` : reference;
}

/** A creditor reference in blocks of four. */
export function formatSCORReference(reference: string): string {
	return (
		reference
			.replace(/ /g, "")
			.match(/.{1,4}/g)
			?.join(" ") ?? reference
	);
}

/** The reference formatted as its type is printed. */
export function formatReference(reference: string): string {
	return getReferenceType(reference) === "QRR"
		? formatQRReference(reference)
		: formatSCORReference(reference);
}

/** The amount with two decimals and a space every three digits: `1 199.95`. */
export function formatAmount(amount: number): string {
	const [whole = "", decimals = ""] = amount.toFixed(2).split(".");
	let grouped = "";
	for (let index = whole.length - 1, count = 1; index >= 0; index--, count++) {
		grouped = whole.charAt(index) + grouped;
		if (count === 3) {
			grouped = ` ${grouped}`;
			count = 0;
		}
	}
	return `${grouped.trim()}.${decimals}`;
}

export function mm2pt(millimeters: number): number {
	return millimeters * 2.83465;
}

export function pt2mm(points: number): number {
	return points / 2.83465;
}

export function mm2px(millimeters: number): number {
	return (millimeters * 960) / 254;
}

export function px2mm(pixels: number): number {
	return (pixels * 254) / 960;
}

/** `QRR` for 27 digits, `NON` for none, `SCOR` for anything else. */
export function getReferenceType(
	reference: string | undefined,
): "NON" | "QRR" | "SCOR" {
	if (reference === undefined) {
		return "NON";
	}
	return isQRReference(reference) ? "QRR" : "SCOR";
}

/** ISO 7064 mod 97-10 over digits and letters (A = 10 … Z = 35). */
function mod97(input: string): number {
	let digits = "";
	for (const character of input) {
		const code = character.charCodeAt(0);
		digits += code >= 65 ? `${code - 55}` : character;
	}
	let remainder = 0;
	for (const digit of digits) {
		remainder = (10 * remainder + Number(digit)) % 97;
	}
	return remainder;
}

/** The recursive mod 10 of the Swiss payment slips. */
function mod10(input: string): string {
	const table = [0, 9, 4, 6, 8, 2, 7, 1, 3, 5];
	let carry = 0;
	for (const digit of input.replace(/ /g, "")) {
		carry = table[(carry + Number.parseInt(digit, 10)) % 10] ?? Number.NaN;
	}
	return `${(10 - carry) % 10}`;
}
