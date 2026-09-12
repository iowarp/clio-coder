import { doesNotMatch, match, ok } from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import { renderWorkerEntryLines, workerNeedsInput } from "../../src/interactive/renderers/worker-entry.js";
import type { WorkerEntryState, WorkerReceiptSummary } from "../../src/interactive/worker-stream.js";

function settledWorker(text: string): WorkerEntryState {
	return {
		assignmentId: "assignment-1",
		runId: "run-1",
		origin: "agent",
		agentId: "materio-research-explorer",
		runtime: { kind: "clio", targetId: "mock-chat", wireModelId: "mock-model" },
		text,
		droppedLines: 0,
		tools: ["read"],
		attempts: [],
		pending: false,
		receipt: { outcome: "succeeded", durationMs: 72_000 } as WorkerReceiptSummary,
	};
}

const CHECKPOINT = [
	"needs_input: checkpoint:decision",
	"",
	"1. The two candidate prompts differ in whether Mo is in scope. Include Mo alongside Nb?",
	"2. Is 500 h aging acceptable for the timeline, or should the study stop at 200 h?",
	"3. Which characterization is primary: SEM/EBSD phase fractions or XRD lattice parameters?",
	"4. Should the literature task read supplied papers only, or also the two provided URLs?",
	"5. Confirm the write scope: RESEARCH.md and STATE.md only.",
].join("\n");

test("a worker checkpoint is marked as needing input and keeps its questions on the folded row", () => {
	const entry = settledWorker(CHECKPOINT);
	ok(workerNeedsInput(entry));
	ok(!workerNeedsInput(settledWorker("research_identified: RESEARCH.md written")));
	const { receipt: _settled, ...running } = entry;
	ok(!workerNeedsInput(running), "a running worker is not a checkpoint yet");
	const rows = renderWorkerEntryLines(entry, 100, {
		terminalRows: 40,
		detail: { workerRows: 0, workerActivity: false, errorRows: 4 } as never,
	}).map(stripTerminalSequences);
	match(rows[0] ?? "", /needs input/u);
	doesNotMatch(rows[0] ?? "", /execution ok/u, "the folded header names the state the operator has to act on");
	for (const question of [
		"Include Mo alongside Nb?",
		"stop at 200 h?",
		"XRD lattice parameters?",
		"two provided URLs?",
		"STATE.md only.",
	]) {
		ok(
			rows.some((row) => row.includes(question)),
			`checkpoint body lost "${question}"`,
		);
	}
	const ordinary = renderWorkerEntryLines(settledWorker("research_identified: RESEARCH.md written\nsecond line"), 100, {
		terminalRows: 40,
		detail: { workerRows: 0, workerActivity: false, errorRows: 4 } as never,
	}).map(stripTerminalSequences);
	ok(!ordinary.some((row) => row.includes("second line")), "an ordinary answer still folds under the preset");
});
