import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { chmodSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { clioStateDir } from "../../src/core/xdg.js";
import { sweepExpiredToolOffloads, TOOL_OFFLOAD_MAX_AGE_MS } from "../../src/tools/result-shaping.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

describe("contracts/result-shaping", () => {
	let scratch: IsolatedClioEnv;

	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-sweep-contract-");
	});

	afterEach(() => scratch.restore());

	it("returns zero removed and skipped when scratch directory is absent", () => {
		const result = sweepExpiredToolOffloads();
		deepStrictEqual(result, { removed: 0, skipped: 0 });
	});

	it("sweeps expired offload files and cleans up empty session directories", () => {
		const scratchDir = join(clioStateDir(), "scratch");
		const sessionDir = join(scratchDir, "session-1");
		mkdirSync(sessionDir, { recursive: true });

		const expiredPath = join(sessionDir, "expired.txt");
		const freshPath = join(sessionDir, "fresh.txt");
		writeFileSync(expiredPath, "expired content");
		writeFileSync(freshPath, "fresh content");

		const now = Date.now();
		const oldTime = (now - TOOL_OFFLOAD_MAX_AGE_MS - 10_000) / 1000;
		utimesSync(expiredPath, oldTime, oldTime);

		const result = sweepExpiredToolOffloads(now);
		deepStrictEqual(result, { removed: 1, skipped: 0 });
	});

	it("tolerates missing files and counts permission errors into skipped figure", () => {
		const scratchDir = join(clioStateDir(), "scratch");
		const unreadableDir = join(scratchDir, "unreadable-session");
		mkdirSync(unreadableDir, { recursive: true });
		chmodSync(unreadableDir, 0);

		try {
			const result = sweepExpiredToolOffloads();
			strictEqual(result.removed, 0);
			strictEqual(result.skipped, 1);
		} finally {
			chmodSync(unreadableDir, 0o755);
		}
	});
});
