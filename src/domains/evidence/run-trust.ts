/**
 * A finished run's trust as every projection reads it (#434): the run DTO's seal verdict, the assessment its producer
 * sealed into the run scope, and the review gates decided about the run after it sealed. The sealed assessment stays
 * as journaled; a later gate decision composes over it only when its artifact verifies and it cites the run by the
 * digest of the run.settled the seal covers. `runEvidence` and the dispatch domain's `runEvidenceOf` both read this,
 * so the two projections of one run cannot disagree on its trust.
 */

import type { RunTelemetryV1 } from "../../core/telemetry/dto.js";
import {
	type GateDecisionArtifact,
	gateDecisionsDirectory,
	readGateDecisionArtifacts,
	verifyGateDecisionArtifact,
} from "../dispatch/gate-decisions.js";
import { containedInStateRoot } from "../telemetry/run-record.js";
import { compareCodepoints } from "./ordering.js";
import {
	adaptGateDecisionReviewStatus,
	type CanonicalTrustStatus,
	composeTrustStatus,
	inspectRunTrustStatus,
	normalizeTrustStatus,
	type RunIntegrity,
} from "./trust-status.js";
import type { EvidenceSeverity, EvidenceTag, EvidenceVerdict } from "./types.js";

export type SealedRunAssessment = NonNullable<RunTelemetryV1["assessment"]>;

export interface RunTrustFinding {
	id: string;
	severity: EvidenceSeverity;
	tag: EvidenceTag;
	/** The finding's prose from the scope's findings object; null when the scope does not hold it. */
	message: string | null;
}

export interface RunTrustRead {
	integrity: RunIntegrity;
	trust: CanonicalTrustStatus;
	/** The sealed assessment; null unless the seal verifies and the run was assessed before it sealed. */
	assessment: SealedRunAssessment | null;
	verdicts: EvidenceVerdict[];
	findings: RunTrustFinding[];
}

/** Gates in decision order: the latest one is the run's review, earlier cycles stay listed as verdicts. */
export function compareGates(left: GateDecisionArtifact, right: GateDecisionArtifact): number {
	return (
		compareCodepoints(left.createdAt, right.createdAt) || left.cycle - right.cycle || compareCodepoints(left.id, right.id)
	);
}

/** The finding the independent-review axis yields, worded once for the assessment and its later recomposition. */
export function reviewFinding(
	review: CanonicalTrustStatus["independentReview"]["state"],
	succeeded: boolean,
): { severity: EvidenceSeverity; tag: EvidenceTag; message: string } | null {
	if (review === "failed")
		return { severity: "warn", tag: "independent-review", message: "independent review failed for this run" };
	if (review === "not_independent")
		return {
			severity: "warn",
			tag: "independent-review",
			message: "review was not independent of the run it judged",
		};
	if (review === "inconclusive")
		return { severity: "info", tag: "independent-review", message: "independent review was inconclusive" };
	if (succeeded && (review === "absent" || review === "unknown"))
		return {
			severity: "info",
			tag: "independent-review",
			message: "run was not independently reviewed; its result rests on its own record",
		};
	return null;
}

/**
 * The run's trust from its DTO and the gate decisions naming it. `gates` may hold any decisions; only those the seal's
 * assessment did not already judge, whose artifact verifies and whose subject digest is the sealed run.settled's,
 * compose over it.
 */
export function readRunTrust(
	record: RunTelemetryV1 | null,
	gates: ReadonlyArray<GateDecisionArtifact> = [],
): RunTrustRead {
	const inspection = inspectRunTrustStatus(record);
	const verified = inspection.integrity.state === "verified";
	const assessment = verified ? (record?.assessment ?? null) : null;
	// The seal now vouches for the record the producer assessed, so its verdict replaces the producer's.
	let trust =
		assessment === null
			? inspection.status
			: composeTrustStatus(normalizeTrustStatus(assessment.trust), {
					artifactIntegrity: inspection.status.artifactIntegrity,
				});
	const content = assessment?.content?.state === "resolved" ? assessment.content.value : null;
	const messages = new Map((content?.findings ?? []).map((entry) => [entry.id, entry.message]));
	let findings: RunTrustFinding[] = (assessment?.findings ?? []).map((entry) => ({
		id: entry.id,
		severity: entry.severity,
		tag: entry.tag,
		message: messages.get(entry.id) ?? null,
	}));
	const verdicts: EvidenceVerdict[] = (assessment?.verdicts ?? []).map((verdict) => ({ ...verdict }));
	const settled = verified && record !== null ? record.settled : null;
	if (settled === null || record === null)
		return { integrity: inspection.integrity, trust, assessment, verdicts, findings };
	const runId = record.row.runId;
	const judged = new Set(verdicts.map((verdict) => verdict.decisionId));
	let reviewed = false;
	for (const gate of [...gates].sort(compareGates)) {
		if (judged.has(gate.id)) continue;
		// A gate cites the run by the digest of its run.settled; a decision about another settlement is not this run's.
		if (gate.subjects.find((subject) => subject.runId === runId)?.digest !== settled.digest) continue;
		if (!verifyGateDecisionArtifact(gate).ok) continue;
		const review = adaptGateDecisionReviewStatus(gate, runId, { ok: true });
		verdicts.push({ decisionId: gate.id, digest: gate.integrity.digest, outcome: gate.outcome, review: review.state });
		trust = composeTrustStatus(trust, { independentReview: review });
		reviewed = true;
	}
	if (reviewed && assessment !== null) {
		// The sealed finding spoke for the review as it stood at the seal; the later decision replaces it.
		const prior = findings.find((entry) => entry.tag === "independent-review");
		findings = findings.filter((entry) => entry.tag !== "independent-review");
		const finding = reviewFinding(trust.independentReview.state, settled.outcome === "succeeded");
		if (finding !== null)
			findings.push({
				id: prior?.id ?? `finding-${String(assessment.findings.length + 1).padStart(3, "0")}`,
				...finding,
			});
	}
	return { integrity: inspection.integrity, trust, assessment, verdicts, findings };
}

/**
 * The verified gate decisions on this host, by the runs they judge, read once so a listing does not rescan the store
 * per run. An unreadable decision store judges nothing; the sealed assessment still states the review as it stood at
 * the seal.
 */
export function readRunGateIndex(stateDir: string): (runId: string) => GateDecisionArtifact[] {
	const byRun = new Map<string, GateDecisionArtifact[]>();
	let gates: GateDecisionArtifact[] = [];
	try {
		// A decision store that resolves outside the state root judges none of this host's runs.
		if (containedInStateRoot(stateDir, gateDecisionsDirectory(stateDir)))
			gates = readGateDecisionArtifacts(undefined, stateDir).map((entry) => entry.artifact);
	} catch {
		// An unreadable store composes no later review over any run.
	}
	for (const gate of gates)
		for (const runId of new Set(gate.subjects.map((subject) => subject.runId)))
			byRun.set(runId, [...(byRun.get(runId) ?? []), gate]);
	return (runId) => byRun.get(runId) ?? [];
}
