import { join } from "node:path";
import { mentionsWorkerToolCallCap } from "../core/guardrails.js";
import type { EvidenceAssessed, RunResultObject, RunSettled } from "../core/telemetry/schemas.js";
import { clioStateDir } from "../core/xdg.js";
import {
	parseVerifierResult,
	RESULT_SUMMARY_MAX_BYTES_CEILING,
	resultContractAuthorship,
	type StructuredHelperResult,
} from "../domains/agents/result-contract.js";
import { sealedAnswerBudgetBytes } from "../domains/dispatch/handback.js";
import { hostCheckBaseNote, hostCheckNotRunNote } from "../domains/dispatch/host-verification-note.js";
import { settleFinishedRun } from "../domains/dispatch/run-settlement.js";
import type { RunResult, RunResultDraft } from "../domains/dispatch/types.js";
import { formatTrustAxes, formatTrustSummary } from "../domains/evidence/trust-projection.js";
import {
	adaptRunTrustStatus,
	type CanonicalTrustStatus,
	composeTrustStatus,
	normalizeTrustStatus,
	type RunIntegrity,
} from "../domains/evidence/trust-status.js";
import { classify } from "../domains/safety/action-classifier.js";
import { telemetryObjectRef } from "../domains/telemetry/objects.js";
import { telemetryObjectsDirectory, telemetryRunDirectory } from "../domains/telemetry/paths.js";
import { readRunRecord } from "../domains/telemetry/run-record.js";
import { truncateUtf8 } from "./truncate-utf8.js";

/**
 * A finished run as worker evidence reads it: the facts its run.settled records, the result object it delivered and
 * the findings its evidence.assessed holds, whether the producing process holds them in memory or a reader loaded them
 * from the sealed run scope (#434).
 */
export interface FinishedRun {
	runId: string;
	/** The run's identity, the digest of its run.settled; null for a view built before the run settled. */
	digest: string | null;
	facts: Pick<
		RunSettled,
		| "route"
		| "node"
		| "routingIntent"
		| "agentId"
		| "executionRole"
		| "outcome"
		| "outcomeCode"
		| "exitCode"
		| "outcomeDetail"
		| "failureMessage"
		| "verification"
		| "quality"
		| "validationGrounding"
		| "hostVerification"
		| "toolActivity"
		| "capabilityMismatch"
		| "budget"
		| "context"
		| "upstream"
		| "skills"
		| "contextProvenance"
		| "hashes"
		| "flowRestrictions"
		| "toolCalls"
		| "tools"
		| "blockedAttempts"
		| "guardBlockedAttempts"
		| "permissionRequestedAttempts"
		| "escalations"
		| "worktree"
		| "routeWarnings"
		| "answerBudgetBytes"
	>;
	delivered: RunResultObject | null;
	/** The run's journaled assessment; null when the run has none or the producer has not read it back. */
	assessment: Pick<EvidenceAssessed, "firstPassSuccess" | "findings" | "trust"> | null;
}

const authenticated = (integrity: RunIntegrity) => integrity.state === "verified";

/** Expose only a completed, sealed handoff. Conformance does not imply evidence quality. */
export function runHelperResult(run: FinishedRun, integrity: RunIntegrity): StructuredHelperResult | null {
	const output = run.delivered?.output;
	if (
		!authenticated(integrity) ||
		run.facts.exitCode !== 0 ||
		run.facts.outcome !== "succeeded" ||
		output?.state !== "final" ||
		output.truncated ||
		run.facts.quality?.resultContract?.conformance !== "pass"
	)
		return null;
	// The kind was validated against the contract before the run settled.
	return (output.structured as StructuredHelperResult | undefined) ?? null;
}

function boundedPathField(name: string, listed: { count: number; paths: string[] } | undefined): string[] {
	if (listed === undefined) return [];
	const shown = listed.paths.slice(0, 8);
	const more = listed.count - shown.length;
	return [`${name}=${listed.count}${JSON.stringify(shown)}${more > 0 ? `(+${more} more)` : ""}`];
}

/**
 * Where a task worktree's work ended up. Only the host knows: a worker reports
 * from inside the tree, often says it did not commit, and may name paths in a
 * worktree that a merge has since removed.
 */
