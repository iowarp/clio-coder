import type { ClassifierCall } from "../domains/safety/action-classifier.js";
import type { SafetyDecision } from "../domains/safety/contract.js";
import type { Component } from "../engine/tui.js";

const PERMISSION_OVERLAY_CONTENT_WIDTH = 56;

export const PERMISSION_OVERLAY_WIDTH = PERMISSION_OVERLAY_CONTENT_WIDTH + 4;

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

export function createPermissionOverlayBody(call: ClassifierCall, decision: SafetyDecision): Component {
	const action = decision.classification.actionClass;
	const reason = decision.kind === "ask" ? decision.rejection.short : `${call.tool} requests ${action}`;
	return new PermissionOverlayBody([
		`Tool: ${truncate(call.tool, 46)}`,
		`Action: ${truncate(action, 44)}`,
		truncate(reason, 54),
		"",
		"Allowing resumes only this parked tool call.",
		"Hard-blocked actions remain blocked.",
		"",
		"[Enter] allow once    [Esc] cancel",
	]);
}
