/**
 * Observability facts whose writer and reader disagreed: the trace mirror read
 * the Clio tool frames at the wrong nesting level, an evidence build failure
 * was raised at a level the dispatch board never reads, and a failed or
 * aborted prewarm was read back as a zero-cost success.
 */
import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createSafeEventBus } from "../../src/core/event-bus.js";
import { emptyCostAggregate } from "../../src/domains/observability/cost.js";
import {
	appendOutOfTurnUsageRow,
	type OutOfTurnUsageRow,
	readOutOfTurnUsageRows,
} from "../../src/domains/observability/out-of-turn-usage.js";
import { createObservabilityProjection, type ProjectionReadModel } from "../../src/domains/observability/projection.js";
import { createDispatchTraceMirror, TraceReader } from "../../src/domains/observability/trace-store.js";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import { createDispatchBoardView, type DispatchBoardRow } from "../../src/interactive/dispatch-board.js";

const scratch = mkdtempSync(join(tmpdir(), "clio-coder-observability-wiring-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

describe("trace mirror tool rows", () => {
	const at = (second: number) => new Date(Date.UTC(2026, 8, 25, 12, 0, second)).toISOString();

	/** Feed one run's progress events through the mirror, one second apart, and return its tool_call rows. */
	async function toolRows(runId: string, events: ReadonlyArray<Record<string, unknown>>) {
		const path = join(scratch, `${runId}.sqlite`);
		let second = 0;
		const mirror = createDispatchTraceMirror(path, { now: () => at(second), warn: () => {} });
		mirror.enqueue("dispatch.enqueued", {
			runId,
			agentId: "coder",
			targetId: "local",
			wireModelId: "model",
			runtimeId: "fixture",
			runtimeKind: "http",
			requestOrigin: "internal",
		});
		for (const event of events) {
			second += 1;
			mirror.enqueue("dispatch.progress", { runId, agentId: "coder", event });
		}
		await mirror.close();
		const reader = new TraceReader(path);
		try {
			return reader
				.events(runId)
				.filter((row) => row.type === "tool_call")
				.map((row) => ({
					startedAt: row.started_at,
					endedAt: row.ended_at,
					payload: JSON.parse(row.payload_json ?? "null") as Record<string, unknown>,
				}));
		} finally {
			reader.close();
		}
	}

	const clioStart = (toolCallId: string, tool: string) => ({
		type: "clio_coder_tool_start",
		payload: { tool, toolCallId, posture: "operating", startedAt: 0 },
	});
	const clioFinish = (toolCallId: string, tool: string, durationMs: number, outcome = "ok") => ({
		type: "clio_coder_tool_finish",
		payload: { tool, toolCallId, posture: "operating", durationMs, outcome },
	});

	it("gives a claude-sdk worker, which emits only the Clio frames, a row with its duration", async () => {
		const rows = await toolRows("run-claude", [clioStart("c1", "bash"), clioFinish("c1", "bash", 5, "blocked")]);
		equal(rows.length, 1);
		const row = rows[0];
		ok(row);
		equal(row.payload.tool, "bash");
		equal(row.payload.tool_call_id, "c1");
		equal(row.payload.duration_ms, 5);
		equal(row.payload.ok, false);
		equal(row.startedAt, at(1));
		equal(row.endedAt, new Date(Date.parse(at(1)) + 5).toISOString());
	});

	it("merges a native worker's engine and Clio frames into one row with args, result and duration", async () => {
		const rows = await toolRows("run-native", [
			{ type: "tool_execution_start", toolCallId: "n1", toolName: "read", args: { path: "src/a.ts" } },
			clioStart("n1", "read"),
			clioFinish("n1", "read", 40),
			{ type: "tool_execution_end", toolCallId: "n1", toolName: "read", result: "file text", isError: false },
		]);
		equal(rows.length, 1);
		const row = rows[0];
		ok(row);
		deepStrictEqual(row.payload.args, { path: "src/a.ts" });
		equal(row.payload.result_snippet, "file text");
		equal(row.payload.duration_ms, 40);
		equal(row.payload.ok, true);
		equal(row.startedAt, at(1));
		equal(row.endedAt, new Date(Date.parse(at(1)) + 40).toISOString());
	});

	it("keeps an ACP worker's engine-frame row and adds the Clio frame's duration", async () => {
		const rows = await toolRows("run-acp", [
			clioStart("a1", "read"),
			{ type: "tool_execution_start", toolCallId: "a1", toolName: "Read file", args: { path: "b.ts" } },
			{ type: "tool_execution_end", toolCallId: "a1", toolName: "Read file", result: "b text", isError: false },
			clioFinish("a1", "read", 25),
		]);
		equal(rows.length, 1);
		const row = rows[0];
		ok(row);
		equal(row.payload.tool, "Read file");
		deepStrictEqual(row.payload.args, { path: "b.ts" });
		equal(row.payload.result_snippet, "b text");
		equal(row.payload.duration_ms, 25);
		equal(row.startedAt, at(1));
		equal(row.endedAt, new Date(Date.parse(at(1)) + 25).toISOString());
	});
});

describe("evidence build failure", () => {
	function readModel(): ProjectionReadModel {
		return {
			sessionCostSummary: () => emptyCostAggregate(),
			sessionTokens: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoningTokens: 0, totalTokens: 0 }),
			latestThroughput: () => null,
		};
	}

	it("reaches the dispatch board as a failed proof with its reason", () => {
		const projection = createObservabilityProjection(createSafeEventBus(), readModel());
		projection.evidenceBuildFailed("run-proof", "disk full while writing the bundle");
		const row: DispatchBoardRow = {
			runId: "run-proof",
			agentId: "coder",
			runtimeKind: "http",
			runtimeId: "fixture",
			targetId: "local",
			wireModelId: "model",
			status: "completed",
			elapsedMs: 0,
			tokenCount: 0,
			costUsd: 0,
			inputTokens: 0,
			outputTokens: 0,
			ttftMs: null,
		};
		const board = createDispatchBoardView(
			() => [row],
			() => projection.snapshot(),
		);
		const text = board.render(120).map(stripTerminalSequences).join("\n");
		match(text, /proof\s+\S+ failed/u);
		match(text, /disk full while writing the bundle/u);
		projection.stop();
	});
});

