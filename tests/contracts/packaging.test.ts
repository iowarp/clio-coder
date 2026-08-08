import { ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

interface ReleaseManifest {
	requiredFiles: string[];
	requiredPrefixes: string[];
}

function readJson<T>(relative: string): T {
	return JSON.parse(readFileSync(join(root, relative), "utf8")) as T;
}

const manifest = readJson<ReleaseManifest>("scripts/release-manifest.json");
const packageFiles = readJson<{ files: string[] }>("package.json").files;

/**
 * Whether the package.json `files` allowlist ships `path`. Covers the three
 * pattern shapes the allowlist actually uses: an exact path, a bare directory
 * that npm expands recursively, and a `**`/`*` glob. Negations are skipped
 * here and asserted separately.
 */
function shippedBy(path: string): boolean {
	for (const pattern of packageFiles) {
		if (pattern.startsWith("!")) continue;
		if (pattern === path) return true;
		if (pattern.endsWith("/**") && path.startsWith(pattern.slice(0, -2))) return true;
		if (!pattern.includes("*") && path.startsWith(`${pattern}/`)) return true;
		const star = pattern.indexOf("*");
		if (star !== -1 && !pattern.includes("**")) {
			const [dir, suffix] = [pattern.slice(0, star), pattern.slice(star + 1)];
			if (path.startsWith(dir) && path.endsWith(suffix) && !path.slice(dir.length).includes("/")) return true;
		}
	}
	return false;
}

/** Paths git refuses to track. Generated runtime state lives here. */
function gitIgnored(paths: ReadonlyArray<string>): Set<string> {
	if (paths.length === 0) return new Set();
	try {
		const out = execFileSync("git", ["check-ignore", "--", ...paths], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		return new Set(out.split("\n").filter((line) => line.length > 0));
	} catch {
		// `git check-ignore` exits 1 when nothing matched, which is the clean case.
		return new Set();
	}
}

describe("contracts/packaging", () => {
	it("ships every file the release gate requires", () => {
		const missing = manifest.requiredFiles.filter((file) => !shippedBy(file));
		strictEqual(missing.join(", "), "", `release gate requires files the package.json allowlist does not ship`);
	});

	it("ships every resource tree the release gate requires", () => {
		const missing = manifest.requiredPrefixes.filter((prefix) => !shippedBy(`${prefix}probe`));
		strictEqual(missing.join(", "), "", `release gate requires trees the package.json allowlist does not ship`);
	});

	/**
	 * The root cause of the CLIO.md packaging defect. A gitignored path is
	 * generated runtime state: npm packs from the working tree, so shipping one
	 * publishes whatever the release machine happened to generate, and requiring
	 * one fails the gate on a clean checkout. Neither is a thing a release can do.
	 */
	it("neither ships nor requires gitignored generated state", () => {
		const candidates = [...new Set([...manifest.requiredFiles, ...packageFiles.filter((f) => !f.startsWith("!"))])];
		const ignored = gitIgnored(candidates.filter((path) => !path.includes("*")));
		// dist/ is gitignored by design: it is a build output the tarball must carry.
		const offenders = [...ignored].filter((path) => path !== "dist" && !path.startsWith("dist/"));
		strictEqual(offenders.join(", "), "", "gitignored generated state on the publish path");
	});

	it("requires only source-tracked files that exist in the checkout", () => {
		const absent = manifest.requiredFiles
			.filter((file) => !file.startsWith("dist/"))
			.filter((file) => !existsSync(join(root, file)));
		strictEqual(absent.join(", "), "", "release gate requires files absent from the checkout");
	});

	it("keeps the release gate reading the shared manifest rather than its own copy", () => {
		const gate = readFileSync(join(root, "scripts/check-release.mjs"), "utf8");
		ok(gate.includes("release-manifest.json"), "check-release.mjs must read the shared manifest");
	});
});
