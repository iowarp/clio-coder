import { deepStrictEqual, match, ok } from "node:assert/strict";
import { test } from "node:test";
import { readDispatchScopeNotice } from "../../src/core/dispatch-scope-notice.js";
import { clioStateDir } from "../../src/core/xdg.js";
import { finishRunResult } from "../../src/domains/dispatch/run-settlement.js";
import { workerMergedNotice } from "../../src/domains/dispatch/workspace-mutation.js";
import { dispatchBatchSummary, formatDispatchOutput } from "../../src/tools/dispatch-runner.js";
import { fixtureEnvelope, fixtureReceiptDraft, measuredSpend } from "../harness/receipt.js";
import { writeSettledRun } from "../harness/settled-run.js";

function run(
	id: string,
	costUsd: number,
	pricedBy: "target-rates" | "catalog" | "none",
	calls: number,
	external = false,
) {
	const envelope = { ...fixtureEnvelope(id), spend: measuredSpend({ input: 20, output: 22 }, costUsd, pricedBy) };
	const draft = fixtureReceiptDraft(envelope);
	draft.toolCalls = calls;
	if (external) {
		draft.externalTelemetry = {
			tokenUsage: "unverified",
			cost: "missing",
			sessionId: null,
			exitReason: "stop",
			toolTelemetry: "unavailable",
		};
	}
	const receipt = finishRunResult(draft, envelope, {
		terminal: { terminalReason: draft.terminalReason ?? "completed" },
		processExitCode: envelope.exitCode,
		frameType: null,
		usage: undefined,
	}).result;
	return {
		receipt,
		summary: { count: 0, types: [], lastAssistantText: "", terminalAttemptRunId: id },
	};
}

test("the coordinator receives the landing fact for automatic and operator merges", () => {
	for (const detail of [
		"merged abc1234 onto main",
		"merged abc1234 onto main; operator merge accepted after the gate held it",
	]) {
		const envelope = fixtureEnvelope("run-merged");
		const draft = fixtureReceiptDraft(envelope);
		draft.worktree = { path: "/workspace/task", branch: "task", apply: "merge", applied: true, diffHash: "hash", detail };
		const receipt = finishRunResult(draft, envelope, {
			terminal: { terminalReason: draft.terminalReason ?? "completed" },
			processExitCode: envelope.exitCode,
			frameType: null,
			usage: undefined,
		}).result;
		const output = formatDispatchOutput("parallel", [{ ...run("run-merged", 0, "target-rates", 1), receipt }], 16384);
		match(output, /merged abc1234 onto main/);
	}
});

test("a worker merge raises one info transcript notice only when a commit landed", () => {
	const worktree = (detail: string, applied = true, apply = "merge") => ({ apply, applied, detail });
	const notice = workerMergedNotice("coder", "run-1", worktree("merged abc1234 onto main; 1 authored file is ignored"));
	deepStrictEqual(readDispatchScopeNotice(notice), {
		code: "worker_merged",
		level: "info",
		message: "coder run-1 merged abc1234 onto main",
	});
	for (const quiet of [
		worktree("nothing merged: the task branch holds no change beyond its base"),
		worktree("merge conflict in a.ts", false),
		worktree("merged abc1234 onto main", false, "preserve"),
		undefined,
	])
		deepStrictEqual(workerMergedNotice("coder", "run-2", quiet), null);
});

test("dispatch batch shows sealed tool calls and provenance-aware cost without inventing external tool counts", () => {
	const first = run("run-a", 0.1, "target-rates", 3);
	const second = run("run-b", 0.2, "catalog", 4);
	const opaque = run("run-c", 0, "none", 0, true);
	const runs = [first, second, opaque];
	deepStrictEqual(dispatchBatchSummary(runs), {
		observedToolCalls: 7,
		unobservableToolRuns: 1,
		// run-b is estimated, so the partly unknown total is approximate too (5996f82c6).
		cost: "~$0.30 +?",
	});
	match(
		formatDispatchOutput("parallel", runs, 16_384),
		/batch observed_tool_calls=7 cost=~\$0\.30 \+\? unobservable_tool_runs=1/u,
	);
});