function taskWorktreeLines(run: FinishedRun): string[] {
	const worktree = run.delivered?.worktree;
	if (worktree === undefined || worktree === null) return [];
	const commit = worktree.commit !== undefined ? ` at ${worktree.commit.slice(0, 7)}` : "";
	const held = `branch ${worktree.branch}${commit}, worktree ${worktree.path}`;
	const landing =
		run.facts.worktree?.applied === true
			? (worktree.detail ?? "merged")
			: worktree.reason !== undefined
				? `not merged, ${worktree.reason}${worktree.detail !== undefined ? ` (${worktree.detail})` : ""}; the work is on ${held}`
				: `preserved, not merged; the work is on ${held}`;
	return [
		`  ${[
			`task worktree: ${landing}`,
			...(worktree.changedPaths !== undefined ? [`changed=${JSON.stringify(worktree.changedPaths.slice(0, 20))}`] : []),
			...boundedPathField("left_uncommitted", worktree.leftUncommitted),
			...boundedPathField("changed_after_commit", worktree.changedAfterCommit),
		].join("; ")}`,
	];
}

/**
 * The bytes of a run's answer its parent sees in a compact dispatch result, a collect and the run record: the number
 * sealed at dispatch and told to the worker (M3), or a lone run's budget for a run sealed before it was.
 */
export function runAnswerBudgetBytes(run: FinishedRun): number {
	return sealedAnswerBudgetBytes(run.facts.answerBudgetBytes);
}

/** Where the rest of a cut answer is read. */
export function fullAnswerPointer(runId: string): string {
	return `monitor(mode="answer", run_id=${JSON.stringify(runId)})`;
}

/**
 * An answer cut to `maxBytes` at a line boundary when one falls in its second half, followed by how much was cut
 * and where the rest is. An answer within the budget is returned whole.
 */
export function compactAnswer(text: string, runId: string, maxBytes: number): string {
	const total = Buffer.byteLength(text, "utf8");
	if (total <= maxBytes) return text;
	const head = truncateUtf8(text, maxBytes, "");
	const lineEnd = head.lastIndexOf("\n");
	const kept = lineEnd >= head.length / 2 ? head.slice(0, lineEnd) : head;
	return `${kept}\n[answer excerpt: ${Buffer.byteLength(kept, "utf8")} of ${total} bytes; the whole answer is in ${fullAnswerPointer(runId)}]`;
}

/**
 * A helper result within `maxBytes` whole; past it, the leading findings that fit as whole JSON when the result
 * carries a findings list, else a byte excerpt, followed by what was shown of the total and the call that reads it all.
 */
function helperResultExcerpt(data: unknown, runId: string, maxBytes: number): string {
	const whole = JSON.stringify(data);
	const total = Buffer.byteLength(whole, "utf8");
	if (total <= maxBytes) return whole;
	const rest = `of ${total} bytes; the whole result is in ${fullAnswerPointer(runId)}]`;
	const findings =
		typeof data === "object" && data !== null && Array.isArray((data as { findings?: unknown }).findings)
			? (data as { findings: unknown[] }).findings
			: null;
	if (findings !== null) {
		for (let shown = findings.length - 1; shown > 0; shown--) {
			const text = JSON.stringify({ ...(data as object), findings: findings.slice(0, shown) });
			const bytes = Buffer.byteLength(text, "utf8");
			if (bytes <= maxBytes)
				return `${text}\n[helper result excerpt: showing ${shown} of ${findings.length} findings, ${bytes} ${rest}`;
		}
	}
	const head = truncateUtf8(whole, maxBytes, "");
	return `${head}\n[helper result excerpt: ${Buffer.byteLength(head, "utf8")} ${rest}`;
}

export function compactHelperResultLines(run: FinishedRun, integrity: RunIntegrity, maxBytes: number): string[] | null {
	const result = runHelperResult(run, integrity);
	if (result === null) return null;
	const quality = run.facts.quality?.resultContract?.quality ?? "unmeasured";
	return [
		`- ${run.facts.agentId} · run ${run.runId} · ${result.kind} · quality=${quality}`,
		...(quality !== "pass"
			? [
					result.kind === "scout-report"
						? "  Findings without path and line are ungrounded leads; do not present them as verified facts."
						: "  Content is contract-valid; its factual accuracy is not measured.",
				]
			: []),
		`  ${helperResultExcerpt(result.data, run.runId, maxBytes)}`,
		// The run's own work counters: without them a helper result hides `mutations:no` on an edit task (FX-4).
		...activityLabels(run, finishedRunTrustStatus(run, integrity)).map((label) => `  ${label}`),
		...taskWorktreeLines(run),
		`  Run record available on demand: monitor(mode="record", run_id=${JSON.stringify(run.runId)}).`,
		...skillLoadLabels(run).map((label) => `  ${label}`),
	];
}

