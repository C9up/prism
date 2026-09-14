/**
 * Default `Prism` singleton.
 *
 *   import images from "@c9up/prism/services/main"
 *
 *   const thumb = await images.edit(upload).resize({ width: 300 }).toFormat("webp")
 */

import type { Prism } from "../Prism.js";

let instance: Prism | undefined;

/** @internal Bind the singleton (called by PrismProvider or by the app). */
export function setPrism(value: Prism): void {
	instance = value;
}

/** @internal Read the singleton (or `undefined` pre-boot). */
export function getPrism(): Prism | undefined {
	return instance;
}

/** @internal Release the singleton. */
export function clearPrism(): void {
	instance = undefined;
}

const images: Prism = new Proxy({} as Prism, {
	get(_target, prop) {
		// A module loader inspects what it imports before anyone uses it: it
		// reads `then` to decide whether the namespace is thenable, and various
		// symbols for interop and formatting. Throwing on those turns a plain
		// import into a crash far from any real use.
		if (typeof prop === "symbol" || prop === "then") return undefined;
		if (!instance) {
			throw new Error(
				"[prism] Prism singleton accessed before PrismProvider.boot() ran " +
					"or `setPrism(myPrism)` was called. Wire one of them first.",
			);
		}
		const value = Reflect.get(instance, prop);
		return typeof value === "function" ? value.bind(instance) : value;
	},
});

export default images;
