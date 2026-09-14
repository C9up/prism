import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		coverage: {
			provider: "v8",
			include: ["src/**"],
			// `src/native/generated.ts` is written from the Rust by
			// `pnpm build:napi-types` and contains only declarations, and
			// `src/vendor/**` is generated from scripts/vendor/ and identical in
			// every package that carries it — measuring either here holds this
			// package to a floor for code it cannot change.
			exclude: ["src/**/*.d.ts", "src/native/generated.ts", "src/vendor/**"],
			reporter: ["text-summary", "json-summary"],
			// A floor, not a target: set just under what the suite covers today,
			// so a change that stops testing a path fails here instead of
			// landing. Branches sit lower than the rest because the "native
			// binary is missing" arms cannot be exercised in a process that has
			// successfully loaded it.
			thresholds: {
				lines: 95,
				statements: 92,
				branches: 80,
				functions: 94,
			},
		},
	},
});
