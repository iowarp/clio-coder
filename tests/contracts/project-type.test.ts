import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { detectProjectProfile, detectProjectType } from "../../src/domains/session/workspace/project-type.js";

describe("contracts/project-type", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-project-type-"));
	});

	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	it("detects nested Python from source files and manifests", () => {
		mkdirSync(join(scratch, "tools", "rendergit"), { recursive: true });
		writeFileSync(join(scratch, "tools", "rendergit", "pyproject.toml"), "[project]\nname = 'rendergit'\n", "utf8");
		writeFileSync(join(scratch, "tools", "rendergit", "rendergit.py"), "def main():\n    return 0\n", "utf8");

		const profile = detectProjectProfile(scratch);

		strictEqual(profile.projectType, "python");
		strictEqual(profile.dominantLanguage, "python");
		strictEqual(profile.sourceFiles, 1);
		strictEqual(profile.languageCounts.python, 1);
		strictEqual(profile.manifestCounts.python, 1);
	});

	it("reports polyglot when no language is over the 70 percent threshold", () => {
		mkdirSync(join(scratch, "src"), { recursive: true });
		writeFileSync(join(scratch, "src", "index.ts"), "export const value = 1;\n", "utf8");
		writeFileSync(join(scratch, "src", "worker.py"), "def worker():\n    return True\n", "utf8");

		const profile = detectProjectProfile(scratch);

		strictEqual(profile.projectType, "polyglot");
		strictEqual(profile.polyglot, true);
		deepStrictEqual(
			{
				typescript: profile.languageCounts.typescript,
				python: profile.languageCounts.python,
			},
			{ typescript: 1, python: 1 },
		);
	});

	it("uses the dominant language when it is over the threshold", () => {
		mkdirSync(join(scratch, "pkg"), { recursive: true });
		writeFileSync(join(scratch, "pkg", "a.py"), "def a():\n    return 1\n", "utf8");
		writeFileSync(join(scratch, "pkg", "b.py"), "def b():\n    return 2\n", "utf8");
		writeFileSync(join(scratch, "pkg", "c.py"), "def c():\n    return 3\n", "utf8");
		writeFileSync(join(scratch, "pkg", "index.ts"), "export const value = 1;\n", "utf8");

		strictEqual(detectProjectType(scratch), "python");
	});

	it("returns unknown only when no source or manifest signal exists", () => {
		writeFileSync(join(scratch, "README.md"), "# Notes\n", "utf8");

		const profile = detectProjectProfile(scratch);

		strictEqual(profile.projectType, "unknown");
		strictEqual(profile.sourceFiles, 0);
	});
});
