/**
 * A finished run's assessment (#434): its trust status, findings, gate verdicts and provenance, judged once by the
 * run's journal owner after run.settled and journaled as `evidence.assessed` before the seal, so the sealed run scope
 * is the run's evidence. {@link assessRun} is pure over the run's journal records; {@link gatherRunAssessment} reads
 * what it needs beside them.
 */

import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import type { EvidenceAssessed, EvidenceFindingsObject, RunSettled } from "../../core/telemetry/schemas.js";
import { type GateDecisionArtifact, verifyGateDecisionArtifact } from "../dispatch/gate-decisions.js";
import type { RunPersonaOverride, RunPipelineProvenance } from "../dispatch/types.js";
import type { DecisionRecord } from "../session/entries.js";
import { runSettledDigest } from "../telemetry/run-digest.js";
import { attributeEvidenceFailure } from "./failure-attribution.js";
import { compareCodepoints } from "./ordering.js";
import {
	adaptGateDecisionReviewStatus,
	adaptRunTrustStatus,
	type CanonicalTrustStatus,
	composeTrustStatus,
} from "./trust-status.js";
import type { EvidenceSeverity, EvidenceTag } from "./types.js";

/** What dispatch knew of the run when it settled it; recovery that seals an orphaned run has none of it. */
export interface RunAssessmentContext {
	sessionId: string | null;
	/** The dispatch lineage attempt; null for a run dispatched without a lineage. */
	attempt: number | null;
	decisionRefs: ReadonlyArray<string>;
	pipeline: RunPipelineProvenance | null;
	personaOverride: RunPersonaOverride | null;
}

export interface AssessRunInput {
	records: ReadonlyArray<TelemetryRecord>;
	context: RunAssessmentContext | null;
	/** Gate decisions naming the run, as their own integrity admits them. */
	gateDecisions: ReadonlyArray<GateDecisionArtifact>;
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
	const verdicts: EvidenceAssessed["verdicts"] = [];
	for (const gate of [...input.gateDecisions].sort(compareGates)) {
		if (!gate.subjects.some((subject) => subject.runId === runId)) continue;
		const artifact = verifyGateDecisionArtifact(gate);
		const subject = gate.subjects.find((entry) => entry.runId === runId);
		// A gate subject cites the run by the digest of its run.settled (#434).
		const verification =
			artifact.ok && subject?.digest === digest
				? ({ ok: true } as const)
				: ({ ok: false, reason: artifact.ok ? "gate subject run digest mismatched" : artifact.reason } as const);
		const review = adaptGateDecisionReviewStatus(gate, runId, verification);
		verdicts.push({ decisionId: gate.id, digest: gate.integrity.digest, outcome: gate.outcome, review: review.state });
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
			firstPassSuccess:
				settled.outcome === "succeeded" && attempt === 0 && !findings.some((entry) => entry.tag === "no-validation"),
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
		},
	};
}

function compareGates(left: GateDecisionArtifact, right: GateDecisionArtifact): number {
	return (
		compareCodepoints(left.createdAt, right.createdAt) || left.cycle - right.cycle || compareCodepoints(left.id, right.id)
	);
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
			"run used external peer permissions outside Clio policy; Clio safety blocks were not enforced",
		);
	const review = trust.independentReview.state;
	if (review === "failed") add("warn", "independent-review", "independent review failed for this run");
	else if (review === "not_independent")
		add("warn", "independent-review", "review was not independent of the run it judged");
	else if (review === "inconclusive") add("info", "independent-review", "independent review was inconclusive");
	else if (succeeded && (review === "absent" || review === "unknown"))
		add("info", "independent-review", "run was not independently reviewed; its result rests on its own record");
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
 * Read what an assessment needs beside the run's journal: the gate decisions naming the run and, when the run cited
 * decisions, its session's decision board. A read that fails leaves its part unresolved rather than failing the run.
 */
export async function gatherRunAssessment(
	stateDir: string,
	runId: string,
	records: ReadonlyArray<TelemetryRecord>,
	context: RunAssessmentContext | null,
): Promise<RunAssessment | null> {
	const { readGateDecisionArtifactsForRunIds } = await import("../dispatch/gate-decisions.js");
	let gateDecisions: GateDecisionArtifact[] = [];
	try {
		gateDecisions = readGateDecisionArtifactsForRunIds(new Set([runId]), stateDir).map((entry) => entry.artifact);
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
