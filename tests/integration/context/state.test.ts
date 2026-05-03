import { strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readClioState, statePath, writeClioState } from "../../../src/domains/context/state.js";

describe("context/state", () => {
	it("round-trips .clio/state.json", () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-state-"));
		try {
			writeClioState(dir, {
				version: 1,
				projectType: "typescript",
				fingerprint: { treeHash: "1".repeat(64), gitHead: null, loc: 10 },
				lastInitAt: "2026-05-01T00:00:00.000Z",
			});
			const state = readClioState(dir);
			strictEqual(state?.projectType, "typescript");
			strictEqual(state?.fingerprint.treeHash, "1".repeat(64));
			strictEqual(statePath(dir), join(dir, ".clio", "state.json"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns null for missing or invalid state", () => {
		const dir = mkdtempSync(join(tmpdir(), "clio-state-empty-"));
		try {
			strictEqual(readClioState(dir), null);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
