/**
 * Telemetry facts whose writer and reader disagreed: an evidence build failure
 * was raised at a level the dispatch board never reads, and a failed or
 * aborted prewarm was read back as a zero-cost success.
 */
import { deepStrictEqual, equal, match } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import {
	createChatTurnUsage,
	createTurnObservations,
	subscribeExtensionObservations,
} from "../../src/domains/extensions/bus-observations.js";
import type { ExtensionObservationV2 } from "../../src/domains/extensions/public-api-v2.js";
import { emptyCostAggregate } from "../../src/domains/telemetry/cost.js";
import type { OutOfTurnUsageRow } from "../../src/domains/telemetry/out-of-turn-usage.js";
import { appendOutOfTurnUsageRow, readOutOfTurnUsageRows } from "../../src/domains/telemetry/out-of-turn-usage.js";
import type { ProjectionReadModel } from "../../src/domains/telemetry/projection.js";
import { createTelemetryProjection } from "../../src/domains/telemetry/projection.js";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import type { DispatchBoardRow } from "../../src/interactive/dispatch-board.js";
import { createDispatchBoardView } from "../../src/interactive/dispatch-board.js";

const scratch = mkdtempSync(join(tmpdir(), "clio-coder-telemetry-wiring-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

describe("turn observations", () => {
	it("sends a turn's provider-reported usage as turn_end, never an aborted call's display estimate", () => {
		const observations: ExtensionObservationV2[] = [];
		const turns = createTurnObservations((observation) => observations.push(observation));
		const usage = createChatTurnUsage();
		const settled = (message: Record<string, unknown>) => usage.observe({ type: "message_end", message });
		usage.observe({ type: "agent_start" });
		settled({ role: "assistant", model: "m", stopReason: "toolUse", usage: { input: 100, output: 20, cacheRead: 5 } });
		settled({ role: "toolResult", usage: { input: 999 } });
		// An interrupted call keeps the provider's zeros; Clio's estimate beside them is for display only.
		settled({
			role: "assistant",
			model: "m",
			stopReason: "aborted",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			estimatedUsage: { input: 300, output: 40, cacheRead: 0, cacheWrite: 0, estimated: true },
		});
		// The terminal reads the fold and takes how the turn ended from its own summary.
		turns.turnEnd({ ...usage.current(), modelId: "m", targetId: "t", stopReason: "cancelled" });
		const end = observations.at(-1);
		deepStrictEqual(end?.event === "turn_end" ? end.usage : null, {
			inputTokens: 100,
			outputTokens: 20,
			cacheReadTokens: 5,
			cacheWriteTokens: 0,
			costUsd: null,
			model: "m",
			target: "t",
		});
		equal(end?.event === "turn_end" ? end.outcome : null, "aborted");
		usage.observe({ type: "agent_start" });
		deepStrictEqual(usage.current(), {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			modelId: "",
			stopReason: "completed",
		});
	});
});

describe("compaction observations", () => {
	it("maps terminal outcomes and keeps unreported legacy outcomes unknown", () => {
		const bus = createTelemetryHub();
		const observations: ExtensionObservationV2[] = [];
		const unsubscribe = subscribeExtensionObservations(bus, (observation) => observations.push(observation));
		for (const outcome of ["completed", "unchanged", "failed", "cancelled", undefined] as const)
			bus.emit("compaction.ended", { trigger: "force", at: 0, ...(outcome === undefined ? {} : { outcome }) });
		deepStrictEqual(
			observations.map((observation) => (observation.event === "compaction_end" ? observation.outcome : null)),
			["ok", "ok", "failed", "failed", "unknown"],
		);
		unsubscribe();
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
		const projection = createTelemetryProjection(createTelemetryHub(), readModel());
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
			usage: { kind: "pending" },
			lastContextTokens: null,
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
