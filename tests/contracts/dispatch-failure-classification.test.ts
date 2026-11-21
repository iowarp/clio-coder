import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { clioStateDir } from "../../src/core/xdg.js";
import { isDeterministicOutcomeCode } from "../../src/domains/dispatch/backoff.js";
import type { GateTopologyRole } from "../../src/domains/dispatch/execution-role.js";
import {
	affectsTargetBreaker,
	classifyFailure,
	decideRetry,
	nodeComponentRemedy,
} from "../../src/domains/dispatch/failure-classification.js";
import { OBLIGATION_RETRY_LIMIT, resolveObligation, resolveRunRole } from "../../src/domains/dispatch/obligation.js";
import type { RunTerminationEvidence } from "../../src/domains/dispatch/outcome.js";
import {
	blockedStateChangingCalls,
	blockedWriteAttempts,
	readScopedNoToolsReason,
	recordToolFinish,
	summarizeToolActivity,
	workerNoWorkDetail,
} from "../../src/domains/dispatch/tool-stats.js";
import type { ToolCallStat } from "../../src/domains/dispatch/types.js";
import type { ActionClass } from "../../src/domains/safety/action-classifier.js";
import { readCallJournal } from "../../src/domains/telemetry/call-journal.js";
import { telemetryRunDirectory } from "../../src/domains/telemetry/paths.js";
import { WORKER_PROVIDER_HTTP_STATUS_MARKER } from "../../src/worker/spec-contract.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";
import { isolateClioEnv } from "../harness/scratch-env.js";
import { writeSettledRun } from "../harness/settled-run.js";

const evidence: RunTerminationEvidence = {
	exitCode: 1,
	abortedByOperator: false,
	stallKilled: false,
	timedOut: false,
	permissionFailure: false,
	policyDenied: null,
	stopReason: null,
};

function classifyTail(stderrTail: string) {
	return classifyFailure(evidence, { exitCode: 1, signal: null, stderrTail }, "failed", null);
}

