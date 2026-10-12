/**
 * The Swiss rules a QR-bill must meet, checked in `swissqrbill`'s order
 * (4.4.2) so the same data fails on the same code. The type checks look
 * redundant under TypeScript; they are there for data that crossed a JSON
 * boundary with nothing checking it.
 */

import { ValidationError } from "./errors.js";
import type { Data, Debtor } from "./types.js";
import {
	isIBANValid,
	isQRIBAN,
	isQRReference,
	isQRReferenceValid,
} from "./utils.js";

type Party = "CREDITOR" | "DEBTOR";

function isText(value: unknown): value is string | number {
	return typeof value === "string" || typeof value === "number";
}

function validateParty(party: Debtor, who: Party): void {
	if (party.name === undefined) {
		throw new ValidationError(`${who}_NAME_IS_UNDEFINED`);
	}
	if (typeof party.name !== "string") {
		throw new ValidationError(`${who}_NAME_TYPE_IS_INVALID`);
	}
	if (party.name.length > 70) {
		throw new ValidationError(`${who}_NAME_LENGTH_IS_INVALID`);
	}
	if (party.address === undefined) {
		throw new ValidationError(`${who}_ADDRESS_IS_UNDEFINED`);
	}
	if (typeof party.address !== "string") {
		throw new ValidationError(`${who}_ADDRESS_TYPE_IS_INVALID`);
	}
	if (party.address.length > 70) {
		throw new ValidationError(`${who}_ADDRESS_LENGTH_IS_INVALID`);
	}
	if (party.buildingNumber !== undefined) {
		if (!isText(party.buildingNumber)) {
			throw new ValidationError(`${who}_BUILDING_NUMBER_TYPE_IS_INVALID`);
		}
		if (party.buildingNumber.toString().length > 16) {
			throw new ValidationError(`${who}_BUILDING_NUMBER_LENGTH_IS_INVALID`);
		}
	}
	if (party.zip === undefined) {
		throw new ValidationError(`${who}_ZIP_IS_UNDEFINED`);
	}
	if (!isText(party.zip)) {
		throw new ValidationError(`${who}_ZIP_TYPE_IS_INVALID`);
	}
	if (party.zip.toString().length > 16) {
		throw new ValidationError(`${who}_ZIP_LENGTH_IS_INVALID`);
	}
	if (party.city === undefined) {
		throw new ValidationError(`${who}_CITY_IS_UNDEFINED`);
	}
	if (typeof party.city !== "string") {
		throw new ValidationError(`${who}_CITY_TYPE_IS_INVALID`);
	}
	if (party.city.length > 35) {
		throw new ValidationError(`${who}_CITY_LENGTH_IS_INVALID`);
	}
	if (party.country === undefined) {
		throw new ValidationError(`${who}_COUNTRY_IS_UNDEFINED`);
	}
	if (typeof party.country !== "string") {
		throw new ValidationError(`${who}_COUNTRY_TYPE_IS_INVALID`);
	}
	if (party.country.length !== 2) {
		throw new ValidationError(`${who}_COUNTRY_LENGTH_IS_INVALID`);
	}
}

function validateScheme(value: string | undefined, scheme: "AV1" | "AV2") {
	if (value === undefined) {
		return;
	}
	if (typeof value !== "string") {
		throw new ValidationError("ALTERNATIVE_SCHEME_TYPE_IS_INVALID", { scheme });
	}
	if (value.length > 100) {
		throw new ValidationError("ALTERNATIVE_SCHEME_LENGTH_IS_INVALID", {
			scheme,
		});
	}
}

export function validateData(data: Data): void {
	if (data.reference !== undefined && typeof data.reference !== "string") {
		throw new ValidationError("REFERENCE_TYPE_IS_INVALID");
	}
	if (data.message !== undefined) {
		if (typeof data.message !== "string") {
			throw new ValidationError("MESSAGE_TYPE_IS_INVALID");
		}
		if (data.message.length > 140) {
			throw new ValidationError("MESSAGE_LENGTH_IS_INVALID");
		}
	}
	if (data.additionalInformation !== undefined) {
		if (typeof data.additionalInformation !== "string") {
			throw new ValidationError("ADDITIONAL_INFORMATION_TYPE_IS_INVALID");
		}
		if (data.additionalInformation.length > 140) {
			throw new ValidationError("ADDITIONAL_INFORMATION_LENGTH_IS_INVALID");
		}
	}
	if (
		data.message !== undefined &&
		data.additionalInformation !== undefined &&
		data.additionalInformation.length + data.message.length > 140
	) {
		throw new ValidationError(
			"MESSAGE_AND_ADDITIONAL_INFORMATION_LENGTH_IS_INVALID",
		);
	}
	validateScheme(data.av1, "AV1");
	validateScheme(data.av2, "AV2");

	const { creditor } = data;
	if (creditor === undefined) {
		throw new ValidationError("CREDITOR_IS_UNDEFINED");
	}
	if (creditor.account === undefined) {
		throw new ValidationError("CREDITOR_ACCOUNT_IS_UNDEFINED");
	}
	if (
		!creditor.account.startsWith("CH") &&
		!creditor.account.startsWith("LI")
	) {
		throw new ValidationError("CREDITOR_ACCOUNT_COUNTRY_IS_INVALID");
	}
	if (creditor.account.length !== 21) {
		throw new ValidationError("ACCOUNT_LENGTH_IS_INVALID", {
			iban: creditor.account,
		});
	}
	validateParty(creditor, "CREDITOR");

	if (data.amount !== undefined) {
		if (typeof data.amount !== "number") {
			throw new ValidationError("AMOUNT_TYPE_IS_INVALID");
		}
		if (data.amount.toFixed(2).length > 12) {
			throw new ValidationError("AMOUNT_LENGTH_IS_INVALID");
		}
	}
	if (data.currency === undefined) {
		throw new ValidationError("CURRENCY_IS_UNDEFINED");
	}
	if (typeof data.currency !== "string") {
		throw new ValidationError("CURRENCY_TYPE_IS_INVALID");
	}
	if (data.currency.length !== 3) {
		throw new ValidationError("CURRENCY_LENGTH_IS_INVALID");
	}
	if (data.currency !== "CHF" && data.currency !== "EUR") {
		throw new ValidationError("CURRENCY_STRING_IS_INVALID");
	}
	if (data.debtor !== undefined) {
		validateParty(data.debtor, "DEBTOR");
	}

	if (!isIBANValid(creditor.account)) {
		throw new ValidationError("CREDITOR_ACCOUNT_IS_INVALID", {
			iban: creditor.account,
		});
	}
	if (isQRIBAN(creditor.account)) {
		if (data.reference === undefined) {
			throw new ValidationError("ACCOUNT_IS_QR_IBAN_BUT_REFERENCE_IS_MISSING");
		}
		if (data.reference.length !== 27) {
			throw new ValidationError("QR_REFERENCE_LENGTH_IS_INVALID");
		}
		if (!isQRReference(data.reference)) {
			throw new ValidationError("ACCOUNT_IS_QR_IBAN_BUT_REFERENCE_IS_REGULAR");
		}
		if (!isQRReferenceValid(data.reference)) {
			throw new ValidationError("QR_REFERENCE_IS_INVALID", {
				reference: data.reference,
			});
		}
	} else if (data.reference !== undefined) {
		if (isQRReference(data.reference)) {
			throw new ValidationError("ACCOUNT_IS_REGULAR_IBAN_BUT_REFERENCE_IS_QR");
		}
		if (data.reference.length > 25) {
			throw new ValidationError("REGULAR_REFERENCE_LENGTH_IS_INVALID");
		}
	}
}
