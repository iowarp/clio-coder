import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import type { RunEnvelope, RunOutcome } from "../../src/domains/dispatch/types.js";
import {
	buildDetachedBatchesMessage,
	createReadOnlyExplorationNudgeRegistration,
	openDetachedBatchViews,
	READ_ONLY_EXPLORATION_NUDGE_CALL_THRESHOLD,
	READ_ONLY_EXPLORATION_NUDGE_REGISTRATION_ID,
} from "../../src/domains/middleware/dispatch-nudge.js";
import type { MiddlewareHookInput } from "../../src/domains/middleware/types.js";

function beforeTool(turnId: string, toolName: string, toolArgs?: Record<string, unknown>): MiddlewareHookInput {
	return { hook: "before_tool", turnId, toolName, ...(toolArgs ? { toolArgs } : {}) };
}

function turnEnd(
	assistantTurnId: string,
	activeToolNames = "read,grep,find,ls,bash,dispatch",
	userTurnId = assistantTurnId,
): MiddlewareHookInput {
	return {
		hook: "turn_end",
		turnId: assistantTurnId,
		metadata: { stopReason: "stop", activeToolNames, userTurnId },
	};
}

function crossThreshold(
	turnId: string,
	registration: ReturnType<typeof createReadOnlyExplorationNudgeRegistration>,
): void {
	for (let call = 0; call < READ_ONLY_EXPLORATION_NUDGE_CALL_THRESHOLD; call += 1) {
		const input =
			call % 2 === 0
				? beforeTool(turnId, ToolNames.Read)
				: beforeTool(turnId, ToolNames.Bash, { command: "wc -l src/index.ts" });
		deepStrictEqual(registration.evaluate(input), []);
	}
}

function terminalEnvelope(runId: string, outcome: RunOutcome): RunEnvelope {
	return {
		id: runId,
		agentId: "scout",
		task: "bounded reconnaissance",
		targetId: "local",
		wireModelId: "test-model",
		runtimeId: "test-runtime",
		runtimeKind: "http",
		startedAt: "2026-07-11T00:00:00.000Z",
		endedAt: "2026-07-11T00:00:01.000Z",
		status: outcome === "canceled" ? "interrupted" : "failed",
		outcome,
		exitCode: 1,
		pid: null,
		heartbeatAt: null,
		receiptPath: null,
		sessionId: "test-session",
		cwd: "/tmp",
		tokenCount: 0,
		costUsd: 0,
	};
}

describe("contracts/read-only exploration dispatch nudge", () => {
	it("fires once after the named read-only call threshold without dispatch", () => {
		const registration = createReadOnlyExplorationNudgeRegistration();
		strictEqual(registration.id, READ_ONLY_EXPLORATION_NUDGE_REGISTRATION_ID);
		crossThreshold("turn-fire-user", registration);

		const effects = registration.evaluate(turnEnd("turn-fire-assistant", undefined, "turn-fire-user"));
		deepStrictEqual(
			effects.map((effect) => effect.kind),
			["request_continuation", "inject_reminder"],
		);
		const continuation = effects[0];
		ok(continuation?.kind === "request_continuation");
		match(continuation.message, /read-only exploration calls without dispatch/);
		match(continuation.message, /scout/);

		deepStrictEqual(
			registration.evaluate(turnEnd("turn-fire-assistant", undefined, "turn-fire-user")),
			[],
			"same turn cannot nudge twice",
		);
	});

	it("retains same-id correlation for direct or sessionless callers", () => {
		const registration = createReadOnlyExplorationNudgeRegistration();
		crossThreshold("turn-direct", registration);
		const effects = registration.evaluate({
			hook: "turn_end",
			turnId: "turn-direct",
			metadata: { stopReason: "stop", activeToolNames: "read,dispatch" },
		});
		deepStrictEqual(
			effects.map((effect) => effect.kind),
			["request_continuation", "inject_reminder"],
		);
	});

	it("suppresses below-threshold turns, turns that dispatched, and surfaces without dispatch", () => {
		const registration = createReadOnlyExplorationNudgeRegistration();
		for (let call = 0; call < READ_ONLY_EXPLORATION_NUDGE_CALL_THRESHOLD - 1; call += 1) {
			registration.evaluate(beforeTool("turn-short", ToolNames.Ls));
		}
		deepStrictEqual(registration.evaluate(turnEnd("turn-short")), []);

		crossThreshold("turn-dispatched", registration);
		registration.evaluate(beforeTool("turn-dispatched", ToolNames.Dispatch, { list: true }));
		deepStrictEqual(registration.evaluate(turnEnd("turn-dispatched")), []);

		crossThreshold("turn-no-surface", registration);
		deepStrictEqual(registration.evaluate(turnEnd("turn-no-surface", "read,grep,find,ls,bash")), []);
		crossThreshold("turn-unknown-surface", registration);
		deepStrictEqual(
			registration.evaluate({ hook: "turn_end", turnId: "turn-unknown-surface", metadata: { stopReason: "stop" } }),
			[],
		);
	});

	it("does not count execution-shaped bash commands as read-only exploration", () => {
		const registration = createReadOnlyExplorationNudgeRegistration();
		for (let call = 0; call < READ_ONLY_EXPLORATION_NUDGE_CALL_THRESHOLD + 2; call += 1) {
			registration.evaluate(beforeTool("turn-build", ToolNames.Bash, { command: "npm run build" }));
		}
		deepStrictEqual(registration.evaluate(turnEnd("turn-build")), []);
	});
});

describe("contracts/detached dispatch nudge outcome copy", () => {
	it("uses done only when every terminal run succeeded", () => {
		const message = buildDetachedBatchesMessage(
			[{ id: "batch-ok", total: 2, terminal: 2, terminalOutcomes: { succeeded: 2 } }],
			[],
		);
		match(message, /batch batch-ok: 2\/2 run\(s\) done/);
		strictEqual(message.includes("run(s) terminal"), false, message);
	});

	it("renders a truthful terminal-state breakdown for canceled and failed runs", () => {
		const rows = new Map([
			["run-canceled", terminalEnvelope("run-canceled", "canceled")],
			["run-failed", terminalEnvelope("run-failed", "failed")],
		]);
		const dispatch: Pick<DispatchContract, "detached" | "getRun"> = {
			detached: {
				register: async () => {
					throw new Error("register not used");
				},
				get: () => null,
				list: () => [
					{
						id: "batch-mixed",
						runs: [
							{ runId: "run-canceled", agentId: "scout" },
							{ runId: "run-failed", agentId: "scout" },
						],
						sessionId: "test-session",
						createdAt: "2026-07-11T00:00:00.000Z",
						collectedAt: null,
					},
				],
				markCollected: async () => null,
			},
			getRun: (runId) => rows.get(runId) ?? null,
		};
		const ready = openDetachedBatchViews(dispatch);
		deepStrictEqual(ready, [{ id: "batch-mixed", total: 2, terminal: 2, terminalOutcomes: { canceled: 1, failed: 1 } }]);
		const message = buildDetachedBatchesMessage(ready, []);
		match(message, /batch batch-mixed: 2\/2 run\(s\) terminal \(1 canceled, 1 failed\)/);
		strictEqual(message.includes("2/2 run(s) done"), false, message);
	});
});
