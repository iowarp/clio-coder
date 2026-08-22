import { type GateDecisionArtifact, verifyGateDecisionArtifact } from "../dispatch/gate-decisions.js";
import type { RunEnvelope, RunReceipt } from "../dispatch/types.js";
import type { FinishContractAssessment, FinishContractEvidenceKind } from "../safety/finish-contract.js";
import {
	adaptFinishContractCompletionStatus,
	adaptGateDecisionReviewStatus,
	adaptGroundedEvidenceValidationStatus,
	type CanonicalTrustStatus,
	composeTrustStatus,
	inspectRunReceiptTrustStatus,
	type TrustArtifactReference,
} from "./trust-status.js";
import { EVIDENCE_VERSION, type EvidenceAuditLinkedRow, type EvidenceTrustStatusFile } from "./types.js";

export interface EvidenceRunTrustSource {
	envelope: RunEnvelope;
	receipt: RunReceipt | null;
}

export interface BuildEvidenceTrustStatusInput {
	evidenceId: string;
	runSources: ReadonlyArray<EvidenceRunTrustSource>;
	gateDecisions: ReadonlyArray<GateDecisionArtifact>;
	auditRows: ReadonlyArray<EvidenceAuditLinkedRow>;
	validationEvidence?: ReadonlyMap<string, ReadonlyArray<TrustArtifactReference>>;
}

/**
 * Compose every evidence-linked trust axis at one pure boundary. Both the
 * run/session and eval builders call this function, so the same authenticated
 * receipt, gate decision, and exact finish-contract row cannot project
 * differently merely because it was bundled through a different entry point.
 */
export function buildEvidenceTrustStatusFile(input: BuildEvidenceTrustStatusInput): EvidenceTrustStatusFile {
	return {
		version: EVIDENCE_VERSION,
		evidenceId: input.evidenceId,
		projection: "canonical",
		runs: input.runSources.map((source) => ({
			runId: source.envelope.id,
			status: composeEvidenceRunTrustStatus({
				evidenceId: input.evidenceId,
				source,
				gateDecisions: input.gateDecisions,
				auditRows: input.auditRows,
				validationEvidence: input.validationEvidence?.get(source.envelope.id) ?? [],
			}),
		})),
	};
}

interface ComposeEvidenceRunTrustInput {
	evidenceId: string;
	source: EvidenceRunTrustSource;
	gateDecisions: ReadonlyArray<GateDecisionArtifact>;
	auditRows: ReadonlyArray<EvidenceAuditLinkedRow>;
	validationEvidence: ReadonlyArray<TrustArtifactReference>;
}

function composeEvidenceRunTrustStatus(input: ComposeEvidenceRunTrustInput): CanonicalTrustStatus {
	const inspection = inspectRunReceiptTrustStatus(input.source.receipt, input.source.envelope);
	let status = inspection.status;
	const grounded = [
		...input.validationEvidence,
		...groundedValidationEvidenceFromAudit(input.auditRows, input.source.envelope.id),
	];
	if (
		grounded.length > 0 &&
		(status.validationGrounding.state === "absent" || status.validationGrounding.state === "unknown")
	) {
		status = composeTrustStatus(status, {
			validationGrounding: adaptGroundedEvidenceValidationStatus({
				evidenceId: input.evidenceId,
				runId: input.source.envelope.id,
				artifacts: grounded,
			}),
		});
	}

	const gate = latestGateDecisionForRun(input.gateDecisions, input.source.envelope.id);
	if (gate !== null) {
		const artifactVerification = verifyGateDecisionArtifact(gate);
		const subject = gate.subjects.find((entry) => entry.runId === input.source.envelope.id);
		const receipt = inspection.integrity.ok ? input.source.receipt : null;
		const verification =
			artifactVerification.ok &&
			subject !== undefined &&
			receipt?.integrity !== undefined &&
			subject.digest === receipt.integrity.digest
				? ({ ok: true } as const)
				: ({
						ok: false,
						reason: artifactVerification.ok
							? "gate subject receipt digest unavailable or mismatched"
							: artifactVerification.reason,
					} as const);
		status = composeTrustStatus(status, {
			independentReview: adaptGateDecisionReviewStatus(gate, input.source.envelope.id, verification),
		});
	}

	const finish = latestFinishContractForRun(input.auditRows, input.source.envelope.id);
	if (finish !== null) {
		status = composeTrustStatus(status, {
			completionEvidence: adaptFinishContractCompletionStatus(finish.assessment, {
				sourceId: finish.sourceId,
				artifacts: finish.artifacts,
			}),
		});
	}
	return status;
}

