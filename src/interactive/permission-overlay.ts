import type { Component } from "../engine/tui.js";

export { type AskAxis, askAxis } from "../domains/safety/approval-axis.js";

export interface ApprovalRequestView {
	requestId: string;
	tool: string;
	actionClass: string;
	axis: { kind: "net"; ruleId: string } | { kind: "autonomy"; level: string };
	origin: { kind: "main" } | { kind: "worker"; agentId: string; runId: string };
	reason: string;
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

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
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
	const lines = [
		`Tool: ${truncate(view.tool, 72)}`,
		`Action: ${truncate(view.actionClass, 70)}`,
		`Asked by: ${truncate(askedBy(view), 68)}`,
		truncate(oneLine(view.reason), 76),
		"",
		view.origin.kind === "worker"
			? "Allowing resumes the parked call inside the worker."
			: "Allowing resumes only this parked tool call.",
		"Hard-blocked actions remain blocked.",
	];
	if (view.queueDepth !== undefined && view.queueDepth > 1) {
		lines.splice(4, 0, `Queue: 1 of ${view.queueDepth} parked`);
	}
	return new PermissionOverlayBody(lines);
}
