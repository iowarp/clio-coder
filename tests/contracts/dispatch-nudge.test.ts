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

function beforeTool(
	turnId: string,
	toolName: string,
	toolArgs?: Record<string, unknown>,
	metadata?: MiddlewareHookInput["metadata"],
): MiddlewareHookInput {
	return { hook: "before_tool", turnId, toolName, ...(toolArgs ? { toolArgs } : {}), ...(metadata ? { metadata } : {}) };
}

function afterTool(
	turnId: string,
	toolName: string,
	toolArgs?: Record<string, unknown>,
	resultKind: "ok" | "error" = "ok",
): MiddlewareHookInput {
	return { hook: "after_tool", turnId, toolName, ...(toolArgs ? { toolArgs } : {}), metadata: { resultKind } };
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

const SCOUT_TASK_ARGS = {
	tasks: [{ agent: "scout", task: "Map repository structure and cite the relevant files." }],
};

function terminalEnvelope(runId: string, outcome: RunOutcome): RunEnvelope {
	return {
		id: runId,
		agentId: "scout",
		executionRole: "builder",
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
	it("advises once after the named read-only call threshold, never carrying the turn onward", () => {
		const registration = createReadOnlyExplorationNudgeRegistration();
		strictEqual(registration.id, READ_ONLY_EXPLORATION_NUDGE_REGISTRATION_ID);
		crossThreshold("turn-fire-user", registration);

		const effects = registration.evaluate(turnEnd("turn-fire-assistant", undefined, "turn-fire-user"));
		deepStrictEqual(
			effects.map((effect) => effect.kind),
			["inject_reminder"],
			"reading is the requested work; the finding is advisory, not a forced extra model round",
		);
		const advisory = effects[0];
		ok(advisory?.kind === "inject_reminder");
		// The threshold counts one user turn, so the copy names a turn, and names
		// it once: the pre-#58 wording said "continuation" twice about a turn that
		// was not one.
		match(advisory.message, /This turn used/);
		match(advisory.message, /without a successful Scout dispatch; delegate/);
		strictEqual(advisory.message.includes("continuation"), false, advisory.message);
		strictEqual(advisory.message.match(/this turn/gi)?.length, 1, advisory.message);
		match(advisory.message, /Scout/);

		deepStrictEqual(
			registration.evaluate(turnEnd("turn-fire-assistant", undefined, "turn-fire-user")),
			[],
			"same turn cannot nudge twice",
		);
		// A later model round of the same user turn re-counts its own calls, but
		// the operator has already been told once.
		crossThreshold("turn-fire-user", registration);
		deepStrictEqual(
			registration.evaluate(turnEnd("turn-fire-assistant-2", undefined, "turn-fire-user")),
			[],
			"one advisory per user turn",
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
			["inject_reminder"],
		);
	});

	it("suppresses below-threshold turns, successful Scout turns, and surfaces without dispatch", () => {
		const registration = createReadOnlyExplorationNudgeRegistration();
		for (let call = 0; call < READ_ONLY_EXPLORATION_NUDGE_CALL_THRESHOLD - 1; call += 1) {
			registration.evaluate(beforeTool("turn-short", ToolNames.Ls));
		}
		deepStrictEqual(registration.evaluate(turnEnd("turn-short")), []);

		crossThreshold("turn-listed", registration);
		registration.evaluate(beforeTool("turn-listed", ToolNames.Dispatch, { list: true }));
		registration.evaluate(afterTool("turn-listed", ToolNames.Dispatch, { list: true }));
		strictEqual(
			registration.evaluate(turnEnd("turn-listed"))[0]?.kind,
			"inject_reminder",
			"list:true is not a Scout dispatch",
		);

		crossThreshold("turn-dispatched", registration);
		registration.evaluate(beforeTool("turn-dispatched", ToolNames.Dispatch, SCOUT_TASK_ARGS, { decisionKind: "allow" }));
		registration.evaluate(afterTool("turn-dispatched", ToolNames.Dispatch, SCOUT_TASK_ARGS));
		deepStrictEqual(registration.evaluate(turnEnd("turn-dispatched")), []);

		crossThreshold("turn-no-surface", registration);
		deepStrictEqual(registration.evaluate(turnEnd("turn-no-surface", "read,grep,find,ls,bash")), []);
		crossThreshold("turn-unknown-surface", registration);
		deepStrictEqual(
			registration.evaluate({ hook: "turn_end", turnId: "turn-unknown-surface", metadata: { stopReason: "stop" } }),
			[],
		);
	});

	it("still advises after a valid Scout dispatch fails and nine read-only calls follow", () => {
		const registration = createReadOnlyExplorationNudgeRegistration();
		registration.evaluate(beforeTool("turn-failed", ToolNames.Dispatch, SCOUT_TASK_ARGS));
		registration.evaluate(afterTool("turn-failed", ToolNames.Dispatch, SCOUT_TASK_ARGS, "error"));
		crossThreshold("turn-failed", registration);

		const effects = registration.evaluate(turnEnd("turn-failed"));
		deepStrictEqual(
			effects.map((effect) => effect.kind),
			["inject_reminder"],
		);
	});

	it("tracks effective ordinary Scout requests with live-parser parity", () => {
		const credited: ReadonlyArray<Record<string, unknown>> = [
			{ agent: "scout", task: "Map the repository." },
			{ agent: "scout", tasks: ["Map the repository."] },
			{ tasks: JSON.stringify([{ agent: "scout", task: "Map the repository." }]) },
			{ ...SCOUT_TASK_ARGS, review: false },
			{
				tasks: [
					{ agent: "coder", task: "Inspect the public API." },
					{ agent: "scout", task: "Map the repository." },
				],
			},
		];
		for (const [index, args] of credited.entries()) {
			const registration = createReadOnlyExplorationNudgeRegistration();
			const turnId = `credited-${index}`;
			crossThreshold(turnId, registration);
			registration.evaluate(afterTool(turnId, ToolNames.Dispatch, args));
			deepStrictEqual(registration.evaluate(turnEnd(turnId)), [], JSON.stringify(args));
		}

		const notCredited: ReadonlyArray<Record<string, unknown>> = [
			{ agentId: "scout", executionRole: "builder", task: "Map the repository." },
			{ tasks: [{ agentId: "scout", executionRole: "builder", task: "Map the repository." }] },
			{ ...SCOUT_TASK_ARGS, list: true },
			{ ...SCOUT_TASK_ARGS, apply_winner: { branch: "clio/compete/group/1" } },
			{ ...SCOUT_TASK_ARGS, review: true },
			{ ...SCOUT_TASK_ARGS, mode: "compete" },
		];
		for (const [index, args] of notCredited.entries()) {
			const registration = createReadOnlyExplorationNudgeRegistration();
			const turnId = `not-credited-${index}`;
			crossThreshold(turnId, registration);
			registration.evaluate(afterTool(turnId, ToolNames.Dispatch, args));
			strictEqual(registration.evaluate(turnEnd(turnId))[0]?.kind, "inject_reminder", JSON.stringify(args));
		}
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
		match(message, /Collect each .* before final synthesis/);
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
							{ runId: "run-canceled", assignmentId: "run-canceled", agentId: "scout" },
							{ runId: "run-failed", assignmentId: "run-failed", agentId: "scout" },
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
