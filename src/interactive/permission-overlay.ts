import type { ClassifierCall } from "../domains/safety/action-classifier.js";
import type { SafetyDecision } from "../domains/safety/contract.js";
import type { Component } from "../engine/tui.js";

const PERMISSION_OVERLAY_CONTENT_WIDTH = 56;

export const PERMISSION_OVERLAY_WIDTH = PERMISSION_OVERLAY_CONTENT_WIDTH + 4;

/**
 * Which axis produced an `ask`: a safety-net rail (damage-control ask rule or
 * project requireConfirmation) demands confirmation at every level, while an
 * autonomy ask exists only because of the current level. Autonomy-shaped ask
 * decisions carry the engine's pass-through policy (kind "allow"), so a net
 * ask is recognizable by its damage-control match or its policy ask verdict.
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

class PermissionOverlayBody implements Component {
	constructor(private readonly lines: readonly string[]) {}

	render(_width: number): string[] {
		return [...this.lines];
	}

	invalidate(): void {}
}

function truncate(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
}

export function permissionOverlayTitle(): string {
	return "Allow this action once?";
}

export function createPermissionOverlayBody(
	call: ClassifierCall,
	decision: SafetyDecision,
	autonomy?: string,
): Component {
	const action = decision.classification.actionClass;
	const reason = decision.kind === "ask" ? decision.rejection.short : `${call.tool} requests ${action}`;
	const axis = askAxis(decision);
	const askedBy = axis.kind === "net" ? `safety-net rail ${axis.ruleId}` : `autonomy level (${autonomy ?? "auto-edit"})`;
	return new PermissionOverlayBody([
		`Tool: ${truncate(call.tool, 46)}`,
		`Action: ${truncate(action, 44)}`,
		`Asked by: ${truncate(askedBy, 44)}`,
		truncate(reason, 54),
		"",
		"Allowing resumes only this parked tool call.",
		"Hard-blocked actions remain blocked.",
	]);
}
