import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { writeCodewiki } from "../../src/domains/context/codewiki/indexer.js";
import { computeFingerprint, type Fingerprint, isStale } from "../../src/domains/context/fingerprint.js";

const scratchRoots: string[] = [];

afterEach(() => {
	for (const root of scratchRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function scratchProject(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-fingerprint-"));
	scratchRoots.push(root);
	mkdirSync(join(root, "src"), { recursive: true });
	return root;
}

describe("contracts/fingerprint", () => {
	it("marks same-size content edits stale through file mtime", () => {
		const cwd = scratchProject();
		const filePath = join(cwd, "src", "index.ts");
		writeFileSync(filePath, "export const value = 1;\n", "utf8");
		const initialStat = statSync(filePath);
		const prev = computeFingerprint(cwd);

		writeFileSync(filePath, "export const value = 2;\n", "utf8");
		const future = new Date(Math.floor(initialStat.mtimeMs) + 2_000);
		utimesSync(filePath, future, future);
		const curr = computeFingerprint(cwd);

		strictEqual(isStale(prev, curr), true);
	});

	it("does not treat a git-head-only change as stale", () => {
		const prev: Fingerprint = { treeHash: "a".repeat(64), gitHead: "1".repeat(40), loc: 10 };
		const curr: Fingerprint = { treeHash: prev.treeHash, gitHead: "2".repeat(40), loc: prev.loc };

		strictEqual(isStale(prev, curr), false);
	});

	it("sources loc from codewiki when present and falls back to counting files when absent", () => {
		const withArtifact = scratchProject();
		writeFileSync(join(withArtifact, "src", "index.ts"), "export const actual = true;\n", "utf8");
		writeFileSync(join(withArtifact, "package.json"), '{"name":"fixture"}\n', "utf8");
		writeCodewiki(withArtifact, {
			version: 4,
			language: "typescript",
			files: [
				{
					id: "f_index",
					path: "src/index.ts",
					lang: "typescript",
					loc: 17,
					role: "entry",
					hash: "hash-index",
					imports: [],
				},
				{
					id: "f_package",
					path: "package.json",
					lang: "config",
					loc: 99,
					role: "config",
					hash: "hash-package",
					imports: [],
				},
			],
			symbols: [],
			edges: [],
		});

		strictEqual(computeFingerprint(withArtifact).loc, 17);

		const withoutArtifact = scratchProject();
		writeFileSync(join(withoutArtifact, "src", "index.ts"), "export const fallback = true;\n", "utf8");

		ok(computeFingerprint(withoutArtifact).loc > 0);
	});
});
