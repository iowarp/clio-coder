/**
 * A finished run's assessment (#434): its trust status, findings, gate verdicts and provenance, judged once by the
 * run's journal owner after run.settled and journaled as `evidence.assessed` before the seal, so the sealed run scope
 * is the run's evidence. {@link assessRun} is pure over the run's journal records; {@link gatherRunAssessment} reads
 * what it needs beside them.
 */

import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import type { EvidenceAssessed, EvidenceFindingsObject, RunSettled } from "../../core/telemetry/schemas.js";
import type { RunPersonaOverride, RunPipelineProvenance } from "../dispatch/types.js";
import type { DecisionRecord } from "../session/entries.js";
import { runSettledDigest } from "../telemetry/run-digest.js";
import { attributeEvidenceFailure } from "./failure-attribution.js";
import { compareGates, type GateReview, readGateReviews, reviewFinding } from "./run-trust.js";
import { trustVerdict } from "./trust-projection.js";
import {
	adaptCompletionEvidence,
	adaptGateDecisionReviewStatus,
	adaptRunTrustStatus,
	type CanonicalTrustStatus,
	composeTrustStatus,
} from "./trust-status.js";
import type { EvidenceSeverity, EvidenceTag } from "./types.js";

/** What dispatch knew of the run when it settled it; recovery that seals an orphaned run has none of it. */
export interface RunAssessmentContext {
	sessionId: string | null;
	/** The workspace the run was dispatched from: its project identity for readers after its ledger row is gone. */
	cwd: string;
	/** The dispatch lineage attempt; null for a run dispatched without a lineage. */
	attempt: number | null;
	decisionRefs: ReadonlyArray<string>;
	pipeline: RunPipelineProvenance | null;
	personaOverride: RunPersonaOverride | null;
	/**
	 * The finish contract decision the run's session recorded for it, for a run whose own journal holds none: a
	 * headless main run's turn records it in its session, which settles before the run scope opens (C-11).
	 */
	completion?: Pick<TelemetryRecord<"completion.evaluated">, "id" | "t" | "data">;
	/**
	 * A change the run's host observed that its settled facts do not carry: a headless main run's successful mutating
	 * call or merged dispatch worktree (C-37).
	 */
	observedChange?: boolean;
}

export interface AssessRunInput {
	records: ReadonlyArray<TelemetryRecord>;
	context: RunAssessmentContext | null;
	/** Gate decisions naming the run, from sealed coordinator and session journals (`readGateReviews`). */
	gateDecisions: ReadonlyArray<GateReview>;
	/** The decision records on the run's session's active path, by ref; null when the session was not read. */
	decisions: ReadonlyMap<string, DecisionRecord> | null;
}

export interface RunAssessment {
	data: Omit<EvidenceAssessed, "text">;
	text: EvidenceFindingsObject;
}

interface Finding {
	severity: EvidenceSeverity;
	tag: EvidenceTag;
	message: string;
}

