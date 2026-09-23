/**
 * `ream configure @c9up/prism` — wire image processing in one command.
 */

import { stubsRoot } from "./stubs.js";

interface Codemods {
	addProvider(importPath: string): Promise<void>;
	addEnvVars(vars: Record<string, string>): Promise<void>;
	writeFile(
		filePath: string,
		content: string,
		options?: { force?: boolean },
	): Promise<void>;
	makeUsingStub(
		stubsRoot: string,
		stubPath: string,
		state?: Record<string, string | number | boolean>,
		options?: { force?: boolean },
	): Promise<{ path: string; contents: string }>;
}

export async function configure(codemods: Codemods): Promise<void> {
	// The config below reads this, so it is declared here. Writing the file
	// without it leaves an application whose config asks the environment for
	// something nothing ever put there.
	await codemods.addEnvVars({
		IMAGE_MAX_PIXELS: "50000000",
	});

	await codemods.addProvider("@c9up/prism/provider");
	await codemods.makeUsingStub(stubsRoot, "config/images.stub");
}
