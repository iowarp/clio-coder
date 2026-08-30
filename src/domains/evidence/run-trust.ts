import { type GateDecisionArtifact, verifyGateDecisionArtifact } from "../dispatch/gate-decisions.js";
import type { RunEnvelope, RunReceipt } from "../dispatch/types.js";
import { compareCodepoints as compareStrings } from "./ordering.js";
import {
	adaptGateDecisionReviewStatus,
	adaptGroundedEvidenceValidationStatus,
	type CanonicalTrustStatus,
	composeTrustStatus,
	inspectRunReceiptTrustStatus,
	isTrustStatusIdentifier,
	type TrustArtifactReference,
} from "./trust-status.js";
import { EVIDENCE_VERSION, type EvidenceTrustStatusFile } from "./types.js";

export interface EvidenceRunTrustSource {
	envelope: RunEnvelope;
	receipt: RunReceipt | null;
}

export interface BuildEvidenceTrustStatusInput {
	evidenceId: string;
	runSources: ReadonlyArray<EvidenceRunTrustSource>;
	gateDecisions: ReadonlyArray<GateDecisionArtifact>;
	validationEvidence?: ReadonlyMap<string, ReadonlyArray<TrustArtifactReference>>;
}

/**
 * Compose every evidence-linked trust axis at one pure boundary. Both the
 * run/session and eval builders call this function, so the same authenticated
 * receipt and gate decision cannot project differently merely because the
 * receipt was bundled through a different entry point. Completion evidence
 * stays receipt-derived so an audit row cannot change one surface alone.
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
				validationEvidence: input.validationEvidence?.get(source.envelope.id) ?? [],
			}),
		})),
	};
}

interface ComposeEvidenceRunTrustInput {
	evidenceId: string;
	source: EvidenceRunTrustSource;
	gateDecisions: ReadonlyArray<GateDecisionArtifact>;
	validationEvidence: ReadonlyArray<TrustArtifactReference>;
}

function composeEvidenceRunTrustStatus(input: ComposeEvidenceRunTrustInput): CanonicalTrustStatus {
	const inspection = inspectRunReceiptTrustStatus(input.source.receipt, input.source.envelope);
	let status = inspection.status;
	// Only independently observed executions ground validation. A completion
	// contract audit row is the run's own self-report and cannot override the
	// receipt-derived completion axis on this surface alone.
	const grounded = input.validationEvidence.filter((artifact) => isTrustStatusIdentifier(artifact.id));
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
	return status;
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
