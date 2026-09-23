import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
/**
 * Read a stub the way `codemods.makeUsingStub` does.
 *
 * The real file, not a fixture: a test that stubbed this out would pass with
 * a stub that does not exist.
 */
function renderStub(
	stubsRoot: string,
	stubPath: string,
	state: Record<string, string | number | boolean>,
): { to: string; body: string } {
	const raw = readFileSync(resolve(stubsRoot, stubPath), "utf8");
	const [, front = "", body = ""] = raw.split(/^---\r?\n/m, 3);
	const declared = /^to:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? "";
	const render = (text: string): string =>
		text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) =>
			state[key] === undefined ? match : String(state[key]),
		);
	return { to: render(declared), body: render(body) };
}

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
			has(token: unknown): boolean {
				return bindings.has(token);
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
			makeUsingStub: vi.fn(
				async (
					stubsRoot: string,
					stubPath: string,
					state: Record<string, string | number | boolean> = {},
				) => {
					const { to, body } = renderStub(stubsRoot, stubPath, state);
					written.set(to, body);
					return { path: to, contents: body };
				},
			),
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

describe("PrismProvider and the image endpoint", () => {
	/** A host that also carries a router, as Ream's container does. */
	function withRouter(config: Record<string, unknown>): {
		host: PrismAppContext;
		paths: string[];
	} {
		const host = app(config);
		const paths: string[] = [];
		host.bindings.set("router", () => ({
			get(path: string) {
				paths.push(path);
				return undefined;
			},
		}));
		return { host, paths };
	}

	it("mounts nothing when the config does not ask for it", async () => {
		clearPrism();
		const { host, paths } = withRouter({ images: defineConfig({}) });
		const provider = new PrismProvider(host);
		provider.register();
		await provider.boot();
		expect(paths).toEqual([]);
		await provider.shutdown();
	});

	it("mounts the endpoint where the config puts it", async () => {
		clearPrism();
		const { host, paths } = withRouter({
			images: defineConfig({
				serve: { roots: ["/srv/public"], path: "/__image" },
			}),
		});
		const provider = new PrismProvider(host);
		provider.register();
		await provider.boot();
		expect(paths).toEqual(["/__image"]);
		await provider.shutdown();
	});

	it("refuses to boot with an endpoint that could serve nothing", async () => {
		// A `serve` block with no roots is a configuration mistake that would
		// otherwise surface as every image 404ing in production.
		clearPrism();
		const { host } = withRouter({
			images: defineConfig({ serve: { roots: [] } }),
		});
		const provider = new PrismProvider(host);
		provider.register();
		await expect(provider.boot()).rejects.toThrow(/no roots/);
	});

	it("leaves the endpoint unmounted outside Ream", async () => {
		// No `router` in the container: the host wires `registerImageRoute`
		// itself rather than the provider guessing at an HTTP layer.
		clearPrism();
		const provider = new PrismProvider(
			app({ images: defineConfig({ serve: { roots: ["/srv/public"] } }) }),
		);
		provider.register();
		await expect(provider.boot()).resolves.toBeUndefined();
		await provider.shutdown();
	});
});
