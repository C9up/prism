/**
 * `ream configure @c9up/prism` — wire image processing in one command.
 */

interface Codemods {
	addProvider(importPath: string): Promise<void>;
	addEnvVars(vars: Record<string, string>): Promise<void>;
	writeFile(
		filePath: string,
		content: string,
		options?: { force?: boolean },
	): Promise<void>;
}

export async function configure(codemods: Codemods): Promise<void> {
	// The config below reads this, so it is declared here. Writing the file
	// without it leaves an application whose config asks the environment for
	// something nothing ever put there.
	await codemods.addEnvVars({
		IMAGE_MAX_PIXELS: "50000000",
	});

	await codemods.addProvider("@c9up/prism/provider");
	await codemods.writeFile(
		"config/images.ts",
		`import { defineConfig } from '@c9up/prism'
import env from '#start/env'

export default defineConfig({
  limits: {
    // The decompression-bomb bound. A 40 KB PNG can declare 50000x50000,
    // and decoding it asks for ten gigabytes before anything objects.
    maxPixels: Number(env.get('IMAGE_MAX_PIXELS', '50000000')),
    // 64 MiB.
    maxBytes: 64 * 1024 * 1024,
  },

  // Default output quality for formats that have the knob.
  quality: 82,

  // Apply the EXIF orientation on decode. Turning this off serves the
  // sensor's pixels, which is almost never what a viewer expects.
  autoOrient: true,
})`,
	);
}
