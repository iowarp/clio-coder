import { strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// Operator config and state decide how far the skill-root walks go, so the
// count is pinned against a home this file owns. It is set before the driver
// loads, because the driver installs its counters and the Clio dirs cache on
// first use.
const home = mkdtempSync(join(tmpdir(), "clio-coder-admission-fs-ops-"));
process.env.CLIO_CODER_HOME = home;
const { runScenario } = await import("../../evals/tool-bench/lib/driver.js");
const { generateScenario } = await import("../../evals/tool-bench/lib/corpus.js");

/**
 * Counted fs calls for one admitted call, admission through publish. Every
 * target and root is still resolved at admission, but each component once:
 * a walk repeated inside the same call raises these and fails here.
 */
const PINNED_FS_OPS = {
	"edit.search.size-1k-head": 42,
	"write.search.create-1k": 52,
} as const;

describe("admission fs calls", () => {
	after(() => rmSync(home, { recursive: true, force: true }));

	for (const [id, expected] of Object.entries(PINNED_FS_OPS)) {
		it(`${id} resolves each path component once per call`, async () => {
			const [tool, split, key] = id.split(".") as ["edit" | "write", "search", string];
			const measured = await runScenario(generateScenario(tool, 1, split, key), { warmup: 1 });
			strictEqual(measured.solved, true, id);
			strictEqual(measured.fsOps, expected, `${id}: ${JSON.stringify(measured.fsOpsByName)}`);
		});
	}
});
