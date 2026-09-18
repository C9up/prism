/**
 * PrismProvider — publishes a {@link Prism} built from `config/images.ts`.
 *
 *   // reamrc.ts
 *   providers: [() => import("@c9up/prism/provider")]
 *
 *   // config/images.ts
 *   import { defineConfig } from "@c9up/prism"
 *   export default defineConfig({ limits: { maxPixels: 40_000_000 } })
 */

import "./augmentations.js";
import { type ImageRouter, registerImageRoute } from "./ImageEndpoint.js";
import { Prism } from "./Prism.js";
import { clearPrism, getPrism, setPrism } from "./services/main.js";
import type { PrismConfig } from "./types.js";

interface PrismContainer {
	singleton(token: unknown, factory: () => unknown): void;
	has(token: unknown): boolean;
	/**
	 * `unknown`, not a generic `resolve<T>`: a signature promising a type
	 * nothing verified cannot be implemented without an unchecked cast, so the
	 * check lives here instead. ream's own generic container satisfies this.
	 */
	resolve(token: unknown): Promise<unknown>;
}
interface PrismConfigStore {
	get(key: string): unknown;
}
export interface PrismAppContext {
	container: PrismContainer;
	config: PrismConfigStore;
}

function isRouter(value: unknown): value is ImageRouter {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof Reflect.get(value, "get") === "function"
	);
}

function isPrismConfig(value: unknown): value is PrismConfig {
	if (typeof value !== "object" || value === null) return false;
	const limits = Reflect.get(value, "limits");
	return (
		limits === undefined || (typeof limits === "object" && limits !== null)
	);
}

export default class PrismProvider {
	constructor(protected app: PrismAppContext) {}

	#images: Prism | undefined;

	async #resolvePrism(): Promise<Prism> {
		const resolved = await this.app.container.resolve(Prism);
		if (!(resolved instanceof Prism)) {
			throw new Error(
				"[prism] the container returned something that is not a Prism for the Prism token.",
			);
		}
		return resolved;
	}

	register(): void {
		this.app.container.singleton(Prism, () => {
			const raw = this.app.config.get("images");
			// No config file is not a failure: the engine's own defaults are
			// deliberately conservative. A config that EXISTS but is not a
			// prism config is a typo in a file the author believed was read.
			if (raw === undefined) return new Prism();
			if (!isPrismConfig(raw)) {
				throw new Error(
					"[prism] config/images.ts must export defineConfig({ ... }).",
				);
			}
			return new Prism(raw);
		});
		const images = (): Promise<Prism> => this.#resolvePrism();
		this.app.container.singleton("prism.images", images);
		this.app.container.singleton("images", images);
	}

	/**
	 * Publish at BOOT.
	 *
	 * The HTTP socket opens before providers are readied, so an engine
	 * published later leaves a window where a request reaches a controller and
	 * the accessor throws. Building it loads no binary — the engine is loaded
	 * when the module is imported, and using it is what reports a missing one.
	 */
	async boot(): Promise<void> {
		this.#images = await this.#resolvePrism();
		setPrism(this.#images);
		await this.#mountEndpoint(this.#images);
	}

	/**
	 * Mount the transformation endpoint, if the application asked for one.
	 *
	 * Two conditions, and both are refusals to guess. No `serve` block means
	 * the application never asked for a public route that reads files and
	 * burns CPU — installing prism must not add one. No `router` in the
	 * container means the host is not Ream, and the user wires the handler
	 * themselves with `registerImageRoute`.
	 *
	 * The router is resolved rather than imported, which is what keeps this
	 * package usable outside Ream.
	 */
	async #mountEndpoint(images: Prism): Promise<void> {
		const serve = images.config().serve;
		if (serve === undefined) return;
		if (serve.roots.length === 0) {
			throw new Error(
				"[prism] images.serve declares no roots, so the endpoint would serve nothing. Name the directories images may be read from.",
			);
		}
		if (!this.app.container.has("router")) return;
		const router = await this.app.container.resolve("router");
		if (!isRouter(router)) {
			throw new Error(
				"[prism] the container returned something that is not a router for the router token.",
			);
		}
		registerImageRoute(router, images, serve);
	}

	async shutdown(): Promise<void> {
		if (!this.#images) return;
		// Two applications can share a process — parallel tests, a hot reload.
		// Only ours to clear while it still points at what this provider booted.
		if (getPrism() === this.#images) clearPrism();
		this.#images = undefined;
	}
}