/** Matches a source citation the parent can independently spot-check. */
const SOURCE_CITATION_PATTERN = /([\w./~-]+):(\d+)/g;

export interface SourceCitation {
	path: string;
	line: number;
}

function sourceCitations(text: string): SourceCitation[] {
	const citations: SourceCitation[] = [];
	for (const match of text.matchAll(SOURCE_CITATION_PATTERN)) {
		const path = match[1];
		const line = Number(match[2]);
		if (path && Number.isSafeInteger(line) && line > 0) citations.push({ path, line });
	}
	return citations;
}

function hasSourceCitation(text: string): boolean {
	return sourceCitations(text).length > 0;
}

/** Dispatch and fleet discovery teach the same scope-aware verification discipline. */
export { FLEET_EVIDENCE_GUIDANCE as SPOT_CHECK_GUIDANCE } from "../domains/agents/catalog.js";

/**
 * Whether this run was dispatched as work that has to change the tree. Read
 * from sealed fields only: the execution role a mutation-capable recipe
 * derives, or a mutation-shaped result contract. A verifier asked to edit
 * keeps its own role, so this is deliberately narrow; the activity and
 * first-pass labels below carry the honest signal for every other class.
 */
function isMutationClassRun(run: FinishedRun, status: CanonicalTrustStatus): boolean {
	// A read-only agent settles `not_applicable`; recon that changes nothing is
	// the expected outcome there, not a missing effect.
	if (status.validationGrounding.state === "not_applicable") return false;
	if (run.facts.executionRole === "builder" || run.facts.executionRole === "recovery") return true;
	return run.facts.quality?.resultContract?.sourceId?.startsWith("agent-result-contract:mutation-report") === true;
}

/**
 * Facts the harness knew before or independently of the worker's account of
 * itself: the capability/task pairing it was admitted under, and how many of
 * its passing validation claims correspond to a command it actually ran. Both
 * exist because a live verifier run sealed `exit=0 ... failed=0` on a
 * fabricated `npm run typecheck` for a script that does not exist, and neither
 * honest signal reached the line the orchestrator reads.
 */
function admissionLabels(run: FinishedRun): string[] {
	const labels: string[] = [];
	const mismatch = run.facts.capabilityMismatch;
	if (mismatch !== null) {
		labels.push(
			`capability_mismatch=${mismatch.capabilityClass}/${mismatch.taskType}${
				mismatch.suggestedAgentId === null ? "" : ` suggested:${mismatch.suggestedAgentId}`
			}`,
		);
	}
	const grounding = run.facts.validationGrounding;
	if (grounding !== null) {
		labels.push(
			`validations=claimed:${grounding.claimed} grounded:${grounding.grounded}${
				grounding.ungrounded.length > 0
					? ` ${grounding.basis === "no-command-executed" ? "unverifiable" : grounding.basis === "unattributable-status" ? "unattributable" : "unmatched"}:${grounding.ungrounded
							.map((name) => JSON.stringify(name))
							.join(",")}`
					: ""
			}`,
		);
	}
	return labels;
}

/**
 * Whether a state-changing call of the run landed. `mutatingSucceeded` counts any successful shell call, so a worker
 * whose only write was refused read `mutations:yes` beside a passing `git status`. A shell call may have changed
 * anything, so it counts until the run's measured tree delta says the tree did not move, the rule
 * `blockedWriteAttempts` settles the run's outcome by; a write-class call that succeeded always counts.
 */
function mutationLanded(run: FinishedRun, activity: NonNullable<FinishedRun["facts"]["toolActivity"]>): boolean {
	if (!activity.mutatingSucceeded) return false;
	const delta = run.delivered?.worktree?.changedPaths ?? run.delivered?.checkoutChanges?.changedPaths;
	if (delta === undefined || delta.length > 0) return true;
	return run.facts.tools.some((stat) => stat.ok > 0 && classify({ tool: stat.tool }).actionClass === "write");
}

