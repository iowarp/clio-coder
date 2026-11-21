import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { GRADE_LAYERS, GRADE_RULE_IDS } from "../../src/core/telemetry/run-vocabulary.js";
import { clioStateDir } from "../../src/core/xdg.js";
import { isDeterministicOutcomeCode } from "../../src/domains/dispatch/backoff.js";
import type { GateTopologyRole } from "../../src/domains/dispatch/execution-role.js";
import {
	affectsTargetBreaker,
	classifyFailure,
	decideRetry,
	nodeComponentRemedy,
} from "../../src/domains/dispatch/failure-classification.js";
import { grade } from "../../src/domains/dispatch/grading.js";
import { OBLIGATION_RETRY_LIMIT, resolveObligation, resolveRunRole } from "../../src/domains/dispatch/obligation.js";
import type { RunTerminationEvidence } from "../../src/domains/dispatch/outcome.js";
import {
	blockedStateChangingCalls,
	blockedWriteAttempts,
	executedCalls,
	recordToolFinish,
	summarizeToolActivity,
} from "../../src/domains/dispatch/tool-stats.js";
import type { ToolCallStat } from "../../src/domains/dispatch/types.js";
import type { ActionClass } from "../../src/domains/safety/action-classifier.js";
import { readCallJournal } from "../../src/domains/telemetry/call-journal.js";
import { telemetryRunDirectory } from "../../src/domains/telemetry/paths.js";
import { WORKER_PROVIDER_HTTP_STATUS_MARKER } from "../../src/worker/spec-contract.js";
import { settleStubBuilder } from "../harness/dispatch.js";
import { BUILDER_GRADE, cleanGradeFacts, gradeWork } from "../harness/grade-facts.js";
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
		const work = (activity: ReturnType<typeof summarizeToolActivity>) => ({
			activity: {
				executed: executedCalls(activity),
				observations: activity.succeeded,
				mutatingSucceeded: activity.mutatingSucceeded,
				storeWritten: activity.storeWritten === true,
			},
			recordedLimitations: ["the store tag was the deliverable"],
		});
		strictEqual(gradeWork(work(summarizeToolActivity(stats, () => "read"))).outcome, "succeeded");
		const readOnly = new Map<string, ToolCallStat>();
		recordToolFinish(readOnly, { tool: "store", outcome: "ok", actionClass: "read" });
		recordToolFinish(readOnly, { tool: "limitation", outcome: "ok", actionClass: "read" });
		const idle = gradeWork(work(summarizeToolActivity(readOnly, () => "read")));
		strictEqual(idle.outcomeCode, "worker_not_done");
		match(idle.detail ?? "", /changed nothing/);
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
			role: "explorer" as const,
			obligation: "observed-evidence" as const,
			contractKind: "scout-report",
			toolLaneObserved: true,
		};
		const executed = executedCalls(summarizeToolActivity(stats, () => "read"));
		const idle = { activity: { executed, observations: 0, mutatingSucceeded: false, storeWritten: false } };
		const unmet = gradeWork(idle, scout);
		strictEqual(unmet.outcomeCode, "obligation_unmet");
		match(unmet.detail ?? "", /^obligation observed-evidence unmet: no tools executed/);
		strictEqual(unmet.retryObligation, "observed-evidence");
		deepStrictEqual(
			unmet.rules.find((rule) => rule.id === "obligation"),
			{ id: "obligation", layer: "V3", status: "fail", code: "obligation_unmet" },
		);
		strictEqual(gradeWork(idle, { ...scout, role: "judge", obligation: "cited-evidence" }).outcome, "succeeded");
		strictEqual(gradeWork(idle, { ...scout, toolLaneObserved: false }).outcome, "succeeded");
		recordToolFinish(stats, { tool: "read", outcome: "ok", actionClass: "read" });
		const read = executedCalls(summarizeToolActivity(stats, () => "read"));
		strictEqual(gradeWork({ activity: { ...idle.activity, executed: read } }, scout).outcome, "succeeded");
		const failureClass = classifyFailure({ ...evidence, exitCode: 0, qualityGateFailure: true }, null, "failed", null);
		strictEqual(failureClass, "model-quality");
		strictEqual(decideRetry(failureClass, 0, OBLIGATION_RETRY_LIMIT).retry, true);
		strictEqual(decideRetry(failureClass, 1, OBLIGATION_RETRY_LIMIT).retry, false);
		// A zero-tool builder's obligation_unmet retries on another model only when the grader marked it retryable.
		const builder = { ...evidence, exitCode: 0, obligationUnmet: "change-or-declared" as const };
		strictEqual(classifyFailure(builder, null, "failed", "obligation_unmet"), "model-quality");
		strictEqual(classifyFailure({ ...evidence, exitCode: 0 }, null, "failed", "obligation_unmet"), "deterministic-task");
	});

	it("grades an edit worker that ran no tool, or recorded a limitation and changed nothing, as having done no work", () => {
		const activity = (executed: number) => ({
			executed,
			observations: executed,
			mutatingSucceeded: false,
			storeWritten: false,
		});
		const none = gradeWork({ activity: activity(0) });
		strictEqual(none.outcomeCode, "obligation_unmet");
		match(none.detail ?? "", /executed no tools/);
		strictEqual(none.retryObligation, "change-or-declared");
		const limited = gradeWork({ activity: activity(4), recordedLimitations: ["no access"] });
		strictEqual(limited.outcomeCode, "worker_not_done");
		match(limited.detail ?? "", /changed nothing/);
		const landed = { activity: activity(4), recordedLimitations: ["x"] };
		strictEqual(gradeWork({ ...landed, mutatedPathCount: 2 }).outcome, "succeeded");
		strictEqual(gradeWork({ ...landed, mutatedPathCount: null }).outcome, "succeeded");
		strictEqual(gradeWork({ activity: activity(4) }).outcome, "succeeded");
		const denied = gradeWork({ activity: activity(1), escalations: { denied: 1, timedOut: 0 } });
		strictEqual(denied.outcomeCode, "obligation_unmet");
		match(denied.detail ?? "", /operator denied the worker's permission request/);
		strictEqual(denied.retryObligation, null);
		const deniedButChanged = gradeWork({
			activity: { ...activity(1), mutatingSucceeded: true },
			mutatedPathCount: 1,
			escalations: { denied: 1, timedOut: 0 },
		});
		strictEqual(deniedButChanged.outcome, "succeeded");
	});

	it("reads a builder's finish from its typed completion, never its report's prose (M9)", () => {
		const declared = {
			state: "not_done" as const,
			limitations: [{ what: "ms cannot parse compound strings", why: "out_of_scope" as const }],
			unverified: [],
		};
		const notDone = gradeWork({ completion: declared });
		strictEqual(notDone.outcomeCode, "worker_not_done");
		match(notDone.detail ?? "", /ms cannot parse compound strings/);
		strictEqual(notDone.retryObligation, null);
		const partial = gradeWork({ completion: { ...declared, state: "partly_done" }, mutatedPathCount: 1 });
		strictEqual(partial.outcomeCode, "worker_partial_work");
		strictEqual(gradeWork({ completion: { state: "done", limitations: [], unverified: [] } }).outcome, "succeeded");
		// Without a typed declaration the same words in the summary decide nothing.
		strictEqual(gradeWork({ completion: null }).outcome, "succeeded");
		strictEqual(BUILDER_GRADE.obligation, "change-or-declared");
	});

	it("fails an edit worker on refusals only when every state-changing call was refused and it did not declare done (FL-1)", () => {
		const classify = (tool: string): ActionClass => (tool === "read" ? "read" : "execute");
		const stats = (...rows: Array<Partial<ToolCallStat> & { tool: string }>): Map<string, ToolCallStat> =>
			new Map(rows.map((row) => [row.tool, { count: 0, ok: 0, errors: 0, blocked: 0, totalDurationMs: 0, ...row }]));
		const refusedOnly = stats({ tool: "read", count: 3, ok: 3 }, { tool: "bash", count: 1, blocked: 1 });
		strictEqual(blockedStateChangingCalls(refusedOnly, classify), 1);
		const ranAndFailed = stats({ tool: "bash", count: 2, errors: 1, blocked: 1 });
		strictEqual(blockedStateChangingCalls(ranAndFailed, classify), 0);
		const refused = gradeWork({ blockedStateChanging: 1 });
		strictEqual(refused.outcomeCode, "obligation_unmet");
		match(refused.detail ?? "", /refused by policy and nothing changed/u);
		const done = { state: "done" as const, limitations: [], unverified: [] };
		strictEqual(gradeWork({ blockedStateChanging: 1, completion: done }).outcome, "succeeded");
	});

	it("does not retry no-work outcomes or charge the provider breaker", () => {
		const failure = classifyFailure(evidence, null, "failed", "obligation_unmet");
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

it("grades through one rule table in layer order: the first failing rule names the outcome, later ones are not reached (M9)", () => {
	const clean = gradeWork({});
	strictEqual(clean.outcome, "succeeded");
	deepStrictEqual(
		clean.rules.map((rule) => rule.id),
		[...GRADE_RULE_IDS],
	);
	const layers = clean.rules.map((rule) => GRADE_LAYERS.indexOf(rule.layer));
	deepStrictEqual(
		layers,
		[...layers].sort((a, b) => a - b),
		"rules run cheapest layer first",
	);
	ok(clean.rules.every((rule) => rule.status === "pass" || rule.status === "not_applicable"));
	// V2 before V3: a non-conforming report fails the run before its obligation is judged, whatever the work did.
	const idle = { activity: { executed: 0, observations: 0, mutatingSucceeded: false, storeWritten: false } };
	const invalid = grade(
		BUILDER_GRADE,
		cleanGradeFacts({ handback: { finalOutput: true, resultContract: { conformance: "fail", reason: "bad" } } }, idle),
	);
	strictEqual(invalid.outcomeCode, "result_contract_invalid");
	const status = (id: string) => invalid.rules.find((rule) => rule.id === id)?.status;
	deepStrictEqual(["result-contract", "obligation", "host-checks", "removed-tests"].map(status), [
		"fail",
		"not_reached",
		"not_reached",
		"not_reached",
	]);
	// The same work with a conforming report meets V3's verdict instead.
	strictEqual(gradeWork(idle).outcomeCode, "obligation_unmet");
	// An `always` rule still reports after an earlier failure: the worker's own code rides a failed termination.
	const crashed = grade(
		BUILDER_GRADE,
		cleanGradeFacts({
			termination: { outcome: "failed", detail: "exit code 1" },
			workerCode: { code: "worker_context_exhausted", detail: "context passed its window" },
		}),
	);
	strictEqual(crashed.outcomeCode, "worker_context_exhausted");
	strictEqual(crashed.rules.find((rule) => rule.id === "final-output")?.status, "not_reached");
});

describe("cited-evidence over an evidence packet (M10)", () => {
	it("grounds a reviewer's passing check in the packet ids it cites, and still exhausts an uncited or unearned pass", () => {
		const reviewer = {
			role: "reviewer" as const,
			obligation: "cited-evidence" as const,
			contractKind: "review-verdict",
			toolLaneObserved: true,
			packet: ["s1.handback", "s1.diff"],
		};
		const pass = (cites: string[]) => ({
			activity: { executed: 0, observations: 0, mutatingSucceeded: false, storeWritten: false },
			ungroundedChecks: ["the change matches the task"],
			gateVerdict: {
				verdict: "pass" as const,
				checks: [{ name: "the change matches the task", cites, passed: true, command: false, ran: false }],
			},
		});
		strictEqual(gradeWork(pass(["s1.diff"]), reviewer).outcome, "succeeded");
		match(gradeWork(pass([]), reviewer).detail ?? "", /^obligation cited-evidence unmet: the verdict cites no item/u);
		match(gradeWork(pass(["s7.diff"]), reviewer).detail ?? "", /does not hold \(s7\.diff\)/u);
		const { packet: _packet, ...noPacket } = reviewer;
		const unearned = gradeWork(pass(["s1.diff"]), noPacket);
		strictEqual(unearned.outcomeCode, "obligation_unmet", "with no packet, a claimed and unrun check stays unearned");
	});

	it("grounds a command-shaped pass only by a run the gate observed or a verified host check, per check", () => {
		const reviewer = {
			role: "reviewer" as const,
			obligation: "cited-evidence" as const,
			contractKind: "review-verdict",
			toolLaneObserved: true,
			packet: ["s1.handback", "s1.diff", "s1.check.test", "s1.check.lint"],
			verifiedChecks: ["s1.check.test"],
		};
		const npmTest = (cites: string[], ran = false) => ({ name: "npm test", cites, passed: true, command: true, ran });
		const work = (
			checks: Array<{ name: string; cites: string[]; passed: boolean; command: boolean; ran: boolean }>,
			observations = 3,
		) => ({
			activity: { executed: observations, observations, mutatingSucceeded: false, storeWritten: false },
			ungroundedChecks: [],
			gateVerdict: { verdict: "pass" as const, checks },
		});
		// The builder's own handback cannot ground a check the reviewer never ran (4.8).
		match(gradeWork(work([npmTest(["s1.handback"])]), reviewer).detail ?? "", /claims checks it never ran \(npm test\)/u);
		strictEqual(gradeWork(work([npmTest(["s1.diff"])]), reviewer).outcomeCode, "obligation_unmet");
		// A rejected or unverified host check grounds nothing either.
		strictEqual(gradeWork(work([npmTest(["s1.check.lint"])]), reviewer).outcomeCode, "obligation_unmet");
		strictEqual(gradeWork(work([npmTest(["s1.check.test"])]), reviewer).outcome, "succeeded");
		strictEqual(gradeWork(work([npmTest(["s1.diff"], true)]), reviewer).outcome, "succeeded");
		// Matched per check: one grounded "npm test" does not earn a second, ungrounded one.
		const twice = gradeWork(work([npmTest(["s1.check.test"]), npmTest(["s1.handback"])]), reviewer);
		strictEqual(twice.outcomeCode, "obligation_unmet");
		// A non-command claim rests on the diff it cites; a failed claim needs no corroboration.
		const reading = { name: "the change matches the task", cites: ["s1.diff"], passed: true, command: false, ran: false };
		strictEqual(
			gradeWork(work([reading, { ...npmTest(["s1.handback"]), passed: false }]), reviewer).outcome,
			"succeeded",
		);
		// An unobserved tool lane cannot say an uncited check rests on an observation: unknown, not a silent pass.
		const blind = { ...reviewer, toolLaneObserved: false };
		const uncited = gradeWork(work([reading, { ...reading, cites: [] }]), blind);
		strictEqual(uncited.rules.find((rule) => rule.id === "obligation")?.status, "unknown");
	});
});

it("a builder that read, recorded a limitation and changed nothing seals worker_not_done, not succeeded (M-39)", async () => {
	// Wave-43 run 2krnb50hhugv: 15 reads, one limitation, no write; its finish assessment kept no limitation words.
	const env = await isolateClioEnv("dispatch-limitation-only-");
	try {
		const root = join(env.dir, "project");
		mkdirSync(root, { recursive: true });
		const finished = (tool: string) => ({
			type: "clio_coder_tool_finish",
			payload: { tool, outcome: "ok", durationMs: 1 },
		});
		const { receipt } = await settleStubBuilder({
			cwd: root,
			report: { completion: { state: "done", limitations: [], unverified: [] }, mutatedPaths: [], validations: [] },
			events: [finished("read"), finished("limitation")],
		});
		strictEqual(receipt.outcome, "failed");
		strictEqual(receipt.outcomeCode, "worker_not_done");
		match(receipt.outcomeDetail ?? "", /worker recorded a limitation and changed nothing/u);
		deepStrictEqual(
			receipt.verdict?.rules.find((rule) => rule.id === "obligation"),
			{ id: "obligation", layer: "V3", status: "fail", code: "worker_not_done" },
		);
	} finally {
		env.restore();
	}
});
