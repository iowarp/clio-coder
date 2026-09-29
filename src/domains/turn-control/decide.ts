import { canonicalDigest } from "./canonical-json.js";
import type { TurnFacts } from "./facts.js";
import { fingerprintEquals } from "./facts.js";
import type { TurnInterpretation } from "./interpretation.js";
import { orientationQuestion } from "./render.js";
import type { TurnControlSettings } from "./settings.js";

export type WorkflowDecision =
	| {
			kind: "none";
			reason:
				| "off"
				| "no-interpretation"
				| "below-threshold"
				| "streak-too-low"
				| "constraints"
				| "continuation"
				| "capability-missing"
				| "task-established"
				| "already-oriented"
				| "model-dispatching";
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
	if (facts.explicitConstraints) return { kind: "none", reason: "constraints" };
	if (settings.workflows.length === 0) return { kind: "none", reason: "off" };
	if (settings.workflows.includes("detached-collection") && facts.finishedDetachedBatchIds.length > 0)
		return { kind: "collect", batchIds: [...facts.finishedDetachedBatchIds] };
	if (facts.continuation) return { kind: "none", reason: "continuation" };
	if (interpretation === null) return { kind: "none", reason: "no-interpretation" };
	const breadth = interpretation.orientation.breadth;
	// Intent is only a veto for the three workflows that already have a task in
	// hand. The site applies it too; it is repeated here because this is the last
	// gate before the harness starts read-only work on the operator's behalf.
	// The model is about to dispatch on its own, so a harness scout first is redundant
	// worker spend. That holds only while the request reads at least as much like a
	// dispatch as like an orientation: "give me a tour" read orientation 0.98 against
	// dispatch 0.71 and got neither the scout nor a dispatch. A producer that gives
	// no probabilities keeps the plain expectation.
	const dispatchP = interpretation.dispatch?.probability;
	const orientationP = interpretation.orientation.probability;
	const modelDispatching =
		interpretation.dispatch?.expected === true &&
		(dispatchP === undefined || orientationP === undefined || dispatchP >= orientationP);
	const orientationEligible =
		settings.workflows.includes("orientation") &&
		!["implement", "continue", "interview"].includes(interpretation.intent) &&
		interpretation.orientation.wanted &&
		(breadth === "repository" || breadth === "area");
	const orientationCapable = facts.capabilities.dispatch && facts.capabilities.scoutRecipeId !== null;
	if (orientationEligible && modelDispatching) return { kind: "none", reason: "model-dispatching" };
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
		settings.workflows.includes("direction") && interpretation.direction.requested && facts.clarificationStreak >= 1;
	if (directionEligible && !facts.taskEstablished && facts.capabilities.readOnlyGit)
		return { kind: "direction", observations: ["git-status", "git-log", "tree", "codemap"] };
	if (orientationEligible && !orientationCapable) return { kind: "none", reason: "capability-missing" };
	if (directionEligible && !facts.taskEstablished && !facts.capabilities.readOnlyGit)
		return { kind: "none", reason: "capability-missing" };
	if (directionEligible && facts.taskEstablished && facts.capabilities.readOnlyGit)
		return { kind: "none", reason: "task-established" };
	// Direction waits for a turn that already ended on the operator, so a first
	// "not sure" must not read as a request nobody asked for.
	if (settings.workflows.includes("direction") && interpretation.direction.requested && facts.clarificationStreak < 1)
		return { kind: "none", reason: "streak-too-low" };
	return { kind: "none", reason: "below-threshold" };
}

export function decisionHash(decision: WorkflowDecision): string {
	return canonicalDigest(decision);
}
