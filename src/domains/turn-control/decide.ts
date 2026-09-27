import { canonicalDigest } from "./canonical-json.js";
import type { TurnFacts } from "./facts.js";
import { fingerprintEquals } from "./facts.js";
import type { TurnInterpretation } from "./interpretation.js";
import { orientationQuestion } from "./render.js";
import type { TurnControlSettings } from "./settings.js";

// Placeholder thresholds until the labeled fixture of S5 sets them.
export const INTENT_CERTAINTY_THRESHOLD = 0.6;
export const ORIENTATION_WANTED_THRESHOLD = 0.7;
export const DIRECTION_REQUESTED_THRESHOLD = 0.7;

export type WorkflowDecision =
	| {
			kind: "none";
			reason:
				| "off"
				| "no-interpretation"
				| "below-threshold"
				| "constraints"
				| "continuation"
				| "capability-missing"
				| "task-established"
				| "already-oriented";
	  }
	| {
			kind: "orientation";
			question: string;
			breadth: "repository" | "area";
			reuse: { runId: string; receiptDigest: string } | null;
			budget: { maxScouts: 1 | 2 | 3 | 4; toolCallsPerScout: number };
	  }
	| { kind: "direction"; observations: ReadonlyArray<"git-status" | "git-log" | "tree" | "codemap"> }
	| { kind: "collect"; batchIds: ReadonlyArray<string> };

export function decide(
	interpretation: TurnInterpretation | null,
	facts: TurnFacts,
	settings: TurnControlSettings,
): WorkflowDecision {
	if (facts.continuation) return { kind: "none", reason: "continuation" };
	if (facts.explicitConstraints) return { kind: "none", reason: "constraints" };
	if (settings.workflows.length === 0) return { kind: "none", reason: "off" };
	if (settings.workflows.includes("detached-collection") && facts.finishedDetachedBatchIds.length > 0)
		return { kind: "collect", batchIds: [...facts.finishedDetachedBatchIds] };
	if (interpretation === null) return { kind: "none", reason: "no-interpretation" };
	const breadth = interpretation.orientation.breadth;
	const orientationEligible =
		settings.workflows.includes("orientation") &&
		interpretation.intentCertainty >= INTENT_CERTAINTY_THRESHOLD &&
		["inspect", "plan", "unknown"].includes(interpretation.intent) &&
		interpretation.orientation.wanted >= ORIENTATION_WANTED_THRESHOLD &&
		(breadth === "repository" || breadth === "area");
	const orientationCapable = facts.capabilities.dispatch && facts.capabilities.scoutRecipeId !== null;
	if (orientationEligible && orientationCapable && (breadth === "repository" || breadth === "area")) {
		const prior = facts.priorOrientation;
		return {
			kind: "orientation",
			question: orientationQuestion(facts.operatorText, breadth, settings.orientation.maxSplit),
			breadth,
			reuse:
				prior && fingerprintEquals(prior.fingerprint, facts.workspace)
					? { runId: prior.runId, receiptDigest: prior.receiptDigest }
					: null,
			budget: { maxScouts: settings.orientation.maxSplit, toolCallsPerScout: 36 },
		};
	}
	const directionEligible =
		settings.workflows.includes("direction") &&
		interpretation.direction.requested >= DIRECTION_REQUESTED_THRESHOLD &&
		facts.clarificationStreak >= 1;
	if (directionEligible && !facts.taskEstablished && facts.capabilities.readOnlyGit)
		return { kind: "direction", observations: ["git-status", "git-log", "tree", "codemap"] };
	if (orientationEligible && !orientationCapable) return { kind: "none", reason: "capability-missing" };
	if (directionEligible && !facts.taskEstablished && !facts.capabilities.readOnlyGit)
		return { kind: "none", reason: "capability-missing" };
	if (directionEligible && facts.taskEstablished && facts.capabilities.readOnlyGit)
		return { kind: "none", reason: "task-established" };
	return { kind: "none", reason: "below-threshold" };
}

export function decisionHash(decision: WorkflowDecision): string {
	return canonicalDigest(decision);
}