test("parallel dispatch returns scheduler assignments on a board with no worker posts and keeps a recovered attempt visible", async () => {
	const { isolateClioEnv } = await import("../harness/scratch-env.js");
	const { runDispatchTool } = await import("../../src/tools/dispatch-runner.js");
	const { describeDispatchPlan } = await import("../../src/tools/dispatch-plan.js");
	const env = await isolateClioEnv("clio-settled-board-");
	try {
		const requests = ["Inspect entry points", "Inspect boundaries"].map((task) => ({
			agentId: "scout",
			executionRole: "researcher" as const,
			task,
		}));
		// The second assignment succeeds on attempt 1 after attempt 0 was cut off (cf1h-D3).
		const lineage = { rootRunId: "board-1-first", parentRunId: "board-1-first", depth: 0, attempt: 1 };
		const envelopes: ReturnType<typeof fixtureEnvelope>[] = [
			{
				...fixtureEnvelope("board-1-first"),
				status: "failed",
				outcome: "failed",
				outcomeCode: "worker_final_output_missing",
				outcomeDetail: "worker loop ended without a final assistant output (stopReason=aborted, cause=generation_guard)",
				exitCode: 1,
				lineage: { rootRunId: "board-1-first", parentRunId: "dispatcher", depth: 0, attempt: 0 },
			},
		];
		const dispatch = {
			async dispatchBatch(ledgered: ReadonlyArray<import("../../src/domains/dispatch/contract.js").DispatchRequest>) {
				const receipts = await Promise.all(
					ledgered.map(async (request, index) => {
						const run = {
							...fixtureEnvelope(`board-${index}`),
							agentId: request.agentId,
							task: request.task,
							...(index === 1 ? { lineage } : {}),
							projection: {
								version: 1 as const,
								ledgerId: request.ledger?.id ?? null,
								readRoots: [],
								writeRoots: [],
								scopeSource: "none" as const,
							},
						};
						const draft = fixtureReceiptDraft(run);
						draft.runtimeResolution = { wireModelId: `wire-${index}`, diagnostics: [] } as unknown as NonNullable<
							typeof draft.runtimeResolution
						>;
						const receipt = finishRunResult(draft, run, {
							terminal: { terminalReason: "completed" },
							processExitCode: run.exitCode,
							frameType: null,
							usage: undefined,
						}).result;
						envelopes.push(run);
						await writeSettledRun(clioStateDir(), receipt);
						return receipt;
					}),
				);
				return {
					batchId: "attached",
					assignmentIds: receipts.map((receipt) => receipt.runId),
					events: (async function* () {})(),
					finalPromise: Promise.resolve(receipts),
				};
			},
			getRun: (id: string) => envelopes.find((run) => run.id === id) ?? null,
			listRuns: () => envelopes,
			abort() {},
		} as unknown as import("../../src/domains/dispatch/contract.js").DispatchContract;
		const args = { mode: "parallel", tasks: requests.map((request) => ({ agent: request.agentId, task: request.task })) };
		const state: import("../../src/tools/dispatch-admission.js").DispatchAdmissionState = {
			preparedAdmissionArgs: new WeakSet(),
			trustedResolvedPlans: new WeakMap(),
			trustedReservationOwners: new WeakMap(),
			trustedExecutionSnapshots: new WeakMap(),
			trustedExecutionPlans: new WeakMap(),
			taskResolutions: new WeakMap(),
		};
		state.trustedExecutionSnapshots.set(args, {
			kind: "dispatch",
			planView: describeDispatchPlan(args),
			requests,
			mode: "parallel",
			writers: undefined,
			review: undefined,
			compete: undefined,
			council: undefined,
			detach: false,
			timeoutMs: undefined,
			maxOutputBytes: 16384,
		});
		const result = await runDispatchTool({ dispatch, getAgentSpecs: () => [], getAutonomy: () => "yolo" }, state, args);
		ok(result.kind === "ok", JSON.stringify(result));
		match(result.output, /^dispatch \(parallel\) total=2 failed=0 recovered=1$/mu);
		match(
			result.output,
			/^recovered board-1 after attempt 0 board-1-first failed: worker_final_output_missing \(.*cause=generation_guard\)\)$/mu,
		);
		deepStrictEqual([result.details?.failedCount, result.details?.recoveredCount], [0, 1]);
		match(String(result.details?.agentLedgerBoard), /Assignments:[\s\S]*Inspect entry points[\s\S]*Inspect boundaries/u);
		const detailRuns = result.details?.runs as ReadonlyArray<{ runtimeResolution?: { wireModelId?: string } }>;
		deepStrictEqual(
			detailRuns.map((entry) => entry.runtimeResolution?.wireModelId),
			["wire-0", "wire-1"],
		);
	} finally {
		env.restore();
	}
});