/**
 * Sealed work facts for the run line. `exit=0` alone has proven to be a
 * misleading headline: a worker that never executed a call, or whose every
 * mutating call was blocked, still exits 0 and still claims in prose that it
 * fixed the file. These labels are the receipt's own counters, so the parent
 * sees the shape of the run before it reads the worker's account of it.
 */
function activityLabels(run: FinishedRun, status: CanonicalTrustStatus): string[] {
	const labels: string[] = [];
	const activity = run.facts.toolActivity;
	if (activity !== null) {
		const landed = mutationLanded(run, activity);
		labels.push(
			`work=calls:${activity.calls} ok:${activity.succeeded} failed:${activity.failed} blocked:${activity.blocked}${(activity.withheld ?? 0) > 0 ? ` withheld:${activity.withheld}` : ""} mutations:${
				landed ? "yes" : "no"
			}${(activity.unfinished ?? 0) > 0 ? ` unfinished:${activity.unfinished}` : ""}`,
		);
		// The case this whole label set exists for: the task was to change
		// something and nothing changed, under an exit code that says success.
		if (!landed && isMutationClassRun(run, status)) labels.push("mutation_effect=none");
	}
	// A timed-out ask is always denied. Without its cause, a refused call read as a policy or routing refusal (bt-11 t).
	const timedOut = run.facts.escalations?.timedOut ?? 0;
	if (timedOut > 0) {
		labels.push(
			`refused_cause=approval_timeout:${timedOut} (${timedOut === 1 ? "a call waited" : "calls waited"} for approval and no one answered in time)`,
		);
	}
	const assessment = run.assessment;
	if (assessment !== null) {
		if (!assessment.firstPassSuccess) labels.push("first_pass=false");
		const tags = [...new Set(assessment.findings.filter((finding) => finding.severity === "warn").map((f) => f.tag))];
		if (tags.length > 0) labels.push(`findings=${tags.sort().join(",")}`);
	}
	return labels;
}

/** Settled load provenance, bounded by count and name without exposing skill paths or bodies. */
function skillLoadLabels(run: FinishedRun): string[] {
	const activations = run.facts.skills;
	if (activations.length === 0) return [];
	const shown = activations.slice(0, 6).map((activation) => {
		const name = activation.name.length > 64 ? `${activation.name.slice(0, 63)}…` : activation.name;
		const origin =
			activation.requestSource === "recipe"
				? "recipe-bound"
				: activation.requestSource === null
					? "binding unrecorded"
					: activation.requestSource;
		return `${JSON.stringify(name)} (${origin})`;
	});
	const omitted = activations.length - shown.length;
	return [
		`skill loads (${activations.length}): ${shown.join(", ")}${omitted > 0 ? `, and ${omitted} more` : ""}. Activation records a load, not execution of the skill workflow or a commit.`,
	];
}

/** A context hash the run settled, by the field it was computed for. */
function settledHash(run: FinishedRun, field: string): string | undefined {
	return run.facts.hashes.find((entry) => entry.field === field)?.hash;
}

/**
 * Model-facing run facts. The positive integrity label is reachable only when the run's record is authenticated: held
 * by the process that settled it, or read back under a seal that verifies. Briefing and project context stay
 * separate, and neither line includes prompt prose.
 */
