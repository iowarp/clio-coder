/** JSON trace commands keep their machine-readable contract before the first trace database exists. */

import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { makeScratchHome, runCli } from "../harness/spawn.js";

describe("empty trace JSON contract", { concurrency: false }, () => {
	it("returns an empty array from trace runs --json", async () => {
		const scratch = makeScratchHome("clio-trace-empty-runs-");
		try {
			const result = await runCli(["trace", "runs", "--json"], { env: scratch.env });
			strictEqual(result.code, 0, result.stderr);
			deepStrictEqual(JSON.parse(result.stdout), []);
			strictEqual(result.stderr, "");
		} finally {
			scratch.cleanup();
		}
	});

	it("returns a structured no-op from trace prune --json", async () => {
		const scratch = makeScratchHome("clio-trace-empty-prune-");
		try {
			const result = await runCli(["trace", "prune", "--json"], { env: scratch.env });
			strictEqual(result.code, 0, result.stderr);
			const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
			strictEqual(parsed.available, false);
			strictEqual(parsed.runsRemoved, 0);
			strictEqual(parsed.rowsRemoved, 0);
			strictEqual(parsed.bytesRemoved, 0);
			strictEqual(parsed.vacuumed, false);
			strictEqual(parsed.protectedRuns, 0);
			strictEqual(typeof parsed.policy, "object");
			strictEqual(result.stderr, "");
		} finally {
			scratch.cleanup();
		}
	});
});
