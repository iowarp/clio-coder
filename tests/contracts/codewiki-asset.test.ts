/**
 * The package's own code map, dist/assets/codewiki.json, is generated at build
 * from the tree being packed (scripts/build-codewiki-asset.ts). These hold the
 * built artifact to that claim: it parses as a codewiki, its file entries name
 * files that `src/**` actually ships, and it is regenerated rather than stale,
 * so a sampled entry's content hash matches the source file on disk right now.
 * `npm run build` must have run; ci builds before it tests.
 */
import { ok, strictEqual } from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseCodewikiRaw } from "../../src/domains/context/codewiki/indexer.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const assetPath = join(root, "dist", "assets", "codewiki.json");

/** Mirrors indexer.ts contentHash: sha256 of the utf8 text, first 16 hex chars. */
function contentHash(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function loadAsset() {
	ok(existsSync(assetPath), "dist/assets/codewiki.json must exist; run npm run build");
	const raw = readFileSync(assetPath, "utf8");
	const codewiki = parseCodewikiRaw(raw);
	ok(codewiki, "dist/assets/codewiki.json must parse as a codewiki");
	return { raw, codewiki };
}

describe("contracts/codewiki-asset", () => {
	it("parses and describes the checkout at package scale", () => {
		const { codewiki } = loadAsset();
		ok(codewiki.files.length >= 500, `expected the package index to cover the source tree, saw ${codewiki.files.length}`);
		ok(codewiki.symbols.length >= 5000, `expected thousands of symbols, saw ${codewiki.symbols.length}`);
		const srcEntries = codewiki.files.filter((file) => file.path.startsWith("src/"));
		ok(srcEntries.length >= 500, `expected src/ to dominate the index, saw ${srcEntries.length}`);
		const outsidePack = codewiki.files
			.map((file) => file.path)
			.filter((path) => path.startsWith("tests/") || path.startsWith("scripts/"));
		strictEqual(
			outsidePack.join(", "),
			"",
			"the index describes the packed tree only; tests/ and scripts/ are not shipped",
		);
	});

	it("names only relative POSIX paths and carries no local state", () => {
		const { raw, codewiki } = loadAsset();
		const offenders = codewiki.files
			.map((file) => file.path)
			.filter(
				(path) =>
					path.startsWith("/") || path.includes("\\") || path.startsWith(".clio-coder/") || path.startsWith("dist/"),
			);
		strictEqual(
			offenders.join(", "),
			"",
			"index paths must be relative to the package root and never name local state or dist",
		);
		strictEqual(raw.includes(root), false, "the packed index must not embed the build machine's absolute path");
		strictEqual(
			/"generatedAt"|"lastIndexedAt"|mtimeMs/.test(raw),
			false,
			"no timestamps or fingerprints in the packed index",
		);
	});

	it("is regenerated from the packed source, not stale", () => {
		const { codewiki } = loadAsset();
		const srcEntries = codewiki.files.filter((file) => file.path.startsWith("src/"));
		// A spread sample: every 25th entry plus the indexer and compiler themselves.
		const sampled = [
			...srcEntries.filter((_, index) => index % 25 === 0),
			...srcEntries.filter((file) =>
				["src/domains/context/codewiki/indexer.ts", "src/domains/prompts/compiler.ts", "src/cli/index.ts"].includes(
					file.path,
				),
			),
		];
		ok(sampled.length >= 20, `expected a meaningful sample, saw ${sampled.length}`);
		const missing: string[] = [];
		const stale: string[] = [];
		for (const file of sampled) {
			const abs = join(root, file.path);
			if (!existsSync(abs)) {
				missing.push(file.path);
				continue;
			}
			if (contentHash(readFileSync(abs, "utf8")) !== file.hash) stale.push(file.path);
		}
		strictEqual(missing.join(", "), "", "index entries must exist under the packed src/ tree");
		strictEqual(stale.join(", "), "", "index hashes must match the packed source; rebuild regenerates the asset");
	});
});