/** The run's assessment from its journal records; null when the journal holds no run.settled to assess. */
export function assessRun(runId: string, input: AssessRunInput): RunAssessment | null {
	let settled: RunSettled | null = null;
	let settledAt = "";
	for (const record of input.records) {
		if (record.k === "run.settled" && record.t >= settledAt) {
			settled = record.data;
			settledAt = record.t;
		}
	}
	if (settled === null) return null;
	const digest = runSettledDigest(settled);
	// The producer holds the record it is about to seal; a reader replaces this integrity with the seal's verdict.
	let trust = adaptRunTrustStatus({ ...settled, runId, digest }, { state: "verified", by: "producer" });
	const completion =
		input.records
			.flatMap((record) =>
				record.k === "completion.evaluated" && record.ctx.runId === runId && record.t <= settledAt ? [record] : [],
			)
			.sort((left, right) => left.t.localeCompare(right.t))
			.at(-1) ?? input.context?.completion;
	if (completion !== undefined)
		trust = composeTrustStatus(trust, { completionEvidence: adaptCompletionEvidence(completion) });
	const verdicts: EvidenceAssessed["verdicts"] = [];
	for (const gate of [...input.gateDecisions].sort(compareGates)) {
		const subject = gate.subjects.find((entry) => entry.runId === runId);
		if (subject === undefined) continue;
		// A gate subject cites the run by the digest of its run.settled (#434).
		const verification =
			subject.digest === digest
				? ({ ok: true } as const)
				: ({ ok: false, reason: "gate subject run digest mismatched" } as const);
		const review = adaptGateDecisionReviewStatus(gate, runId, verification);
		verdicts.push({ decisionId: gate.decisionId, digest: gate.digest, outcome: gate.outcome, review: review.state });
		// The latest decision is the run's review; earlier cycles stay listed as verdicts.
		trust = composeTrustStatus(trust, { independentReview: review });
	}
	const findings = runFindings(settled, trust);
	const context = input.context;
	const decisions: EvidenceFindingsObject["decisions"] = [];
	const decisionRefs: Array<{ ref: string; resolved: boolean }> = [];
	for (const ref of [...new Set(context?.decisionRefs ?? [])]) {
		const record = input.decisions?.get(ref);
		const sessionId = context?.sessionId ?? null;
		decisionRefs.push({ ref, resolved: record !== undefined && sessionId !== null });
		if (record !== undefined && sessionId !== null) decisions.push({ ref, sessionId, record: { ...record } });
		findings.push({
			severity: record ? "info" : "warn",
			tag: "context-provenance",
			message: `Decision ref ${ref} ${record ? "resolved" : "does not resolve"} on session ${sessionId ?? "(unlinked)"} active path`,
		});
	}
	const ids = findings.map((_, index) => `finding-${String(index + 1).padStart(3, "0")}`);
	const failureCause =
		settled.exitCode !== null && settled.exitCode !== 0
			? attributeEvidenceFailure({
					outcome: settled.outcome,
					outcomeCode: settled.outcomeCode,
					outcomeDetail: settled.outcomeDetail,
					failureMessage: settled.failureMessage,
				})
			: null;
	const attempt = context?.attempt ?? null;
	return {
		data: {
			version: 1,
			attempt,
			// The verdict every run surface reads its caveat from: a run whose validation failed reads failed on the
			// dock and the card, so it is not a first-pass success here either (bt-48-9).
			firstPassSuccess:
				settled.outcome === "succeeded" &&
				attempt === 0 &&
				settled.stepPipeline?.done !== false &&
				trustVerdict(trust) !== "compromised" &&
				!(findings.some((entry) => entry.tag === "no-validation") && validationOwed(settled, completion, context)),
			failureCause,
			// Plain data for the journal: the canonical status hands out readonly artifact lists.
			trust: JSON.parse(JSON.stringify(trust)) as EvidenceAssessed["trust"],
			findings: findings.map((entry, index) => ({ id: ids[index] ?? "", severity: entry.severity, tag: entry.tag })),
			verdicts,
			provenance:
				context === null ? null : { decisionRefs, pipeline: context.pipeline, personaOverride: context.personaOverride },
		},
		text: {
			version: 1,
			findings: findings.map((entry, index) => ({ id: ids[index] ?? "", message: entry.message })),
			decisions,
			cwd: context?.cwd ?? null,
		},
	};
}

/**
 * Whether a run without validation evidence fails first-pass success for it (C-37): one that declared checks, or one
 * that any signal shows changed state: its finish contract's mutated paths, a successful mutating call, a command the
 * check classifier could not read, an applied worktree or one its host observed. A finish record that counted no paths
 * outweighs none of them, since it cannot see a script's or a merged worktree's writes. Without any signal, a
 * read-only recipe's run or a run with a finish record changed nothing to validate; a run with no evidence still owes it.
 */
function validationOwed(
	settled: RunSettled,
	completion: Pick<TelemetryRecord<"completion.evaluated">, "data"> | undefined,
	context: RunAssessmentContext | null,
): boolean {
	if (settled.hostVerification !== null || (settled.quality?.resultContract ?? null) !== null) return true;
	const changed =
		(completion?.data.mutatedPaths ?? 0) > 0 ||
		settled.toolActivity?.mutatingSucceeded === true ||
		settled.unclassifiedAfterLastCheck !== undefined ||
		settled.worktree?.applied === true ||
		context?.observedChange === true;
	if (changed) return true;
	if (completion !== undefined || settled.verification.basis === "read-only-agent") return false;
	return (settled.toolActivity ?? null) === null;
}