describe("prewarm usage rows", () => {
	const row = (overrides: Partial<OutOfTurnUsageRow>): OutOfTurnUsageRow => ({
		label: "prewarm",
		sessionId: "session-1",
		repoIdentity: "repo-1",
		timestamp: "2026-09-25T12:00:00.000Z",
		target: "local",
		attributedModelId: "model",
		usage: {
			input: null,
			output: null,
			cacheRead: null,
			cacheWrite: null,
			reasoning: null,
			totalTokens: null,
			costUsd: null,
			costProvenance: "unknown",
		},
		...overrides,
	});

	it("read back a failed or aborted prewarm as that outcome with unknown usage, not a zero-cost success", () => {
		const stateDir = join(scratch, "prewarm-state");
		appendOutOfTurnUsageRow(stateDir, row({ callOutcome: "error" }));
		appendOutOfTurnUsageRow(stateDir, row({ callOutcome: "aborted" }));
		appendOutOfTurnUsageRow(
			stateDir,
			row({
				callOutcome: "success",
				usage: {
					input: 12,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					reasoning: null,
					totalTokens: 12,
					costUsd: 0,
					costProvenance: "unknown",
				},
			}),
		);
		// Rows written before prewarm recorded an outcome stay readable as they were.
		const { callOutcome: _omitted, ...legacy } = row({
			usage: {
				input: 3,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				reasoning: 0,
				totalTokens: 4,
				costUsd: 0,
				costProvenance: "unknown",
			},
		});
		appendOutOfTurnUsageRow(stateDir, legacy);
		const read = readOutOfTurnUsageRows(stateDir);
		deepStrictEqual(read.errors, []);
		const [failed, aborted, succeeded, old] = read.rows;
		equal(failed?.callOutcome, "error");
		equal(failed?.usage.input, null);
		equal(failed?.usage.costUsd, null);
		equal(aborted?.callOutcome, "aborted");
		equal(aborted?.usage.totalTokens, null);
		equal(succeeded?.callOutcome, "success");
		equal(succeeded?.usage.input, 12);
		equal(succeeded?.usage.reasoning, null);
		equal(old?.callOutcome, undefined);
		equal(old?.usage.totalTokens, 4);
	});
});
