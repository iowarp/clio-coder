import { doesNotMatch, match, ok } from "node:assert/strict";
import { test } from "node:test";
import { isStructuredAnswerText, type WorkerProgressSnapshot } from "../../src/domains/telemetry/worker-progress.js";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import { type DispatchBoardRow, formatTaskIslandLines, runTableRows } from "../../src/interactive/dispatch-board.js";
import { renderWorkerEntryLines } from "../../src/interactive/renderers/worker-entry.js";
import type { WorkerEntryState } from "../../src/session-control/worker-stream.js";

// BT-007: at 20s the island said `◇ coder · running · 20s` while the inline
// card on the same run said `◔ starting · 20s`, and at 55s `running` against
// `◐ thinking`. Both read one progress fold, so they must say one thing.
function progress(overrides: Partial<WorkerProgressSnapshot>): WorkerProgressSnapshot {
	return {
		phase: "starting",
		tailText: "",
		droppedLines: 0,
		droppedBytes: 0,
		currentAction: null,
		recentActions: [],
		...overrides,
	} as WorkerProgressSnapshot;
}

function boardRow(snapshot: WorkerProgressSnapshot): DispatchBoardRow {
	return {
		runId: "run-1",
		agentId: "coder",
		origin: "user",
		requestOrigin: "user",
		runtimeKind: "http",
		runtimeId: "llamacpp",
		targetId: "mini",
		wireModelId: "ornith1.5-35b-moe-q4km",
		status: "running",
		elapsedMs: 20_000,
		usage: { kind: "pending" },
		progress: snapshot,
	} as unknown as DispatchBoardRow;
}

function islandRow(snapshot: WorkerProgressSnapshot): string {
	return stripTerminalSequences(formatTaskIslandLines([boardRow(snapshot)])[1] ?? "");
}

function cardLines(snapshot: WorkerProgressSnapshot): string {
	const entry = {
		runId: "run-1",
		agentId: "coder",
		runtime: { kind: "http", targetId: "mini", wireModelId: "ornith1.5-35b-moe-q4km" },
		text: "",
		tools: [],
		attempts: [],
		droppedLines: 0,
		pending: true,
		startedAtMs: 0,
		progress: snapshot,
	} as unknown as WorkerEntryState;
	return renderWorkerEntryLines(entry, 120, { nowMs: 20_000 }).map(stripTerminalSequences).join("\n");
}

const cases: Array<[string, WorkerProgressSnapshot, RegExp]> = [
	["before the first model event", progress({ phase: "starting" }), /starting/u],
	["while the model reasons", progress({ phase: "thinking" }), /thinking/u],
	["while the model writes", progress({ phase: "writing" }), /writing/u],
	[
		"while a call runs",
		progress({
			phase: "tool",
			currentAction: {
				tool: "read",
				descriptor: { verb: "reading", object: "lib/math.js" },
			} as WorkerProgressSnapshot["currentAction"],
		}),
		/reading/u,
	],
];

for (const [when, snapshot, words] of cases) {
	test(`${when}, the island and the card name the same activity`, () => {
		const island = islandRow(snapshot);
		match(island, words, island);
		doesNotMatch(island, /· running ·/u, island);
		match(cardLines(snapshot), words);
	});
}

// bt-48-16: a worker streaming its result-contract report showed `◑ {"mutatedPaths":["tests/test_key_val…` on the
// dock. The run table and the workers board both drop a structured tail and say only that the worker is writing.
test("a worker writing its JSON report reads as writing, never as the report's first line", () => {
	const report = '{"mutatedPaths":["tests/test_key_value.py"],"checks":[]}';
	const table = (tailText: string) =>
		runTableRows([{ kind: "run", row: boardRow(progress({ phase: "writing", tailText })) }], 160, { now: 20_000 })
			.map(stripTerminalSequences)
			.join("\n");
	match(table(report), /writing/u);
	doesNotMatch(table(report), /mutatedPaths|\{/u);
	match(table("Reading the parser first."), /writing Reading the parser first\./u);
	for (const text of [report, "```json\n{", '[\n  {"path": "a"}', '  "mutatedPaths": ["a"],'])
		ok(isStructuredAnswerText(text), text);
	for (const text of ["Reading the parser first.", "[CLIO Coder] note", "[the plan](plan.md) is ready"])
		ok(!isStructuredAnswerText(text), text);
});