describe("dispatch failure classification", () => {
	it("seals a mutation worker whose every write was blocked as a deterministic failure", () => {
		const classes: Record<string, ActionClass> = { read: "read", write: "write", edit: "write", bash: "execute" };
		const classify = (tool: string): ActionClass => classes[tool] ?? "unknown";
		const stats = (...rows: Array<Partial<ToolCallStat> & { tool: string }>): Map<string, ToolCallStat> =>
			new Map(rows.map((row) => [row.tool, { count: 0, ok: 0, errors: 0, blocked: 0, totalDurationMs: 0, ...row }]));
		const blockedWrites = [
			{ tool: "read", count: 2, ok: 2 },
			{ tool: "write", count: 2, blocked: 2 },
			{ tool: "edit", count: 1, blocked: 1 },
		];
		strictEqual(blockedWriteAttempts(stats(...blockedWrites), classify), 3);
		strictEqual(
			blockedWriteAttempts(stats(...blockedWrites, { tool: "edit", count: 2, ok: 1, blocked: 1 }), classify),
			null,
		);
		strictEqual(blockedWriteAttempts(stats(...blockedWrites, { tool: "bash", count: 1, ok: 1 }), classify), null);
		strictEqual(blockedWriteAttempts(stats({ tool: "read", count: 3, ok: 3 }), classify), null);
		strictEqual(isDeterministicOutcomeCode("worker_mutation_blocked"), true);
	});

	it("a store-only worker that put into its granted tag and noted a limitation did work", () => {
		const stats = new Map<string, ToolCallStat>();
		for (const actionClass of ["write", "write", "read"])
			recordToolFinish(stats, { tool: "store", outcome: "ok", actionClass });
		recordToolFinish(stats, { tool: "limitation", outcome: "ok", actionClass: "read" });
		const activity = summarizeToolActivity(stats, () => "read");
		strictEqual(workerNoWorkDetail({ activity, limitationRecorded: true, mutatedPathCount: 0 }), null);
		const readOnly = new Map<string, ToolCallStat>();
		recordToolFinish(readOnly, { tool: "store", outcome: "ok", actionClass: "read" });
		recordToolFinish(readOnly, { tool: "limitation", outcome: "ok", actionClass: "read" });
		const idle = summarizeToolActivity(readOnly, () => "read");
		match(workerNoWorkDetail({ activity: idle, limitationRecorded: true, mutatedPathCount: 0 }) ?? "", /changed nothing/);
	});

	it("journals a store-only worker's settled run with its store write in the tool activity", async () => {
		const env = await isolateClioEnv("clio-coder-store-settled-");
		try {
			const stats = new Map<string, ToolCallStat>();
			recordToolFinish(stats, { tool: "store", outcome: "ok", actionClass: "write" });
			const toolActivity = summarizeToolActivity(stats, () => "read");
			strictEqual(toolActivity.storeWritten, true);
			const runId = "store-worker-1";
			await writeSettledRun(clioStateDir(), { ...fixtureReceiptDraft(fixtureEnvelope(runId)), toolActivity });
			const journal = await readCallJournal(telemetryRunDirectory(clioStateDir(), runId));
			strictEqual(journal.skipped, 0);
			const settled = journal.records.map(({ record }) => record).find((record) => record.k === "run.settled");
			deepStrictEqual((settled?.data as { toolActivity?: unknown } | undefined)?.toolActivity, toolActivity);
		} finally {
			env.restore();
		}
	});

	it("resolves each run's obligation from its role and grades a zero-tool run against it, retrying once (M1)", () => {
		// FX-19: scout 339cwh27ifkd's only call was its result report; it sealed succeeded, quality=unmeasured, failed=0.
		const stats = new Map<string, ToolCallStat>();
		recordToolFinish(stats, { tool: "clio_submit_result", outcome: "ok", actionClass: "read" });
		const explorer = { capabilityClass: "read-only", readOnly: true };
		const role = (gateRole?: GateTopologyRole, facts = explorer) => resolveRunRole({ gateRole, ...facts });
		strictEqual(resolveObligation(role(), "scout-report", []), "observed-evidence");
		strictEqual(resolveObligation(role(), "oracle-report", ["src"]), "observed-evidence");
		strictEqual(resolveObligation(role(), "oracle-report", []), "answer");
		// A gate's inherited read roots are what it may read, not its assignment: a zero-call judge owes cited evidence.
		strictEqual(resolveObligation(role("judge"), "verifier-report", ["src"]), "cited-evidence");
		strictEqual(resolveObligation(role("member"), "scout-report", ["src"]), "answer");
		strictEqual(
			resolveObligation(role(undefined, { capabilityClass: "verification", readOnly: true }), null, ["src"]),
			"executed-checks",
		);
		strictEqual(
			resolveObligation(role(undefined, { capabilityClass: "workspace-edit", readOnly: false }), "mutation-report", []),
			"change-or-declared",
		);
		const scout = {
			activity: summarizeToolActivity(stats, () => "read"),
			obligation: "observed-evidence" as const,
			toolLaneObserved: true,
		};
		match(readScopedNoToolsReason(scout) ?? "", /^obligation observed-evidence unmet: no tools executed/);
		strictEqual(readScopedNoToolsReason({ ...scout, obligation: "cited-evidence" }), null);
		strictEqual(readScopedNoToolsReason({ ...scout, toolLaneObserved: false }), null);
		recordToolFinish(stats, { tool: "read", outcome: "ok", actionClass: "read" });
		strictEqual(readScopedNoToolsReason({ ...scout, activity: summarizeToolActivity(stats, () => "read") }), null);
		const failureClass = classifyFailure({ ...evidence, exitCode: 0, qualityGateFailure: true }, null, "failed", null);
		strictEqual(failureClass, "model-quality");
		strictEqual(decideRetry(failureClass, 0, OBLIGATION_RETRY_LIMIT).retry, true);
		strictEqual(decideRetry(failureClass, 1, OBLIGATION_RETRY_LIMIT).retry, false);
		// A zero-tool builder's worker_no_work retries on another model only when it carries the unmet obligation.
		const builder = { ...evidence, exitCode: 0, obligationUnmet: "change-or-declared" as const };
		strictEqual(classifyFailure(builder, null, "failed", "worker_no_work"), "model-quality");
		strictEqual(classifyFailure({ ...evidence, exitCode: 0 }, null, "failed", "worker_no_work"), "deterministic-task");
	});

	it("names an edit worker that ran no tool, or recorded a limitation and changed nothing, as having done no work", () => {
		const activity = (calls: number) => ({ calls, succeeded: calls, failed: 0, blocked: 0, mutatingSucceeded: false });
		match(
			workerNoWorkDetail({ activity: activity(0), limitationRecorded: false, mutatedPathCount: 0 }) ?? "",
			/executed no tools/,
		);
		match(
			workerNoWorkDetail({ activity: activity(4), limitationRecorded: true, mutatedPathCount: 0 }) ?? "",
			/changed nothing/,
		);
		strictEqual(workerNoWorkDetail({ activity: activity(4), limitationRecorded: true, mutatedPathCount: 2 }), null);
		strictEqual(workerNoWorkDetail({ activity: activity(4), limitationRecorded: true, mutatedPathCount: null }), null);
		strictEqual(workerNoWorkDetail({ activity: activity(4), limitationRecorded: false, mutatedPathCount: 0 }), null);
		const denied = { activity: activity(1), limitationRecorded: false, mutatedPathCount: 0, escalationsDenied: 1 };
		match(workerNoWorkDetail(denied) ?? "", /operator denied the worker's permission request/);
		strictEqual(
			workerNoWorkDetail({ ...denied, activity: { ...activity(1), mutatingSucceeded: true }, mutatedPathCount: 1 }),
			null,
		);
	});

	it("recognizes a prose-only limitation in the final mutation report without failing completed edits", () => {
		const input = {
			activity: { calls: 1, succeeded: 1, failed: 0, blocked: 0, mutatingSucceeded: false },
			limitationRecorded: false,
			mutatedPathCount: 0,
			finalText: JSON.stringify({
				mutatedPaths: [],
				summary: "Cannot add parseDuration because ms cannot parse compound strings. No edits made.",
			}),
		};
		match(workerNoWorkDetail(input) ?? "", /ms cannot parse compound strings/);
		strictEqual(workerNoWorkDetail({ ...input, mutatedPathCount: 1 }), null);
		strictEqual(workerNoWorkDetail({ ...input, finalText: "Already implemented; no changes needed." }), null);
	});

	it("fails an edit worker on refusals only when every state-changing call was refused and it did not report no change was needed (FL-1)", () => {
		const classify = (tool: string): ActionClass => (tool === "read" ? "read" : "execute");
		const stats = (...rows: Array<Partial<ToolCallStat> & { tool: string }>): Map<string, ToolCallStat> =>
			new Map(rows.map((row) => [row.tool, { count: 0, ok: 0, errors: 0, blocked: 0, totalDurationMs: 0, ...row }]));
		const refusedOnly = stats({ tool: "read", count: 3, ok: 3 }, { tool: "bash", count: 1, blocked: 1 });
		strictEqual(blockedStateChangingCalls(refusedOnly, classify), 1);
		const ranAndFailed = stats({ tool: "bash", count: 2, errors: 1, blocked: 1 });
		strictEqual(blockedStateChangingCalls(ranAndFailed, classify), 0);
		const input = {
			activity: { calls: 4, succeeded: 3, failed: 0, blocked: 1, mutatingSucceeded: false },
			limitationRecorded: false,
			mutatedPathCount: 0,
			blockedStateChanging: 1,
			finalText: "Done: the parser now handles the case.",
		};
		match(workerNoWorkDetail(input) ?? "", /refused by policy and nothing changed/u);
		const noChange = JSON.stringify({ mutatedPaths: [], summary: "No changes needed: the parser already handles it." });
		strictEqual(workerNoWorkDetail({ ...input, finalText: noChange }), null);
	});

	it("does not retry no-work outcomes or charge the provider breaker", () => {
		const failure = classifyFailure(evidence, null, "failed", "worker_no_work");
		strictEqual(failure, "deterministic-task");
		strictEqual(decideRetry(failure, 0, 2).retry, false);
		strictEqual(affectsTargetBreaker(failure), false);
	});

	it("does not retry ACP model admission or peer HTTP 400/404 or charge the peer breaker", () => {
		for (const tail of [
			"ACP delegation failed: ACP peer does not offer requested model 'gpt-6-unknown'",
			"ACP delegation failed: ACP peer offers multiple efforts for requested model 'gpt-6-luna'; specify thinkingLevel",
			"ACP delegation failed: ACP peer does not offer requested thinking level 'xhigh'; offered: low, medium, high",
			"ACP peer reported HTTP 400: The model is not supported.",
			"ACP peer reported HTTP 404: Model not found.",
			"ACP delegation failed: ACP session/prompt failed: HTTP 400 Bad Request",
		]) {
			const failureClass = classifyTail(tail);
			strictEqual(failureClass, "deterministic-task", tail);
			strictEqual(decideRetry(failureClass, 0, 2).retry, false, tail);
			strictEqual(affectsTargetBreaker(failureClass), false, tail);
		}
		strictEqual(classifyTail("ACP peer reported HTTP 500: server error"), "target-transient");
		strictEqual(classifyTail("ACP peer reported HTTP 408: request was rejected"), "target-transient");
	});

	it("does not resend a request the provider rejected with a 4xx, except 408 and 429", () => {
		const tail = (status: number) =>
			`${WORKER_PROVIDER_HTTP_STATUS_MARKER}${status}\n[worker] agent ended with stopReason=error: invalid request`;
		for (const status of [400, 404, 422]) {
			strictEqual(classifyTail(tail(status)), "deterministic-task", String(status));
			strictEqual(decideRetry(classifyTail(tail(status)), 0, 2).retry, false, String(status));
		}
		strictEqual(classifyTail(tail(429)), "target-rate-limit");
		// The ACP adapter's typed usage limit for an Antigravity quota failure moves off the target like a 429; another
		// runtime's quota or limit wording does not.
		strictEqual(
			classifyTail("Antigravity quota exhausted for gemini-x-high; resets at 2026-11-21T01:00:00.000Z"),
			"target-rate-limit",
		);
		for (const tail of ["Error: disk quota exhausted", "inotify watch usage limit reached"])
			strictEqual(classifyTail(tail), "worker-runtime", tail);
		strictEqual(classifyTail(tail(408)), "target-transient");
		strictEqual(decideRetry(classifyTail(tail(408)), 0, 2).retry, true);
	});

	it("keeps a provider context overflow off the target breaker and out of retry", () => {
		for (const tail of [
			"[worker] provider error: 400 This model's maximum context length is 8192 tokens. However, you requested 9000 tokens",
			"[worker] provider error: exceed_context_size_error: request (8009 tokens) exceeds the available context size (2048 tokens), try increasing it",
			"[worker] provider error: prompt too long; exceeded max context length by 812 tokens",
		]) {
			const failureClass = classifyTail(tail);
			strictEqual(failureClass, "deterministic-task", tail);
			strictEqual(affectsTargetBreaker(failureClass), false, tail);
			strictEqual(decideRetry(failureClass, 0, 2).retry, false, tail);
		}
	});

	it("does not retry a missing runtime SDK component and names the node-side install", () => {
		const message =
			"The copilot-sdk runtime needs @github/copilot-sdk@1.0.26. Run: clio-coder tools install copilot-sdk. This installs a separate component at /home/u/.local/share/clio-coder/components/copilot-sdk/1.0.26; it does not change CLIO Coder's installation.";
		const failureClass = classifyTail(`[worker] agent ended with stopReason=error: ${message}`);
		strictEqual(failureClass, "deterministic-task");
		strictEqual(decideRetry(failureClass, 0, 2).retry, false);
		strictEqual(affectsTargetBreaker(failureClass), false);
		match(
			nodeComponentRemedy(message, "loop"),
			/^The copilot-sdk runtime needs \S+\. Install it on node 'loop' from this client: clio-coder fleet nodes tools install loop copilot-sdk --yes\. This installs a separate component at \/home\/u\/\S+ on that node;/,
		);
	});

	it("reads status numbers and load words only from the provider message, typed status first", () => {
		for (const tail of [
			"[worker] tool output follows\nlistening on 127.0.0.1:4290\nnot ok 3 - handles 401 retries\nError: EACCES: permission denied, open 'x'",
			"[worker] tool output: sk-429 queue at 503 items on the gpu test\nError: boom",
		]) {
			strictEqual(classifyTail(tail), "worker-runtime", tail);
		}
		strictEqual(
			classifyTail(`${WORKER_PROVIDER_HTTP_STATUS_MARKER}401\n[worker] agent ended with stopReason=error: nope`),
			"target-auth",
		);
		strictEqual(
			classifyTail(`${WORKER_PROVIDER_HTTP_STATUS_MARKER}529\n[worker] agent ended with stopReason=error: busy`),
			"target-transient",
		);
		const overloaded = classifyTail(
			'[worker] agent ended with stopReason=error: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
		);
		strictEqual(overloaded, "target-transient", "overloaded_error");
		strictEqual(decideRetry(overloaded, 0, 2).excludedRouteParts.includes("node"), false);
	});

	it("treats bare 500s and connection failures as target-transient", () => {
		for (const tail of [
			"[worker] provider error: 500 status code (no body)",
			"[worker] provider error: Internal Server Error",
			"[worker] provider error: connect ECONNREFUSED 192.168.86.20:11434",
			"[worker] provider error: read ECONNRESET",
			"[worker] provider error: TypeError: fetch failed",
		]) {
			strictEqual(classifyTail(tail), "target-transient", tail);
		}
	});

	it("retries an output gap the host failed to drain on the same route without charging a breaker", () => {
		const classifyGap = (evidenceIncomplete: string) =>
			classifyFailure(
				evidence,
				{
					exitCode: 1,
					signal: null,
					stderrTail: `[worker] bulk evidence incomplete: ${evidenceIncomplete}`,
					evidenceIncomplete,
				},
				"failed",
				null,
			);
		for (const gap of [
			"orchestrator did not read worker stdout within 1000 ms after exit",
			"the worker reported stdout did not drain within 2000 ms",
		]) {
			const failureClass = classifyGap(gap);
			strictEqual(failureClass, "internal", gap);
			strictEqual(affectsTargetBreaker(failureClass), false, gap);
			const decision = decideRetry(failureClass, 0, 2);
			strictEqual(decision.retry, true, gap);
			strictEqual(decision.excludedRouteParts.length, 0, gap);
		}
		strictEqual(classifyGap("the final bulk frame was truncated"), "worker-runtime");
	});
});
