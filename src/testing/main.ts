/**
 * Test helpers. Per the cohort convention, a package's fakes live on its own
 * `/testing` subpath rather than in the runner.
 */

import { Prism } from "../Prism.js";
import { clearPrism, setPrism } from "../services/main.js";
import type { PrismConfig } from "../types.js";

/**
 * Publish a Prism on `services/main` for the duration of a test.
 *
 * The real engine, not a stub: image work has no meaningful fake — an
 * assertion about a thumbnail's dimensions is only worth making against the
 * code that produces it.
 */
export function fakeImages(config: PrismConfig = {}): {
	images: Prism;
	restore: () => void;
} {
	const images = new Prism(config);
	setPrism(images);
	return { images, restore: () => clearPrism() };
}
