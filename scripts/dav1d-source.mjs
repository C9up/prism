/**
 * The dav1d source compiled into the published binaries, pinned by commit.
 *
 * With `SYSTEM_DEPS_DAV1D_BUILD_INTERNAL`, dav1d-sys's build script clones
 * dav1d by TAG (`git clone --depth 1 -b 1.5.0 <videolan>`) and compiles what
 * it got, checking nothing. A tag can be moved, and that source ends up
 * statically linked into every prebuilt binary on npm. The build script is a
 * crate from crates.io and cannot be changed here, so its clone is pointed at
 * a source checked beforehand:
 *
 *   node scripts/dav1d-source.mjs fetch <dir>
 *     fetches the tag into a bare repository at <dir>, refuses it unless it
 *     peels to the commit below, and has every later git process clone that
 *     repository instead of videolan's (`url.<dir>.insteadOf`, through the
 *     GIT_CONFIG_* environment, written to $GITHUB_ENV in Actions and printed
 *     otherwise). The build script's clone then never reaches the network.
 *
 *   node scripts/dav1d-source.mjs verify <target-dir>
 *     after the build, refuses unless every dav1d checkout the build script
 *     left under <target-dir> is at the commit below: the proof that the
 *     redirect took effect, whatever git the runner has.
 *
 * Moving dav1d is a deliberate edit of the tag AND the commit, checked
 * against the tag on code.videolan.org and its GitHub mirror, and of the
 * dav1d-sys version whose build script clones it.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** What dav1d-sys 0.8.3's build.rs clones (its REPO and TAG). */
const REPOSITORY = "https://code.videolan.org/videolan/dav1d.git";
const TAG = "1.5.0";
/** `refs/tags/1.5.0^{}` on code.videolan.org and github.com/videolan/dav1d. */
const COMMIT = "32cf02af50f32af108a3b281c452788dccdac648";

function git(args, cwd) {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
	}).trim();
}

function fail(message) {
	console.error(`::error::${message}`);
	process.exit(1);
}

function fetch(directory) {
	const mirror = resolve(directory);
	if (existsSync(mirror) && readdirSync(mirror).length > 0) {
		fail(`${mirror} is not empty; dav1d is fetched into a fresh directory`);
	}
	git(["init", "--quiet", "--bare", mirror]);
	git(
		[
			"fetch",
			"--quiet",
			"--depth",
			"1",
			REPOSITORY,
			`+refs/tags/${TAG}:refs/tags/${TAG}`,
		],
		mirror,
	);
	const fetched = git(["rev-parse", `refs/tags/${TAG}^{commit}`], mirror);
	if (fetched !== COMMIT) {
		fail(
			`dav1d tag ${TAG} is commit ${fetched}, not the pinned ${COMMIT}: refusing to build it`,
		);
	}
	console.log(`dav1d ${TAG} is ${COMMIT}, as pinned`);

	// Appended to whatever git configuration the environment already passes.
	const index = Number(process.env.GIT_CONFIG_COUNT ?? "0");
	if (!Number.isSafeInteger(index) || index < 0) {
		fail(`GIT_CONFIG_COUNT is ${process.env.GIT_CONFIG_COUNT}`);
	}
	const lines = [
		`GIT_CONFIG_KEY_${index}=url.${pathToFileURL(mirror).href}.insteadOf`,
		`GIT_CONFIG_VALUE_${index}=${REPOSITORY}`,
		`GIT_CONFIG_COUNT=${index + 1}`,
	];
	if (process.env.GITHUB_ENV) {
		appendFileSync(process.env.GITHUB_ENV, `${lines.join("\n")}\n`);
	} else {
		console.log(lines.join("\n"));
	}
}

/** The dav1d checkouts dav1d-sys left: <profile>/build/dav1d-sys-* /out/dav1d. */
function checkouts(target) {
	const found = [];
	const visit = (directory, depth) => {
		for (const name of readdirSync(directory)) {
			const path = join(directory, name);
			if (!statSync(path).isDirectory()) continue;
			if (name.startsWith("dav1d-sys-") && directory.endsWith("build")) {
				const source = join(path, "out", "dav1d");
				if (existsSync(source)) found.push(source);
			} else if (depth > 0 && name !== "deps" && name !== "incremental") {
				visit(path, depth - 1);
			}
		}
	};
	visit(resolve(target), 3);
	return found;
}

function verify(target) {
	const sources = checkouts(target);
	if (sources.length === 0) {
		fail(
			`no dav1d checkout under ${target}: the build did not compile dav1d itself`,
		);
	}
	for (const source of sources) {
		const head = git(["rev-parse", "HEAD"], source);
		if (head !== COMMIT) {
			fail(`${source} is at ${head}, not the pinned ${COMMIT}`);
		}
		console.log(`${source}: ${COMMIT}`);
	}
}

const [command, path] = process.argv.slice(2);
if (command === "fetch" && path) fetch(path);
else if (command === "verify" && path) verify(path);
else fail("usage: dav1d-source.mjs fetch <dir> | verify <target-dir>");