test("a worker route warning reaches the dispatching model once, ahead of the run lines", () => {
	const envelope = fixtureEnvelope("run-thinking");
	const draft = fixtureReceiptDraft(envelope);
	const message = "thinking off resolved to low for copilot-sdk/claude-opus-5.5; the model profile supports low, medium";
	draft.runtimeResolution = {
		diagnostics: [
			{ severity: "warning", code: "thinking-coerced", message },
			{ severity: "info", code: "context-window-source", message: "not a warning" },
		],
	} as unknown as NonNullable<typeof draft.runtimeResolution>;
	const receipt = finishRunResult(draft, envelope, {
		terminal: { terminalReason: draft.terminalReason ?? "completed" },
		processExitCode: envelope.exitCode,
		frameType: null,
		usage: undefined,
	}).result;
	const output = formatDispatchOutput("parallel", [{ ...run("run-thinking", 0, "target-rates", 1), receipt }], 16384);
	const lines = output.split("\n");
	deepStrictEqual(
		lines.filter((line) => line.includes("route_warning")),
		[`route_warning run-thinking: ${message}`],
	);
	ok(lines.indexOf(`route_warning run-thinking: ${message}`) < lines.findIndex((line) => line.startsWith("- ")));
	ok(!output.includes("not a warning"));
});

test("a worker call denied for want of an operator tells the dispatching model its verification was limited", () => {
	const envelope = fixtureEnvelope("run-denied");
	const draft = fixtureReceiptDraft(envelope);
	const reason =
		"permission denied by policy: bash raised an operator-authority ask and no operator can answer worker asks for this dispatch; bash requires execute confirmation";
	draft.safety = {
		decisions: { allowed: 3, blocked: 0, permissionRequested: 2 },
		blockedAttempts: [
			{ tool: "bash", reason },
			{ tool: "bash", reason },
			{ tool: "write", reason: "outside the write roots" },
		],
	};
	const receipt = finishRunResult(draft, envelope, {
		terminal: { terminalReason: draft.terminalReason ?? "completed" },
		processExitCode: envelope.exitCode,
		frameType: null,
		usage: undefined,
	}).result;
	const lines = formatDispatchOutput("parallel", [{ ...run("run-denied", 0, "target-rates", 1), receipt }], 16384).split(
		"\n",
	);
	const limited = lines.filter((line) => line.startsWith("verification_limited"));
	deepStrictEqual(limited.length, 1);
	match(limited[0] ?? "", /^verification_limited run-denied: 2 worker calls \(bash\) needed operator approval/u);
	ok(lines.indexOf(limited[0] ?? "") < lines.findIndex((line) => line.startsWith("- ")));
});

test("a worker's account of a failed attempt is answered with the host feed's counts (bt-23 #3)", () => {
	const lines = (text: string) => {
		const envelope = fixtureEnvelope("run-claims");
		const draft = fixtureReceiptDraft(envelope);
		draft.toolCalls = 1;
		draft.toolStats = [{ tool: "edit", count: 1, ok: 1, errors: 0, blocked: 0, totalDurationMs: 1 }];
		draft.output = { state: "final", text, truncated: false, bytes: Buffer.byteLength(text) };
		const receipt = finishRunResult(draft, envelope, {
			terminal: { terminalReason: draft.terminalReason ?? "completed" },
			processExitCode: envelope.exitCode,
			frameType: null,
			usage: undefined,
		}).result;
		return formatDispatchOutput("single", [{ ...run("run-claims", 0, "target-rates", 1), receipt }], 16384)
			.split("\n")
			.filter((line) => line.startsWith("attempts "));
	};
	deepStrictEqual(
		lines("The first edit attempt had malformed arguments and changed nothing. The second edit applied the fix."),
		[
			"attempts run-claims: the worker's answer describes failed or refused calls; the host feed recorded 1 call, 0 errored and 0 refused. Report these counts, not the worker's account of its attempts.",
		],
	);
	deepStrictEqual(lines("Fixed the off-by-one in lib/math.js."), []);
});