export function runEvidenceLabels(run: FinishedRun, integrity: RunIntegrity): string[] {
	const status = finishedRunTrustStatus(run, integrity);
	const canonical = canonicalTrustLabels(status);
	if (integrity.state !== "verified")
		return [...canonical, `run_integrity=${integrity.state.toUpperCase()} reason=${JSON.stringify(integrity.reason)}`];
	const facts = run.facts;
	const briefingHash = settledHash(run, "briefing.contentHash");
	const briefing =
		facts.context.briefingBytes === null
			? "briefing=none"
			: `briefing=bytes:${facts.context.briefingBytes}${briefingHash ? ` sha256:${briefingHash}` : ""}`;
	const project = facts.context.project;
	const projectHash = settledHash(run, "projectContext.contentHash");
	const projectContext =
		project === null
			? "project_context=absent"
			: `project_context=${project.tier} chars:${project.chars ?? 0}${
					project.sections.length > 0 ? ` sections:${[...project.sections].sort().join(",")}` : ""
				}${projectHash !== undefined ? ` sha256:${projectHash}` : ""}`;
	const worker = facts.context.worker;
	const workerHash = settledHash(run, "workerContext.contentHash");
	const host = facts.hostVerification;
	const checks = run.delivered?.hostVerification?.checks ?? [];
	return [
		...canonical,
		`run_integrity=verified/${integrity.by}`,
		...documenterDeliveryLabels(run),
		`evidence_verification=${facts.verification.state}/${facts.verification.basis}`,
		`host_verification=${host?.status ?? "not_requested"}`,
		...(checks.length > 0
			? [
					`Host check evidence is separate from the worker report: ${checks
						.map((check) => {
							const source = check.memo
								? `reused a pass from run ${check.evidenceRunId ?? "unrecorded"}`
								: host?.strategy === "batch-settled"
									? "executed after the worker batch"
									: "executed after the worker";
							if (check.notRun !== undefined)
								return `${JSON.stringify(check.check)} (did not run: ${hostCheckNotRunNote(check.notRun)})`;
							return `${JSON.stringify(check.check)} (${source}; exit ${check.exitCode}${check.exitCode !== 0 ? `; ${hostCheckBaseNote(check)}` : ""})`;
						})
						.join(", ")}.`,
				]
			: []),
		...(facts.upstream.responseModelIds ? [facts.upstream.responseModelIds] : []),
		...(facts.upstream.gatewayRoutes ? [facts.upstream.gatewayRoutes] : []),
		...(facts.budget === null
			? []
			: [
					`budget_recipe_policy=${JSON.stringify(facts.budget.policy)}`,
					`budget_requested=${JSON.stringify(facts.budget.requested)}`,
					`budget_effective=${JSON.stringify(facts.budget.effective)}`,
					`budget_reason=${JSON.stringify(facts.budget.reasons)}`,
				]),
		...admissionLabels(run),
		...activityLabels(run, status),
		...skillLoadLabels(run),
		briefing,
		...(worker
			? [
					`context=${worker.mode} tokens:${worker.estimatedTokens} omitted:${worker.omittedMessages}${workerHash ? ` sha256:${workerHash}` : ""}`,
				]
			: []),
		projectContext,
	];
}

/**
 * Run labels that describe how a run was set up rather than what it delivered: the trust axes the `trust=` summary
 * already states, budget policy, briefing and context sizing, and the response model observation. A compact dispatch
 * result leaves them to the sealed record (WTF-P 0.8.3 C3).
 */
const DIAGNOSTIC_LABEL_PREFIXES = [
	"trust_status=",
	"budget_",
	"briefing=",
	"project_context=",
	"context=",
	"response_model_id_observation=",
];

export function compactEvidenceLabels(labels: ReadonlyArray<string>): string[] {
	return labels.filter((label) => !DIAGNOSTIC_LABEL_PREFIXES.some((prefix) => label.startsWith(prefix)));
}

/** Delivery guidance uses only an authenticated, terminal mutation report. */
function documenterDeliveryLabels(run: FinishedRun): string[] {
	if (
		run.facts.agentId !== "documenter" ||
		!run.facts.quality?.resultContract?.sourceId.startsWith("agent-result-contract:mutation-report:")
	)
		return [];
	const output = run.delivered?.output;
	// Read at the ceiling: the receipt already sealed conformance under the
	// run's own allowance, which this reader does not know; any conforming
	// summary is within the ceiling, and a reader that re-applied the default
	// would report a delivered 20 KB summary as absent.
	const summary =
		output?.state === "final"
			? resultContractAuthorship(
					{ kind: "mutation-report", maxSummaryBytes: RESULT_SUMMARY_MAX_BYTES_CEILING },
					output.text,
				).summary
			: null;
	return [
		`terminal Documenter result: ${summary === null ? "no inline summary is available" : "the inline deliverable or limitation is in output.text JSON field summary"}. Execution success and contract conformance alone do not prove the requested explanation was delivered.`,
		"Read the summary or the task-authorized artifact once and check it against the requested deliverable. If it is absent, incomplete, or states a limitation, report the specific limitation and the run ID; do not repeatedly read this unchanged terminal run record or poll it for new output. Keep any separately authorized recovery and its outcome distinct from the original run.",
	];
}

/**
 * The compact projection first, then the canonical axis line, both from the
 * shared projection so the dispatch and monitor text can never spell a state
 * differently from `evidence inspect` or the board.
 */