function runFindings(settled: RunSettled, trust: CanonicalTrustStatus): Finding[] {
	const out: Finding[] = [];
	const add = (severity: EvidenceSeverity, tag: EvidenceTag, message: string) => out.push({ severity, tag, message });
	const succeeded = settled.outcome === "succeeded";
	const validation = trust.validationGrounding.state;
	if (succeeded && (validation === "absent" || validation === "unknown"))
		add("warn", "no-validation", "run completed without linked validation evidence");
	if (validation === "ungrounded")
		add("warn", "proxy-validation", "run claimed validation that was not grounded in an observed execution");
	const blocked = settled.tools.reduce((total, stat) => total + stat.blocked, 0);
	if (blocked > 0) add("warn", "blocked-tool", `${blocked} blocked tool call(s)`);
	// An escalation that timed out or was denied is an unresolved permission ask; approved ones resolved cleanly.
	const escalation = settled.escalations;
	if (escalation !== null && (escalation.timedOut > 0 || escalation.denied > 0))
		add("warn", "escalation", `escalations unresolved: ${escalation.timedOut} timed out, ${escalation.denied} denied`);
	if (settled.toolGovernance === "agent-managed")
		add(
			"warn",
			"external-bypass",
			"run used external peer permissions outside CLIO Coder policy; CLIO Coder safety blocks were not enforced",
		);
	const review = reviewFinding(trust.independentReview.state);
	if (review !== null) out.push(review);
	if (trust.contextProvenance.state === "invalid")
		add("warn", "context-provenance", "context provenance record is contradictory");
	const completion = trust.completionEvidence.state;
	if (completion === "incomplete")
		add(
			"warn",
			"completion-evidence",
			"run mutated the workspace and finished without validation evidence at the completion boundary",
		);
	else if (completion === "limited")
		add("info", "completion-evidence", "run finished with an explicit limitation instead of validation evidence");
	// Each turn of a stalled step pipeline ends normally, so the run settles succeeded with the pipeline unfinished (bt-20).
	const pipeline = settled.stepPipeline;
	if (pipeline !== undefined && !pipeline.done)
		add(
			"warn",
			"completion-evidence",
			pipeline.stoppedBy === "unreported"
				? `step pipeline ended without ${pipeline.stepTool} reporting pipelineDone; whether every step ran is not known`
				: `step pipeline stopped ${pipeline.stoppedBy === "cap" ? "at the continuation cap" : pipeline.stoppedBy === "cancel" ? "on a cancel" : pipeline.stoppedBy === "failure" ? "on a failed turn" : "with its last turn"} before ${pipeline.stepTool} reported pipelineDone`,
		);
	if (settled.exitCode !== null && settled.exitCode !== 0)
		add(
			"warn",
			attributeEvidenceFailure({
				outcome: settled.outcome,
				outcomeCode: settled.outcomeCode,
				outcomeDetail: settled.outcomeDetail,
				failureMessage: settled.failureMessage,
			}),
			`run exited with code ${settled.exitCode}`,
		);
	return out;
}

/**
 * Read what an assessment needs beside the run's journal: the gate decisions its sealed coordinator and session
 * journals hold about the run and, when the run cited decisions, its session's decision board. A read that fails
 * leaves its part unresolved rather than failing the run.
 */
export async function gatherRunAssessment(
	stateDir: string,
	runId: string,
	records: ReadonlyArray<TelemetryRecord>,
	context: RunAssessmentContext | null,
): Promise<RunAssessment | null> {
	let gateDecisions: GateReview[] = [];
	try {
		gateDecisions = readGateReviews(stateDir, runId, records);
	} catch {
		// Unreadable gate decisions leave the review axis as the run record states it.
	}
	let decisions: Map<string, DecisionRecord> | null = null;
	const sessionId = context?.sessionId ?? null;
	if (sessionId !== null && (context?.decisionRefs.length ?? 0) > 0) {
		try {
			decisions = await activeDecisions(stateDir, sessionId);
		} catch {
			// An unreadable session resolves no decision; each ref reads as unresolved.
		}
	}
	return assessRun(runId, { records, context, gateDecisions, decisions });
}

async function activeDecisions(stateDir: string, sessionId: string): Promise<Map<string, DecisionRecord>> {
	const { readSessionEntriesForId } = await import("../session/index.js");
	const { foldDecisionBoard } = await import("../session/decision-board.js");
	const { filterEntriesToActivePath } = await import("../session/tree/active-path.js");
	const { decisionRef } = await import("../session/entries.js");
	const read = await readSessionEntriesForId(stateDir, sessionId);
	const records = new Map<string, DecisionRecord>();
	if (read.missing) return records;
	for (const entry of foldDecisionBoard(filterEntriesToActivePath(read.entries, read.leafTurnId)))
		for (const record of entry.decisions)
			records.set(decisionRef(entry.interviewId, record.key), {
				...record,
				source: record.source ?? (entry.origin === "agent" ? "agent" : "operator"),
			});
	return records;
}
