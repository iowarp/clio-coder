import type { ClassifierCall } from "../domains/safety/action-classifier.js";
import { askAxis } from "../domains/safety/approval-axis.js";
import type { SafetyDecision } from "../domains/safety/contract.js";
import type { Component } from "../engine/tui.js";

export { type AskAxis, askAxis } from "../domains/safety/approval-axis.js";

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

export function createPermissionOverlayBody(
	call: ClassifierCall,
	decision: SafetyDecision,
	autonomy?: string,
	worker?: { agentId: string; runId: string },
): Component {
	const action = decision.classification.actionClass;
	const reason = decision.kind === "ask" ? decision.rejection.short : `${call.tool} requests ${action}`;
	const axis = askAxis(decision);
	const askedBy = worker
		? `worker ${worker.agentId} (run ${worker.runId})`
		: axis.kind === "net"
			? `safety-net rail ${axis.ruleId}`
			: `autonomy level (${autonomy ?? "auto-edit"})`;
	return new PermissionOverlayBody([
		`Tool: ${truncate(call.tool, 46)}`,
		`Action: ${truncate(action, 44)}`,
		`Asked by: ${truncate(askedBy, 44)}`,
		truncate(reason, 54),
		"",
		worker ? "Allowing resumes the parked call inside the worker." : "Allowing resumes only this parked tool call.",
		"Hard-blocked actions remain blocked.",
	]);
}
