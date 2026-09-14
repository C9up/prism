import { describe, expect, it, vi } from "vitest";
import { configure } from "../../src/configure.js";
import { defineConfig, Prism } from "../../src/Prism.js";
import PrismProvider, {
	type PrismAppContext,
} from "../../src/PrismProvider.js";
import images, {
	clearPrism,
	getPrism,
	setPrism,
} from "../../src/services/main.js";
import { fakeImages } from "../../src/testing/main.js";

/** A fake host — prism must never need the real container to be testable. */
function app(config: Record<string, unknown>): PrismAppContext & {
	bindings: Map<unknown, () => unknown>;
} {
	const bindings = new Map<unknown, () => unknown>();
	const resolved = new Map<unknown, unknown>();
	return {
		bindings,
		container: {
			singleton(token, factory) {
				bindings.set(token, factory);
			},
			async resolve(token: unknown): Promise<unknown> {
				if (!resolved.has(token)) {
					const factory = bindings.get(token);
					if (!factory) throw new Error(`unbound: ${String(token)}`);
					resolved.set(token, await factory());
				}
				return resolved.get(token);
			},
		},
		config: { get: (key: string) => config[key] },
	};
}

describe("PrismProvider", () => {
	it("falls back to the engine's own defaults with no config file", async () => {
		clearPrism();
		const provider = new PrismProvider(app({}));
		provider.register();
		await provider.boot();
		expect(getPrism()).toBeInstanceOf(Prism);
		await provider.shutdown();
	});

	it("refuses a config/images.ts that is not a prism config", async () => {
		const provider = new PrismProvider(app({ images: { limits: "lots" } }));
		provider.register();
		await expect(provider.boot()).rejects.toThrow(/defineConfig/);
	});

	it("passes the configured limits through to the engine", async () => {
		clearPrism();
		const provider = new PrismProvider(
			app({ images: defineConfig({ limits: { maxPixels: 100 } }) }),
		);
		provider.register();
		await provider.boot();
		expect(getPrism()?.config().limits?.maxPixels).toBe(100);
		await provider.shutdown();
	});

	it("binds both the namespaced and the bare container token", () => {
		const host = app({});
		new PrismProvider(host).register();
		expect(host.bindings.has("prism.images")).toBe(true);
		expect(host.bindings.has("images")).toBe(true);
	});

	it("refuses a container that rebound the token to something else", async () => {
		const host = app({});
		const provider = new PrismProvider(host);
		provider.register();
		host.bindings.set(Prism, () => ({ notAPrism: true }));
		await expect(provider.boot()).rejects.toThrow(/not a Prism/);
	});

	it("clears the singleton on shutdown, but only while it is still ours", async () => {
		clearPrism();
		const first = new PrismProvider(app({}));
		first.register();
		await first.boot();
		const second = new PrismProvider(app({}));
		second.register();
		await second.boot();
		const secondEngine = getPrism();
		await first.shutdown();
		expect(getPrism()).toBe(secondEngine);
		await second.shutdown();
		expect(getPrism()).toBeUndefined();
	});
});

describe("services/main", () => {
	it("answers undefined for symbols and `then`, so importing never crashes", () => {
		clearPrism();
		expect(Reflect.get(images, "then")).toBeUndefined();
		expect(Reflect.get(images, Symbol.toStringTag)).toBeUndefined();
	});

	it("reports clearly when used before anything bound it", () => {
		clearPrism();
		expect(() => images.inspect(Buffer.alloc(0))).toThrow(
			/before PrismProvider.boot/,
		);
	});

	it("forwards to the bound engine with methods still bound to it", () => {
		const engine = new Prism({ quality: 55 });
		setPrism(engine);
		try {
			const { config } = images;
			expect(config().quality).toBe(55);
			expect(getPrism()).toBe(engine);
		} finally {
			clearPrism();
		}
	});

	it("fakeImages publishes an engine and hands back its teardown", () => {
		const { images: fake, restore } = fakeImages({ quality: 70 });
		expect(fake.config().quality).toBe(70);
		expect(getPrism()).toBe(fake);
		restore();
		expect(getPrism()).toBeUndefined();
	});
});

describe("configure", () => {
	it("registers the provider and declares the env var its config reads", async () => {
		const written = new Map<string, string>();
		const codemods = {
			addProvider: vi.fn().mockResolvedValue(undefined),
			addEnvVars: vi.fn().mockResolvedValue(undefined),
			writeFile: vi.fn(async (path: string, content: string) => {
				written.set(path, content);
			}),
		};
		await configure(codemods);
		expect(codemods.addProvider).toHaveBeenCalledWith("@c9up/prism/provider");
		expect(codemods.addEnvVars).toHaveBeenCalledWith({
			IMAGE_MAX_PIXELS: "50000000",
		});
		const config = written.get("config/images.ts") ?? "";
		expect(config).toContain("defineConfig({");
		expect(config).toContain("maxPixels");
		expect(config).toContain("autoOrient");
	});
});
