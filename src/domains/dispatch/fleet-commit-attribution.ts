import type { CommitAttributionEvidence } from "../../core/commit-attribution.js";
import type { ExecutionPlan, ExecutionPlanCodeStep } from "./execution-plan.js";
import { RUN_RECEIPT_INTEGRITY_ALGORITHM, RUN_RECEIPT_INTEGRITY_VERSION } from "./receipt-integrity.js";

export interface FleetCommitPriorResult {
	succeeded: boolean;
	integrityValid: boolean;
	receiptDigest: string;
	/** Decision refs from the step's sealed receipt; they become `Clio-Decision:` trailers. */
	decisionRefs?: ReadonlyArray<string>;
}

/**
 * Derive one fleet commit's semantic attribution from scheduler-owned facts.
 * Agent output text is deliberately absent from this input: prose cannot turn
 * into testing or review evidence.
 */
export function deriveFleetCommitAttribution(input: {
	plan: ExecutionPlan;
	step: ExecutionPlanCodeStep;
	priorResults: ReadonlyMap<string, FleetCommitPriorResult>;
	validationFresh: boolean;
	independentReviewFresh: boolean;
}): CommitAttributionEvidence {
	const byId = new Map(input.plan.steps.map((step) => [step.id, step] as const));
	let materiallyAuthored = false;
	let receipt: CommitAttributionEvidence["receipt"];
	let decisions: CommitAttributionEvidence["decisions"];
	for (const candidate of input.step.commitFrom ?? []) {
		const source = byId.get(candidate);
		const result = input.priorResults.get(candidate);
		if (
			source?.kind !== "agent" ||
			source.scope !== "workspace" ||
			result?.succeeded !== true ||
			result.integrityValid !== true
		) {
			continue;
		}
		materiallyAuthored = true;
		if (result.decisionRefs !== undefined && result.decisionRefs.length > 0) decisions = [...result.decisionRefs];
		if (/^[0-9a-f]{64}$/u.test(result.receiptDigest)) {
			receipt = {
				version: RUN_RECEIPT_INTEGRITY_VERSION,
				algorithm: RUN_RECEIPT_INTEGRITY_ALGORITHM,
				digest: result.receiptDigest,
				integrityValid: true,
				directlyRelevant: true,
			};
		}
		break;
	}
	return {
		materiallyAssisted: materiallyAuthored,
		materiallyAuthored,
		validationSucceeded: input.validationFresh,
		independentReviewPassed: input.independentReviewFresh,
		...(receipt === undefined ? {} : { receipt }),
		...(decisions === undefined ? {} : { decisions }),
	};
}