function canonicalTrustLabels(status: CanonicalTrustStatus): string[] {
	return [`trust=${JSON.stringify(formatTrustSummary(status))}`, formatTrustAxes(status)];
}

/**
 * Header for delegated worker text, keyed only on the authenticated run's
 * verification. The string is shared by dispatch and monitor so detached
 * collection cannot silently assign a different evidence meaning.
 */
export function workerTextLabel(status: CanonicalTrustStatus, run?: FinishedRun | null): string {
	const verdict = reviewVerdictLabel(status, run ?? null);
	if (verdict !== null) return verdict;
	switch (status.validationGrounding.state) {
		case "validated":
			return "worker output (tool-verified):";
		case "not_applicable":
			return "reconnaissance output (advisory leads, not validation evidence):";
		case "unknown":
			return "worker claims (validation not observable at this layer):";
		// The three remaining states were one label. The evidence bundle tells
		// a failed check, an inferred claim, and no validation at all apart, so
		// the terminal must too or it hands the operator a coarser verdict than
		// the report for the same run.
		case "failed":
			return "worker claims (validation failed; a check ran and did not pass):";
		case "ungrounded":
			return "worker claims (inferred; validation claimed, none observed):";
		default:
			return "worker claims (unverified prose):";
	}
}

/**
 * A verifier-report whose own verdict failed with no executed check behind the
 * failure is a review verdict, not a failed validation. Calling it "a check ran
 * and did not pass" beside a notice that the run executed no command read as a
 * failed run, and the orchestrator recorded nothing (WTF-P 0.8.3 A3).
 */
function reviewVerdictLabel(status: CanonicalTrustStatus, run: FinishedRun | null): string | null {
	if (run === null) return null;
	const entry = status.validationGrounding;
	if (entry.state !== "failed" || entry.authority.id !== "result-quality") return null;
	if (!run.facts.quality?.resultContract?.sourceId.startsWith("agent-result-contract:verifier-report:")) return null;
	const output = run.delivered?.output;
	const parsed = output?.state === "final" ? parseVerifierResult(output.text) : null;
	if (parsed?.verdict !== "fail") return null;
	const findings = parsed.checks.filter((check) => !check.passed).length;
	return `review verdict: fail (${findings} ${findings === 1 ? "finding" : "findings"}):`;
}

/** Contract kinds whose passing checks name commands a host can rerun; every other report's checks are judgments. */
const COMMAND_CHECK_CONTRACT_KINDS = ["mutation-report", "verifier-report"] as const;

/**
 * Whether a run's passing checks are review judgments rather than commands a
 * host could rerun: every check of a read-only run, and every check of a
 * report contract other than the command-check kinds.
 */
export function checksAreReviewJudgments(readOnly: boolean, resultContractSourceId: string | undefined): boolean {
	if (readOnly) return true;
	if (resultContractSourceId === undefined) return false;
	return !COMMAND_CHECK_CONTRACT_KINDS.some((kind) =>
		resultContractSourceId.startsWith(`agent-result-contract:${kind}:`),
	);
}

/**
 * Deterministic framing for text that must not be consumed as results. Every
 * trigger reads settled run facts or machine-written guard diagnostics,
 * never the worker's claims.
 */
