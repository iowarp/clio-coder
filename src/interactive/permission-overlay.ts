import type { Component } from "../engine/tui.js";

export { type AskAxis, askAxis } from "../domains/safety/approval-axis.js";
export { describeCallTarget, sanitizeCallTargetText } from "../domains/safety/call-target.js";

export interface ApprovalRequestView {
	requestId: string;
	tool: string;
	actionClass: string;
	axis: { kind: "net"; ruleId: string } | { kind: "autonomy"; level: string };
	origin: { kind: "main" } | { kind: "worker"; agentId: string; runId: string };
	reason: string;
	/**
	 * One-line preview of the call's object: the command for bash, the path
	 * for file tools, else a compact args preview. The operator is deciding
	 * whether to allow this exact call, so the overlay must show what the
	 * call will touch, not just the tool name. Main-agent asks derive it from
	 * the parked call's args; worker escalations carry it in the escalation
	 * payload. Absent only when nothing meaningful is derivable.
	 */
	target?: string;
	queueDepth?: number;
}

const PERMISSION_OVERLAY_CONTENT_WIDTH = 78;

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

function axisLabel(axis: ApprovalRequestView["axis"], style: ApprovalRequestView["origin"]["kind"]): string {
	if (axis.kind === "net") return `safety-net rail ${axis.ruleId}`;
	return style === "worker" ? `autonomy level ${axis.level}` : `autonomy level (${axis.level})`;
}

function askedBy(view: ApprovalRequestView): string {
	if (view.origin.kind === "worker") {
		return `worker ${view.origin.agentId} (run ${view.origin.runId}), ${axisLabel(view.axis, "worker")}`;
	}
	return axisLabel(view.axis, "main");
}

export function permissionOverlayTitle(): string {
	return "Allow this action once?";
}

export function createPermissionOverlayBody(view: ApprovalRequestView): Component {
	// The parked call is awaiting a decision, not blocked: the raw rejection
	// short ("<tool> blocked: <class>") is never rendered here because its
	// wording contradicts the ask. Tool, Target, Action, and the asking axis
	// carry everything the operator needs to decide.
	const lines = [
		`Tool: ${truncate(view.tool, 72)}`,
		...(view.target !== undefined && view.target.length > 0 ? [`Target: ${truncate(view.target, 70)}`] : []),
		`Action: ${truncate(view.actionClass, 70)}`,
		`Asked by: ${truncate(askedBy(view), 68)}`,
		"",
		"Parked until you decide; allow or deny applies to this call only.",
		"Hard-blocked actions remain blocked.",
	];
	if (view.queueDepth !== undefined && view.queueDepth > 1) {
		lines.splice(lines.indexOf(""), 0, `1 of ${view.queueDepth} parked`);
	}
	return new PermissionOverlayBody(lines);
}
