/**
 * The data tidied before it is validated, as `swissqrbill` (4.4.2) tidies it:
 * line breaks removed everywhere — the payload is one field a line, so a
 * line break would shift every field after it — and spaces removed from the
 * account, the reference and the country, which are also upper-cased but for
 * the reference.
 */

import type { Currency, Data, Debtor } from "./types.js";

type Clean = (value: string) => string;

export function removeSpaces(text: string): string {
	return text.replace(/ /g, "");
}

export function removeLineBreaks(text: string): string {
	return text.replace(/\n/g, "").replace(/\r/g, "");
}

const compact: Clean = (value) => removeLineBreaks(removeSpaces(value));
const compactUpper: Clean = (value) =>
	removeLineBreaks(removeSpaces(value).toUpperCase());

/** A string cleaned; anything else as it came, for the validator to name. */
function tidy(value: string, clean?: Clean): string;
function tidy(value: number | string, clean?: Clean): number | string;
function tidy(
	value: number | string | undefined,
	clean?: Clean,
): number | string | undefined;
function tidy(value: unknown, clean: Clean = removeLineBreaks): unknown {
	return typeof value === "string" ? clean(value) : value;
}

function isCurrency(value: string): value is Currency {
	return value === "CHF" || value === "EUR";
}

function cleanParty(party: Debtor): Debtor {
	const cleaned: Debtor = {
		address: tidy(party.address),
		city: tidy(party.city),
		country: tidy(party.country, compactUpper),
		name: tidy(party.name),
		zip: tidy(party.zip),
	};
	if (party.buildingNumber !== undefined) {
		cleaned.buildingNumber = tidy(party.buildingNumber);
	}
	return cleaned;
}

export function cleanData(data: Data): Data {
	const currency = tidy(data.currency);
	const cleaned: Data = {
		// Undefined only from a caller outside the types; the validator says so.
		creditor:
			data.creditor === undefined
				? data.creditor
				: {
						...cleanParty(data.creditor),
						account: tidy(data.creditor.account, compactUpper),
					},
		currency: isCurrency(currency) ? currency : data.currency,
	};
	if (data.additionalInformation !== undefined) {
		cleaned.additionalInformation = tidy(data.additionalInformation);
	}
	if (data.amount !== undefined) {
		cleaned.amount = data.amount;
	}
	if (data.av1 !== undefined) {
		cleaned.av1 = tidy(data.av1);
	}
	if (data.av2 !== undefined) {
		cleaned.av2 = tidy(data.av2);
	}
	if (data.debtor !== undefined) {
		cleaned.debtor = cleanParty(data.debtor);
	}
	if (data.message !== undefined) {
		cleaned.message = tidy(data.message);
	}
	if (data.reference !== undefined) {
		cleaned.reference = tidy(data.reference, compact);
	}
	return cleaned;
}
