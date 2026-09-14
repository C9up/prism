/**
 * The gate that reads what the test run actually did.
 *
 * A vitest exit code says "nothing failed", which is also what it says when
 * nothing ran, or when the cases that matter were skipped because the native
 * binary would not load. On a matrix whose entire purpose is to produce
 * loadable binaries for five platforms, that distinction is the whole signal.
 *
 * Reads `test-results.json` (vitest's `--reporter=json --outputFile=`) from the
 * working directory, or from the path given as the first argument.
 *
 * Written as a file rather than inlined in the workflow so it can be run
 * against a real report on a developer's machine — a gate nobody can exercise
 * outside CI is a gate nobody has tested.
 */

import { readFileSync } from "node:fs";

/**
 * The case that exercises the DECODER.
 *
 * Decoding is the whole thing prism's dav1d apparatus buys: AVIF encoding is
 * pure Rust and would work with no system library at all. A suite that went
 * green without this case would say nothing about whether the binary can read
 * back what it writes.
 */
const AVIF_ROUND_TRIP =
	"identifies back everything except TGA, which has no leading signature";

function fail(message) {
	// The `::error::` prefix is what puts the line in the job summary rather
	// than only in the log, where a reader has to go looking for it.
	console.log(`::error::${message}`);
	process.exit(1);
}

const path = process.argv[2] ?? "test-results.json";

let report;
try {
	report = JSON.parse(readFileSync(path, "utf8"));
} catch (error) {
	fail(
		`${path} unreadable — vitest failed before writing it: ${error instanceof Error ? error.message : String(error)}`,
	);
}

const cases = (report.testResults ?? []).flatMap(
	(file) => file.assertionResults ?? [],
);

if (cases.length === 0) {
	fail("0 tests ran — test discovery is broken (check the vitest include glob)");
}

const skipped = cases.filter((testCase) => testCase.status === "skipped");
if (skipped.length !== 0) {
	fail(
		`${skipped.length} tests skipped — check the NAPI binary load path: ${skipped
			.slice(0, 3)
			.map((testCase) => testCase.title)
			.join(" | ")}`,
	);
}

const avif = cases.find((testCase) => testCase.title === AVIF_ROUND_TRIP);
if (avif?.status !== "passed") {
	fail(
		`the AVIF round-trip case is '${avif?.status ?? "missing"}' — dav1d is not decoding in this build`,
	);
}

console.log(`${cases.length} tests, none skipped, AVIF round-tripped`);
