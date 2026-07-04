import type { AutonomyLevel } from "./autonomy.js";
import type { SafetyDecision } from "./contract.js";

/**
 * Which axis produced an `ask`: a safety-net rail demands confirmation at
 * every level, while an autonomy ask exists only because of the current level.
 */
export type AskAxis = { kind: "autonomy" } | { kind: "net"; ruleId: string };

export function askAxis(decision: SafetyDecision): AskAxis {
	if (decision.kind === "ask") {
		if (decision.match) return { kind: "net", ruleId: decision.match.ruleId };
		if (decision.policy?.kind === "ask") {
			return { kind: "net", ruleId: decision.policy.ruleId ?? decision.policy.reasonCode };
		}
	}
	return { kind: "autonomy" };
}

export function approvalAxisId(decision: SafetyDecision, level: AutonomyLevel): string {
	const axis = askAxis(decision);
	return axis.kind === "net" ? `net:${axis.ruleId}` : `autonomy:${level}`;
}
