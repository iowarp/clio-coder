import { ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { buildCodewiki, writeCodewiki } from "../../src/domains/context/codewiki/indexer.js";
import {
	computeFingerprint,
	computeFingerprintCached,
	type Fingerprint,
	isStale,
} from "../../src/domains/context/fingerprint.js";

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

function treeHashForPaths(cwd: string, relPaths: ReadonlyArray<string>): string {
	const hash = createHash("sha256");
	for (const relPath of [...relPaths].sort((a, b) => a.localeCompare(b))) {
		const stat = statSync(join(cwd, relPath));
		hash.update(`${relPath}:${stat.size}:${Math.floor(stat.mtimeMs)}\n`);
	}
	return hash.digest("hex");
}

describe("contracts/fingerprint", () => {
	it("only marks indexable file changes stale", () => {
		const cwd = scratchProject();
		const sourcePath = join(cwd, "src", "index.ts");
		writeFileSync(sourcePath, "export const value = 1;\n", "utf8");
		const initial = computeFingerprint(cwd);

		const readmePath = join(cwd, "README.md");
		writeFileSync(readmePath, "# Fixture\n", "utf8");
		strictEqual(computeFingerprint(cwd).treeHash, initial.treeHash);

		writeFileSync(readmePath, "# Fixture\n\nUpdated notes.\n", "utf8");
		strictEqual(computeFingerprint(cwd).treeHash, initial.treeHash);

		writeFileSync(join(cwd, "src", "extra.ts"), "export const extra = 1;\n", "utf8");
		const withExtraSource = computeFingerprint(cwd);
		strictEqual(isStale(initial, withExtraSource), true);
	});

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

	it("matches the codewiki indexer file set", async () => {
		const cwd = scratchProject();
		mkdirSync(join(cwd, "scripts"), { recursive: true });
		mkdirSync(join(cwd, "assets"), { recursive: true });
		mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
		writeFileSync(join(cwd, "src", "index.ts"), "export const value = 1;\n", "utf8");
		writeFileSync(join(cwd, "src", "types.d.ts"), "export interface Ignored {}\n", "utf8");
		writeFileSync(join(cwd, "scripts", "tool.py"), "print('indexed')\n", "utf8");
		writeFileSync(join(cwd, "package.json"), '{"name":"fixture"}\n', "utf8");
		writeFileSync(join(cwd, "README.md"), "# Not indexed\n", "utf8");
		writeFileSync(join(cwd, "assets", "logo.svg"), "<svg />\n", "utf8");
		writeFileSync(join(cwd, "node_modules", "pkg", "index.ts"), "export const ignored = true;\n", "utf8");

		const codewiki = await buildCodewiki({ cwd, language: "typescript" });
		const indexedPaths = codewiki.files.map((file) => file.path);

		strictEqual(indexedPaths.length, 3);
		strictEqual(computeFingerprint(cwd, codewiki).treeHash, treeHashForPaths(cwd, indexedPaths));
	});

	it("caches fingerprints within the ttl and refreshes after expiry", async () => {
		const cwd = scratchProject();
		const filePath = join(cwd, "src", "index.ts");
		writeFileSync(filePath, "export const value = 1;\n", "utf8");

		const first = computeFingerprintCached(cwd, null, { ttlMs: 10 });
		const second = computeFingerprintCached(cwd, null, { ttlMs: 10 });
		strictEqual(second, first);

		await delay(20);
		writeFileSync(filePath, "export const value = 100;\n", "utf8");
		const third = computeFingerprintCached(cwd, null, { ttlMs: 10 });

		strictEqual(isStale(first, third), true);
	});

	it("ignores gitignored scratch directories when detecting drift", () => {
		const cwd = scratchProject();
		writeFileSync(join(cwd, "src", "index.ts"), "export const value = 1;\n", "utf8");
		const prev = computeFingerprint(cwd);

		for (const dir of [".superpowers", ".codex", ".claude", ".clio-benchmark"]) {
			mkdirSync(join(cwd, dir), { recursive: true });
			writeFileSync(join(cwd, dir, "scratch.ts"), "export const scratch = 1;\n", "utf8");
		}
		const curr = computeFingerprint(cwd);

		strictEqual(isStale(prev, curr), false);
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
			version: 5,
			language: "typescript",
			files: [
				{
					id: "f_index",
					path: "src/index.ts",
					lang: "typescript",
					loc: 17,
					role: "entry",
					hash: "1111111111111111",
					imports: [],
				},
				{
					id: "f_package",
					path: "package.json",
					lang: "config",
					loc: 99,
					role: "config",
					hash: "2222222222222222",
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
