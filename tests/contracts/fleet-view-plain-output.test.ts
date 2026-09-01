/** Fleet snapshots are plain stdout surfaces even though their width primitive is ANSI-aware. */

import { ok } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	type FleetRunViewModel,
	type RunViewModel,
	renderFleetRunView,
	renderRunView,
} from "../../src/cli/fleet-view.js";

const LONG = "a deliberately long operator-visible value that must be truncated at forty terminal columns";

function assertPlain(lines: ReadonlyArray<string>): void {
	const output = lines.join("\n");
	ok(output.includes("…"), `fixture must exercise truncation:\n${output}`);
	ok(!output.includes("\u001B"), `plain fleet view leaked ANSI bytes:\n${JSON.stringify(output)}`);
}

describe("fleet view plain-output contract", () => {
	it("keeps a narrow run snapshot free of ANSI reset codes", () => {
		const model: RunViewModel = {
			runId: `run-${LONG}`,
			agentId: LONG,
			model: LONG,
			target: LONG,
			node: "local",
			phase: "failed",
			startedAt: "2026-09-01T12:00:00.000Z",
			elapsedMs: 1_000,
			task: LONG,
			transcript: [{ at: "2026-09-01T12:00:00.000Z", label: LONG, detail: undefined }],
			transcriptTruncated: false,
			journalPresent: true,
			journalPath: `/state/${LONG}`,
			evidence: LONG,
			receiptPath: `/state/receipts/${LONG}.json`,
			outcome: "failed",
			outcomeDetail: LONG,
			terminal: true,
		};
		assertPlain(renderRunView(model, 40));
	});

	it("keeps a narrow fleet-root index free of ANSI reset codes", () => {
		const model: FleetRunViewModel = {
			rootId: `fleet-${LONG}`,
			fleet: LONG,
			startedAt: "2026-09-01T12:00:00.000Z",
			elapsedMs: 1_000,
			running: false,
			resumedFrom: LONG,
			plannedSteps: 1,
			recordedSteps: 1,
			steps: [{ stepId: LONG, runId: LONG, agentId: LONG, outcome: "failed", detail: LONG }],
		};
		assertPlain(renderFleetRunView(model, 40));
	});
});