export function workerTextNonEvidenceNotices(
	run: FinishedRun,
	status: CanonicalTrustStatus,
	answerText: string,
): string[] {
	const notices: string[] = [];
	const facts = run.facts;
	const failedRun = facts.exitCode !== 0 || facts.outcome !== "succeeded";
	const failureMessage = run.delivered?.failureMessage ?? facts.failureMessage ?? undefined;
	const outcomeDetail = run.delivered?.outcomeDetail ?? facts.outcomeDetail ?? undefined;
	if (mentionsWorkerToolCallCap(failureMessage) || mentionsWorkerToolCallCap(outcomeDetail)) {
		notices.push(
			answerText.length > 0
				? "non-evidence: the worker exhausted its tool-call cap; the text above is a partial synthesis, not verified results."
				: "non-evidence: the worker exhausted its tool-call cap before a final synthesis was captured.",
		);
	} else if (failedRun) {
		notices.push(
			"non-evidence: this run did not succeed; treat the text above as an unsubstantiated report, not results.",
		);
	}
	if (facts.toolActivity !== null && facts.toolActivity.succeeded === 0) {
		notices.push("non-evidence: no tool call succeeded in this run; the text above was written without observed work.");
	} else if (facts.toolActivity?.mutatingSucceeded === false && isMutationClassRun(run, status)) {
		// A live verifier run returned {"verdict":"pass"} for a check it never
		// ran, on a script that does not exist, at exit 0. The parent recovered
		// only because it independently diffed the tree; say so on the line.
		notices.push(
			"non-evidence: this run was dispatched as work that changes the tree, but no mutating tool call succeeded. Nothing was written. Confirm with a diff before repeating any claim that something was fixed.",
		);
	}
	const grounding = facts.validationGrounding;
	if (grounding !== null && grounding.ungrounded.length > 0) {
		const named = grounding.ungrounded.map((name) => JSON.stringify(name)).join(", ");
		// A read-only reviewer's checks are judgments with nothing to re-run; the
		// dispatch's next-step line already points the parent at its sealed
		// findings, so this notice must not contradict it (WTF-P session 3nm95m0q8jfb).
		const judgments = checksAreReviewJudgments(
			facts.verification.basis === "read-only-agent",
			facts.quality?.resultContract?.sourceId,
		);
		notices.push(
			judgments
				? `non-evidence: this run reported ${named} as passing review judgments and executed no command. They are its reading of the source, not checks that ran; do not report them as verified.`
				: grounding.basis === "no-command-executed"
					? `non-evidence: this run reported ${named} as passing and executed no command at all. Re-run the check yourself before repeating the claim.`
					: grounding.basis === "unattributable-status"
						? `non-evidence: this run reported ${named} as passing, but the command that ran it reported a later command's exit status, not the check's. Re-run the check yourself before repeating the claim.`
						: `non-evidence: this run reported ${named} as passing through a command the harness cannot identify as that check. Re-run it before repeating the claim.`,
		);
	}
	if (facts.capabilityMismatch !== null) {
		notices.push(
			`non-evidence: '${facts.capabilityMismatch.agentId}' is a ${facts.capabilityMismatch.capabilityClass} recipe and cannot write to the workspace, but this task classified as ${facts.capabilityMismatch.taskType}. Nothing it reports as changed can have been changed by it.`,
		);
	}
	if (
		!failedRun &&
		status.validationGrounding.state === "not_applicable" &&
		answerText.length > 0 &&
		!hasSourceCitation(answerText)
	) {
		notices.push(
			"non-evidence: this reconnaissance answer cites no file:line locations; treat its leads as unconfirmed.",
		);
	}
	return notices;
}

/** The producing process's view of a run it just settled: the same facts and result object its run.settled holds. */
export function finishedRun(result: RunResultDraft | RunResult): FinishedRun {
	const settlement = settleFinishedRun(result, {
		terminal: { terminalReason: result.terminalReason ?? "worker_failed" },
		processExitCode: result.exitCode,
		frameType: null,
		usage: undefined,
	});
	const record = "digest" in result ? readRunRecord(clioStateDir(), result.runId) : null;
	return {
		runId: result.runId,
		digest: "digest" in result ? result.digest : null,
		facts: settlement.facts,
		delivered: settlement.result,
		assessment:
			record?.seal?.status === "verified" && record.settled?.digest === ("digest" in result ? result.digest : null)
				? record.assessment
				: null,
	};
}

/** The sealed assessment owns completion evidence; the caller still owns the integrity verdict for this view. */
export function finishedRunTrustStatus(run: FinishedRun, integrity: RunIntegrity): CanonicalTrustStatus {
	const status = adaptRunTrustStatus({ ...run.facts, runId: run.runId, digest: run.digest }, integrity);
	return authenticated(integrity) && run.assessment !== null
		? composeTrustStatus(normalizeTrustStatus(run.assessment.trust), { artifactIntegrity: status.artifactIntegrity })
		: status;
}

/** A run its producer holds in memory is authentic by construction; nothing about it was read back. */
export const PRODUCER_INTEGRITY: RunIntegrity = { state: "verified", by: "producer" };

/** Where the run's result object lives in its run scope: a worker given the path reads the full captured answer. */
export function runResultPath(result: RunResultDraft): string {
	const ref = telemetryObjectRef("run-result", finishedRun(result).delivered);
	return join(telemetryObjectsDirectory(telemetryRunDirectory(clioStateDir(), result.runId)), `${ref.id}.json`);
}
