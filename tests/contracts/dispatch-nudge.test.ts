import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import type { RunEnvelope, RunOutcome } from "../../src/domains/dispatch/types.js";
import {
	buildDetachedBatchesMessage,
	buildProactiveScoutRoutingMessage,
	createReadOnlyExplorationNudgeRegistration,
	isExplicitBroadRepositoryExplorationRequest,
	openDetachedBatchViews,
	READ_ONLY_EXPLORATION_NUDGE_CALL_THRESHOLD,
	READ_ONLY_EXPLORATION_NUDGE_REGISTRATION_ID,
	SCOUT_EXPLORATION_FALLBACK_CALL_LIMIT,
	SCOUT_EXPLORATION_SPOT_CHECK_CALL_LIMIT,
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

function turnStart(
	text: string,
	activeToolNames = "read,grep,find,ls,code_nav,context,git,bash,dispatch",
	extras: MiddlewareHookInput["metadata"] = {},
): MiddlewareHookInput {
	return { hook: "turn_start", text, metadata: { activeToolNames, ...extras } };
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
	it("matches explicit broad local reconnaissance and preserves excluded intent classes", () => {
		for (const text of [
			"let’s just explore this repo and context",
			"Survey this codebase end to end and identify key entry points.",
			"Analyze the entire project architecture and map its components.",
			"Survey this web codebase end to end.",
			"Survey this codebase end to end, including external API adapters.",
		]) {
			strictEqual(isExplicitBroadRepositoryExplorationRequest(text), true, text);
		}
		for (const text of [
			"hello there",
			"Understand the project.",
			"Inspect project config.",
			"Explore src/domains/middleware/dispatch-nudge.ts in this repository.",
			"Explore package.json in this repo.",
			"Find the createRegistry symbol in this codebase.",
			"Survey this repository against external papers.",
			"Let's explore this repo without using tools.",
			"Explore this repo but do not dispatch or use subagents.",
		]) {
			strictEqual(isExplicitBroadRepositoryExplorationRequest(text), false, text);
		}
	});

	it("injects the exact-turn Scout reminder only with dispatch exposure and a successful route preview", () => {
		const previewed: string[] = [];
		const registration = createReadOnlyExplorationNudgeRegistration({
			canRouteScout: (task) => {
				previewed.push(task);
				return true;
			},
		});
		const effects = registration.evaluate(turnStart("let’s just explore this repo and context"));
		deepStrictEqual(effects, [
			{ kind: "inject_reminder", message: buildProactiveScoutRoutingMessage(), severity: "info" },
			{ kind: "require_tool", toolName: ToolNames.Dispatch },
		]);
		strictEqual(previewed.length, 1);

		const noDispatch = createReadOnlyExplorationNudgeRegistration({
			canRouteScout: () => {
				throw new Error("preview must not run without dispatch exposure");
			},
		});
		deepStrictEqual(noDispatch.evaluate(turnStart("Survey this codebase end to end.", "read,grep,code_nav")), []);
		deepStrictEqual(
			createReadOnlyExplorationNudgeRegistration().evaluate(turnStart("Survey this codebase end to end.")),
			[],
			"an absent preview disables proactive routing",
		);
		deepStrictEqual(
			createReadOnlyExplorationNudgeRegistration({ canRouteScout: () => false }).evaluate(
				turnStart("Survey this codebase end to end."),
			),
			[],
			"an unroutable Scout disables proactive routing",
		);
		deepStrictEqual(
			createReadOnlyExplorationNudgeRegistration({
				canRouteScout: () => {
					throw new Error("preview failed");
				},
			}).evaluate(turnStart("Survey this codebase end to end.")),
			[],
			"preview failures fail open without steering",
		);
	});

	it("blocks direct reconnaissance and manual replacement scans after Scout success", () => {
		const registration = createReadOnlyExplorationNudgeRegistration({ canRouteScout: () => true });
		registration.evaluate(turnStart("Survey this codebase end to end."));

		const skillCatalog = registration.evaluate(beforeTool("turn-guard", ToolNames.Context, { scope: "skills" }));
		deepStrictEqual(skillCatalog, [], "non-repository context remains available");
		const firstRead = registration.evaluate(beforeTool("turn-guard", ToolNames.Read, { path: "src/index.ts" }));
		strictEqual(firstRead[0]?.kind, "block_tool");

		registration.evaluate(beforeTool("turn-guard", ToolNames.Dispatch, { list: true }));
		const listed = registration.evaluate(afterTool("turn-guard", ToolNames.Dispatch, { list: true }));
		strictEqual(listed[0]?.kind, "annotate_tool_result");
		strictEqual(
			registration.evaluate(beforeTool("turn-guard", ToolNames.Git, { op: "status" }))[0]?.kind,
			"block_tool",
			"list:true does not satisfy the route",
		);

		const coderArgs = { tasks: [{ agent: "coder", task: "Inspect the repository." }] };
		registration.evaluate(beforeTool("turn-guard", ToolNames.Dispatch, coderArgs));
		registration.evaluate(afterTool("turn-guard", ToolNames.Dispatch, coderArgs));
		strictEqual(
			registration.evaluate(beforeTool("turn-guard", ToolNames.Bash, { command: "sed -n '1,80p' src/index.ts" }))[0]?.kind,
			"block_tool",
			"a successful wrong-agent dispatch does not satisfy the route",
		);

		registration.evaluate(beforeTool("turn-guard", ToolNames.Dispatch, SCOUT_TASK_ARGS, { decisionKind: "allow" }));
		strictEqual(
			registration.evaluate(beforeTool("turn-guard", ToolNames.CodeNav, { mode: "entries" }))[0]?.kind,
			"block_tool",
			"before_tool is an attempt, not success",
		);
		const success = registration.evaluate(afterTool("turn-guard", ToolNames.Dispatch, SCOUT_TASK_ARGS, "ok"));
		deepStrictEqual(
			success.map((effect) => effect.kind),
			["annotate_tool_result"],
		);
		strictEqual(
			registration.evaluate(beforeTool("turn-guard", ToolNames.Find, { pattern: "*.ts" }))[0]?.kind,
			"block_tool",
			"broad scans stay delegated after Scout returns",
		);
		strictEqual(
			registration.evaluate(beforeTool("turn-guard", ToolNames.Read, { path: "src/cli/index.ts" }))[0]?.kind,
			"block_tool",
		);
		strictEqual(
			registration.evaluate(beforeTool("turn-guard", ToolNames.Grep, { path: "src/domains", pattern: "create" }))[0]?.kind,
			"block_tool",
			"only source reads are admitted for the live spot-check phase",
		);
		strictEqual(
			registration.evaluate(beforeTool("turn-guard", ToolNames.CodeNav, { mode: "symbol", query: "createCli" }))[0]?.kind,
			"block_tool",
			`post-Scout verification is capped at ${SCOUT_EXPLORATION_SPOT_CHECK_CALL_LIMIT} calls`,
		);
		strictEqual(
			registration.evaluate(beforeTool("turn-guard", ToolNames.Bash, { command: "bash -c 'ls src/domains'" }))[0]?.kind,
			"block_tool",
			"nested shell wrappers cannot bypass the post-Scout boundary",
		);
	});

	it("accepts only one effective Scout task across normalized dispatch argument shapes", () => {
		const accepted: ReadonlyArray<Record<string, unknown>> = [
			{ agent: "scout", tasks: ["Map the repository."] },
			{ tasks: [{ agent_id: "scout", task: "Map the repository." }] },
			{ agent_id: "scout", task: "Map the repository." },
			{ tasks: JSON.stringify([{ agent: "scout", task: "Map the repository." }]) },
		];
		for (const [index, args] of accepted.entries()) {
			const registration = createReadOnlyExplorationNudgeRegistration({ canRouteScout: () => true });
			registration.evaluate(turnStart("Survey this codebase end to end."));
			const turnId = `accepted-${index}`;
			registration.evaluate(beforeTool(turnId, ToolNames.Dispatch, args, { decisionKind: "allow" }));
			registration.evaluate(afterTool(turnId, ToolNames.Dispatch, args));
			strictEqual(
				registration.evaluate(beforeTool(turnId, ToolNames.Read, { path: "src/index.ts" }))[0]?.kind,
				"block_tool",
				JSON.stringify(args),
			);
		}

		const rejected: ReadonlyArray<Record<string, unknown>> = [
			{ agent: "scout", tasks: [{ agent: "coder", task: "Inspect it." }] },
			{
				tasks: [
					{ agent: "scout", task: "Map it." },
					{ agent: "coder", task: "Inspect it." },
				],
			},
			{ ...SCOUT_TASK_ARGS, review: true },
			{ ...SCOUT_TASK_ARGS, mode: "compete" },
		];
		for (const [index, args] of rejected.entries()) {
			const registration = createReadOnlyExplorationNudgeRegistration({ canRouteScout: () => true });
			registration.evaluate(turnStart("Survey this codebase end to end."));
			const turnId = `rejected-${index}`;
			registration.evaluate(beforeTool(turnId, ToolNames.Dispatch, args, { decisionKind: "allow" }));
			registration.evaluate(afterTool(turnId, ToolNames.Dispatch, args));
			strictEqual(
				registration.evaluate(beforeTool(turnId, ToolNames.Read, { path: "src/index.ts" }))[0]?.kind,
				"block_tool",
				JSON.stringify(args),
			);
		}
	});

	it("reports a failed Scout without opening an unbounded manual fallback", () => {
		const registration = createReadOnlyExplorationNudgeRegistration({ canRouteScout: () => true });
		registration.evaluate(turnStart("Survey this repository end to end."));
		registration.evaluate(beforeTool("turn-failed", ToolNames.Dispatch, SCOUT_TASK_ARGS, { decisionKind: "allow" }));
		const failed = registration.evaluate(afterTool("turn-failed", ToolNames.Dispatch, SCOUT_TASK_ARGS, "error"));
		deepStrictEqual(
			failed.map((effect) => effect.kind),
			["annotate_tool_result"],
		);
		strictEqual(
			registration.evaluate(beforeTool("turn-failed", ToolNames.Find, { pattern: "*.ts" }))[0]?.kind,
			"block_tool",
			"broad fallback calls remain blocked",
		);
		strictEqual(
			registration.evaluate(beforeTool("turn-failed", ToolNames.Read, { path: "src/cli/index.ts" }))[0]?.kind,
			"block_tool",
		);
		strictEqual(
			registration.evaluate(beforeTool("turn-failed", ToolNames.Grep, { pattern: "createCli", path: "src/cli" }))[0]?.kind,
			"block_tool",
		);
		strictEqual(
			registration.evaluate(beforeTool("turn-failed", ToolNames.CodeNav, { mode: "symbol", query: "createCli" }))[0]?.kind,
			"block_tool",
			`fallback is capped at ${SCOUT_EXPLORATION_FALLBACK_CALL_LIMIT} calls`,
		);

		const blocked = createReadOnlyExplorationNudgeRegistration({ canRouteScout: () => true });
		blocked.evaluate(turnStart("Survey this codebase end to end."));
		blocked.evaluate(beforeTool("turn-blocked", ToolNames.Dispatch, SCOUT_TASK_ARGS, { decisionKind: "allow" }), {
			priorEffects: [{ kind: "block_tool", reason: "dispatch deduplicated", severity: "hard-block" }],
		});
		strictEqual(
			blocked.evaluate(beforeTool("turn-blocked", ToolNames.Read, { path: "src/index.ts" }))[0]?.kind,
			"block_tool",
			"a middleware-blocked Scout call does not permit the main agent to replace it with a scan",
		);

		const missingResultKind = createReadOnlyExplorationNudgeRegistration({ canRouteScout: () => true });
		missingResultKind.evaluate(turnStart("Survey this codebase end to end."));
		missingResultKind.evaluate(
			beforeTool("turn-missing-result", ToolNames.Dispatch, SCOUT_TASK_ARGS, { decisionKind: "allow" }),
		);
		missingResultKind.evaluate({
			hook: "after_tool",
			turnId: "turn-missing-result",
			toolName: ToolNames.Dispatch,
			toolArgs: SCOUT_TASK_ARGS,
			metadata: {},
		});
		strictEqual(
			missingResultKind.evaluate(beforeTool("turn-missing-result", ToolNames.Find, { pattern: "*.ts" }))[0]?.kind,
			"block_tool",
			"an after_tool without resultKind never counts as success",
		);
	});

	it("carries the Scout-first guard into its one continuation when the model ignores the reminder", () => {
		const registration = createReadOnlyExplorationNudgeRegistration({ canRouteScout: () => true });
		registration.evaluate(turnStart("Survey this codebase end to end."));
		const effects = registration.evaluate(turnEnd("assistant-ignored", undefined, "user-ignored"));
		deepStrictEqual(
			effects.map((effect) => effect.kind),
			["request_continuation", "inject_reminder"],
		);
		deepStrictEqual(registration.evaluate(turnStart("", undefined, { requestContinuation: true })), [
			{ kind: "require_tool", toolName: ToolNames.Dispatch },
		]);
		strictEqual(
			registration.evaluate(beforeTool("user-continuation", ToolNames.Ls, { path: "." }))[0]?.kind,
			"block_tool",
		);
	});

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
		match(continuation.message, /read-only exploration calls without a successful Scout dispatch/);
		match(continuation.message, /Scout/);

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
			"request_continuation",
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
