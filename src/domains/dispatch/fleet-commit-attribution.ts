import type { CommitAttributionEvidence } from "../../core/commit-attribution.js";
import type { ExecutionPlan, ExecutionPlanCodeStep } from "./execution-plan.js";

export interface FleetCommitPriorResult {
	succeeded: boolean;
	integrityValid: boolean;
	runDigest: string;
	/** Decision refs from the step's run; they become `Clio-Decision:` trailers. */
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
	let run: CommitAttributionEvidence["run"];
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
		if (/^[0-9a-f]{64}$/u.test(result.runDigest)) {
			run = {
				version: 1,
				algorithm: "sha256",
				digest: result.runDigest,
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
		...(run === undefined ? {} : { run }),
		...(decisions === undefined ? {} : { decisions }),
	};
}