function groundedValidationEvidenceFromAudit(
	rows: ReadonlyArray<EvidenceAuditLinkedRow>,
	runId: string,
): TrustArtifactReference[] {
	return rows.flatMap((linked) => {
		if (
			linked.auditKind !== "completion_contract" ||
			linked.runId !== runId ||
			linked.confidence !== "exact" ||
			readOptionalString(linked.row.decision) !== "ok" ||
			readOptionalString(linked.row.reason) !== "validation_evidence"
		) {
			return [];
		}
		const evidenceKinds = Array.isArray(linked.row.evidenceKinds)
			? linked.row.evidenceKinds.filter(isFinishContractEvidenceKind)
			: [];
		if (evidenceKinds.length === 0) return [];
		const turnId = readOptionalString(linked.row.turnId);
		return [
			turnId === null
				? {
						kind: "finish_contract_evidence" as const,
						id: readOptionalString(linked.row.correlationId) ?? `${runId}:completion-contract`,
					}
				: { kind: "session_entry" as const, id: turnId },
		];
	});
}

function latestGateDecisionForRun(
	decisions: ReadonlyArray<GateDecisionArtifact>,
	runId: string,
): GateDecisionArtifact | null {
	return (
		decisions
			.filter((decision) => decision.subjects.some((subject) => subject.runId === runId))
			.sort(
				(left, right) =>
					compareStrings(left.createdAt, right.createdAt) || left.cycle - right.cycle || compareStrings(left.id, right.id),
			)
			.at(-1) ?? null
	);
}

interface EvidenceFinishContractProjection {
	sourceId: string;
	assessment: FinishContractAssessment;
	artifacts: TrustArtifactReference[];
}

function latestFinishContractForRun(
	rows: ReadonlyArray<EvidenceAuditLinkedRow>,
	runId: string,
): EvidenceFinishContractProjection | null {
	const candidates = rows
		.filter((row) => row.auditKind === "completion_contract" && row.runId === runId && row.confidence === "exact")
		.flatMap((row) => {
			const assessment = finishContractAssessmentFromAudit(row.row);
			if (assessment === null) return [];
			const correlationId = readOptionalString(row.row.correlationId) ?? `${runId}:completion-contract`;
			const turnId = readOptionalString(row.row.turnId);
			const artifacts: TrustArtifactReference[] = [
				{ kind: "finish_contract_evidence", id: correlationId },
				...(turnId === null ? [] : [{ kind: "session_entry" as const, id: turnId }]),
			];
			return [{ sourceId: correlationId, assessment, artifacts, timestamp: row.ts ?? "" }];
		})
		.sort(
			(left, right) => compareStrings(left.timestamp, right.timestamp) || compareStrings(left.sourceId, right.sourceId),
		);
	const latest = candidates.at(-1);
	return latest === undefined
		? null
		: { sourceId: latest.sourceId, assessment: latest.assessment, artifacts: latest.artifacts };
}

function finishContractAssessmentFromAudit(row: Record<string, unknown>): FinishContractAssessment | null {
	const reason = readOptionalString(row.reason);
	const decision = readOptionalString(row.decision);
	const mutatedPaths = Array.isArray(row.mutatedPaths)
		? row.mutatedPaths.filter((entry): entry is string => typeof entry === "string")
		: [];
	const turnId = readOptionalString(row.turnId);
	const evidenceKinds = Array.isArray(row.evidenceKinds) ? row.evidenceKinds.filter(isFinishContractEvidenceKind) : [];
	const evidence = evidenceKinds.map((kind) => ({
		kind,
		summary: "recorded by the finish contract",
		...(turnId === null ? {} : { turnId }),
	}));
	if (decision === "ok" && reason === "no_mutation") {
		return { kind: "ok", reason, evidence: [], mutatedPaths };
	}
	if (decision === "ok" && reason === "validation_evidence") {
		return { kind: "ok", reason, evidence, mutatedPaths };
	}
	if (decision === "ok" && reason === "explicit_limitation") {
		return { kind: "ok", reason, evidence: [], mutatedPaths };
	}
	if (decision === "engage" && reason === "unvalidated_mutation") {
		return { kind: "engage", reason, message: "finish contract engaged", evidence: [], mutatedPaths };
	}
	return null;
}

function isFinishContractEvidenceKind(value: unknown): value is FinishContractEvidenceKind {
	return value === "validation_command" || value === "protected_artifact" || value === "dispatch_receipt";
}

function readOptionalString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function compareStrings(left: string, right: string): number {
	return left.localeCompare(right);
}
