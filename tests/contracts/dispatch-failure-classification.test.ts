import { match, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { isDeterministicOutcomeCode } from "../../src/domains/dispatch/backoff.js";
import {
	affectsTargetBreaker,
	classifyFailure,
	decideRetry,
} from "../../src/domains/dispatch/failure-classification.js";
import type { RunTerminationEvidence } from "../../src/domains/dispatch/outcome.js";
import { blockedWriteAttempts, workerNoWorkDetail } from "../../src/domains/dispatch/tool-stats.js";
import type { ToolCallStat } from "../../src/domains/dispatch/types.js";
import type { ActionClass } from "../../src/domains/safety/action-classifier.js";

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
	});

	it("recognizes a prose-only limitation in the final mutation report without failing completed edits", () => {
		const input = {
			activity: { calls: 1, succeeded: 1, failed: 0, blocked: 0, mutatingSucceeded: false },
			limitationRecorded: false,
			mutatedPathCount: 0,
			finalText: JSON.stringify({ mutatedPaths: [], summary: "Cannot add parseDuration because ms cannot parse compound strings. No edits made." }),
		};
		match(workerNoWorkDetail(input) ?? "", /ms cannot parse compound strings/);
		strictEqual(workerNoWorkDetail({ ...input, mutatedPathCount: 1 }), null);
		strictEqual(workerNoWorkDetail({ ...input, finalText: "Already implemented; no changes needed." }), null);
	});

	it("does not retry ACP model admission or peer HTTP 400/404 or charge the peer breaker", () => {
		for (const tail of [
			"ACP delegation failed: ACP peer does not offer requested model 'gpt-6-unknown'",
			"ACP delegation failed: ACP peer offers multiple efforts for requested model 'gpt-6-luna'; specify thinkingLevel",
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
});
