import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createBoardSource } from "../../src/cli/fleet-board-model.js";
import { renderCompactCount } from "../../src/core/telemetry/render.js";
import { runEventJournalPath } from "../../src/domains/dispatch/run-event-journal.js";

// The board's live token count folds the run feed's model calls as facts, so a call that reported no usage leaves
// a lower bound rather than adding 0 to a total that reads as whole (#434 §11.3).
test("the fleet board words a running run's streamed tokens as a lower bound beside an unreported call", () => {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-fleet-board-tokens-"));
	const at = "2026-10-30T00:00:00.000Z";
	const path = runEventJournalPath("run-a", join(root, "runs"));
	mkdirSync(dirname(path), { recursive: true });
	const lines = [
		{ seq: 1, at, kind: "open", runId: "run-a", agentId: "coder" },
		{ seq: 2, at, kind: "event", type: "message_end", tokens: 1_200, usage: {}, usageScope: "call", callIndex: 1 },
		// A call the provider reported no usage for.
		{ seq: 3, at, kind: "event", type: "message_end", usage: { observed: false }, usageScope: "call", callIndex: 2 },
		// A prose-only line is no call.
		{ seq: 4, at, kind: "event", type: "message_end", detail: "done" },
	];
	writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	const fold = createBoardSource(root, join(root, "runs")).folds.fold("run-a");
	deepStrictEqual(fold.tokens, {
		measured: 1_200,
		estimated: 0,
		unknownCount: 1,
		absentCount: 0,
		coverage: { measured: 1, estimated: 0, unknown: 1 },
	});
	strictEqual(fold.tokens && renderCompactCount(fold.tokens), "≥1.2k +?");
});
