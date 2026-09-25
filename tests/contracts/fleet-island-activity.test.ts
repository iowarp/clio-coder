import { doesNotMatch, match } from "node:assert/strict";
import { test } from "node:test";
import type { WorkerProgressSnapshot } from "../../src/domains/observability/worker-progress.js";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import { type DispatchBoardRow, formatTaskIslandLines } from "../../src/interactive/dispatch-board.js";
import { renderWorkerEntryLines } from "../../src/interactive/renderers/worker-entry.js";
import type { WorkerEntryState } from "../../src/interactive/worker-stream.js";

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

function islandRow(snapshot: WorkerProgressSnapshot): string {
	const row = {
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
		tokenCount: 0,
		inputTokens: 0,
		outputTokens: 0,
		costUsd: 0,
		progress: snapshot,
	} as unknown as DispatchBoardRow;
	return stripTerminalSequences(formatTaskIslandLines([row])[1] ?? "");
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
