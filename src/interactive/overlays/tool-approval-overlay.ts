import type { OverlayHandle, TUI } from "../../engine/tui.js";
import { Text, visibleWidth } from "../../engine/tui.js";
import type { ToolApprovalRequestPayload, ToolApprovalResponsePayload } from "../../engine/worker-events.js";
import { showClioOverlayFrame } from "../overlay-frame.js";

const ESC = "\u001b";
const TOOL_APPROVAL_OVERLAY_MIN_WIDTH = 64;
const TOOL_APPROVAL_OVERLAY_MAX_WIDTH = 96;

export interface ToolApprovalOverlayInput {
	tui: TUI;
	request: ToolApprovalRequestPayload;
}

export interface ToolApprovalOverlayKeyDeps {
	resolve: (decision: ToolApprovalResponsePayload["decision"], reason: string) => void;
}

export function openToolApprovalOverlay(input: ToolApprovalOverlayInput): OverlayHandle {
	const lines = formatToolApprovalRequest(input.request);
	const body = new Text(lines.join("\n"), 0, 0);
	return showClioOverlayFrame(input.tui, body, {
		anchor: "center",
		width: resolveOverlayWidth(input.tui, lines),
		title: "Tool approval",
	});
}

export function routeToolApprovalOverlayKey(data: string, deps: ToolApprovalOverlayKeyDeps): boolean {
	if (data === "a" || data === "A") {
		deps.resolve("allow", "user approved (TUI)");
		return true;
	}
	if (data === "d" || data === "D") {
		deps.resolve("deny", "user denied (TUI)");
		return true;
	}
	if (data === ESC) {
		deps.resolve("deny", "overlay closed without choice");
		return true;
	}
	return true;
}

export function formatToolApprovalRequest(req: ToolApprovalRequestPayload): string[] {
	const out: string[] = [];
	out.push(`Claude Code wants to run: ${req.claudeToolName}`);
	out.push("");
	for (const [key, value] of Object.entries(req.args)) {
		out.push(`  ${key}: ${truncate(stringifyArg(value), 200)}`);
	}
	if (Object.keys(req.args).length === 0) {
		out.push("  (no arguments)");
	}
	out.push("");
	out.push(`Safety classification: ${req.classification.actionClass}`);
	if (req.classification.reasons.length > 0) {
		out.push("Reasons:");
		for (const reason of req.classification.reasons) out.push(`  - ${truncate(reason, 180)}`);
	}
	if (req.rejection) {
		out.push("");
		out.push(`Policy: ${truncate(req.rejection.short, 180)}`);
		if (req.rejection.detail.length > 0) out.push(truncate(req.rejection.detail, 220));
	}
	out.push("");
	out.push("[A] Allow once   [D] Deny   [Esc] Deny");
	return out;
}

function resolveOverlayWidth(tui: TUI, lines: ReadonlyArray<string>): number {
	const naturalWidth = Math.max(TOOL_APPROVAL_OVERLAY_MIN_WIDTH, ...lines.map((line) => visibleWidth(line) + 4));
	const capped = Math.min(TOOL_APPROVAL_OVERLAY_MAX_WIDTH, naturalWidth);
	const columns = tui.terminal?.columns;
	if (!columns || columns <= 0) return capped;
	return Math.max(40, Math.min(capped, columns - 4));
}

function stringifyArg(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		const json = JSON.stringify(value);
		return json ?? String(value);
	} catch {
		return String(value);
	}
}

function truncate(value: string, max: number): string {
	return value.length > max ? `${value.slice(0, Math.max(0, max - 3))}...` : value;
}
