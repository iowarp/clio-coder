import { notStrictEqual, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { computeFingerprint, isStale } from "../../../src/domains/context/fingerprint.js";

function scratch(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "clio-fp-"));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("context/fingerprint", () => {
	it("is deterministic for the same tree and ignores .clio", () => {
		const t = scratch();
		try {
			writeFileSync(join(t.dir, "src.ts"), "export const x = 1;\n");
			mkdirSync(join(t.dir, ".clio"));
			writeFileSync(join(t.dir, ".clio", "state.json"), "{}\n");
			const first = computeFingerprint(t.dir);
			const second = computeFingerprint(t.dir);
			strictEqual(first.treeHash, second.treeHash);
			strictEqual(first.loc, second.loc);
		} finally {
			t.cleanup();
		}
	});

	it("changes when a tracked file size changes", () => {
		const t = scratch();
		try {
			const file = join(t.dir, "src.ts");
			writeFileSync(file, "export const x = 1;\n");
			const first = computeFingerprint(t.dir);
			writeFileSync(file, "export const x = 123;\n");
			const second = computeFingerprint(t.dir);
			notStrictEqual(first.treeHash, second.treeHash);
		} finally {
			t.cleanup();
		}
	});

	it("uses the locked staleness threshold", () => {
		const prev = { treeHash: "a".repeat(64), gitHead: "old", loc: 100 };
		strictEqual(isStale(prev, { treeHash: "b".repeat(64), gitHead: "new", loc: 100 }), true);
		strictEqual(isStale(prev, { treeHash: "a".repeat(64), gitHead: "old", loc: 109 }), false);
		strictEqual(isStale(prev, { treeHash: "a".repeat(64), gitHead: "old", loc: 111 }), true);
	});
});
