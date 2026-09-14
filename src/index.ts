/**
 * Prism — image processing for the Ream framework.
 *
 *   import { Prism } from "@c9up/prism"
 *
 *   const images = new Prism()
 *   const thumb = await images
 *     .edit(upload)
 *     .resize({ width: 300, height: 300, fit: "cover" })
 *     .toFormat("webp")
 */

// Contributes this package's tokens to ream's ContainerBindings. Type-only.
import "./augmentations.js";

export {
	PRISM_CODES,
	type PrismCode,
	PrismError,
	PrismNativeRequiredError,
} from "./errors.js";
export { isNativeAvailable } from "./native.js";
export { defineConfig, Pipeline, Prism } from "./Prism.js";
export type {
	Colour,
	CompositeOptions,
	CropOptions,
	Fit,
	ImageFormat,
	Limits,
	Metadata,
	Operation,
	OutputOptions,
	PrismConfig,
	ResizeOptions,
	WatermarkTextOptions,
} from "./types.js";
