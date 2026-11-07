import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { rehydrateChatPanelFromTurns } from "../../src/interactive/chat-renderer.js";
import type { ApprovalRequestView } from "../../src/interactive/permission-overlay.js";
import type { ChatLoopEvent } from "../../src/session-control/chat-loop.js";

// BT-003: after Enter on an `Approve system change` card the only surviving row
// was `$ ran \`git restore .\` · exit 0 …`, identical to a call that never asked.
const VIEW: ApprovalRequestView = {
	requestId: "apr-1",
	tool: "bash",
	actionClass: "git_destructive",
	axis: { kind: "net", ruleId: "git-restore-discard-all" },
	origin: { kind: "main" },
	reason: "bash blocked: git_destructive",
	target: "git restore .",
};

const ARGS = { command: "git restore ." };
const RESULT = { content: [{ type: "text", text: "" }], details: { exitCode: 0 } };

function settle(
	panel: ReturnType<typeof createChatPanel>,
	id: string,
	grant: "granted" | "none",
	toolName = "bash",
	args: Record<string, unknown> = ARGS,
): void {
	panel.applyEvent({ type: "tool_execution_start", toolCallId: id, toolName, args } as ChatLoopEvent);
	if (grant === "granted") {
		panel.applyEvent({ type: "tool_approval_state", toolCallId: id, state: "awaiting-approval", view: VIEW });
		panel.applyEvent({ type: "tool_approval_state", toolCallId: id, state: "resumed" });
	}
	panel.applyEvent({
		type: "tool_execution_end",
		toolCallId: id,
		toolName,
		result: RESULT,
		isError: false,
		durationMs: 94,
	} as ChatLoopEvent);
}

for (const style of ["compact", "standard", "detailed"] as const) {
	test(`${style}: a call the operator allowed keeps a ? row naming the grant after it settles`, () => {
		const panel = createChatPanel({ getOutputStyle: () => style, now: () => 1_000 });
		settle(panel, "bash-1", "granted");
		const lines = panel.render(100).map(stripTerminalSequences);
		const row = lines.findIndex((line) => line.includes("git restore ."));
		ok(row >= 0, lines.join("\n"));
		const grant = lines.findIndex((line) => /› allowed by you · safety net: git restore discard all/u.test(line));
		ok(grant > row, `no grant row under the call:\n${lines.join("\n")}`);
		strictEqual(grant, row + 1, "the grant sits directly under the call it answered");
		doesNotMatch(lines.join("\n"), /awaiting approval/u);
	});
}

test("a call that never asked has no grant row", () => {
	const panel = createChatPanel({ getOutputStyle: () => "standard", now: () => 1_000 });
	settle(panel, "bash-2", "none");
	const rendered = panel.render(100).map(stripTerminalSequences).join("\n");
	match(rendered, /git restore \./u);
	doesNotMatch(rendered, /allowed by you/u);
});

for (const style of ["compact", "standard", "detailed"] as const) {
	test(`${style}: risky YOLO calls retain one receipt and never fold away their targets`, () => {
		const panel = createChatPanel({ getOutputStyle: () => style });
		for (const id of ["write-a", "write-b"]) {
			panel.applyEvent({ type: "tool_execution_start", toolCallId: id, toolName: "write", args: { path: `${id}.txt` } });
			panel.applyEvent({
				type: "tool_execution_end",
				toolCallId: id,
				toolName: "write",
				result: RESULT,
				isError: false,
				autoApproved: "yolo",
			} as ChatLoopEvent);
		}
		const output = panel.render(80).map(stripTerminalSequences).join("\n");
		match(output, /write-a\.txt/);
		match(output, /write-b\.txt/);
		strictEqual((output.match(/YOLO auto-approved · no prompt/g) ?? []).length, 2);
		doesNotMatch(output, /allowed by you/);
	});
}

test("a YOLO receipt survives session replay without reinterpreting the current mode", () => {
	const panel = createChatPanel({ getOutputStyle: () => "compact" });
	rehydrateChatPanelFromTurns(panel, [
		{
			kind: "message",
			role: "tool_call",
			turnId: "call",
			parentTurnId: null,
			timestamp: "2026-11-06T00:00:00Z",
			payload: { toolCallId: "bash-1", toolName: "bash", args: ARGS },
		},
		{
			kind: "message",
			role: "tool_result",
			turnId: "result",
			parentTurnId: "call",
			timestamp: "2026-11-06T00:00:01Z",
			payload: { toolCallId: "bash-1", toolName: "bash", result: RESULT, isError: false, autoApproved: "yolo" },
		},
	]);
	match(panel.render(80).map(stripTerminalSequences).join("\n"), /YOLO auto-approved · no prompt/);
});

test("Minimal names the actions a YOLO chain ran, not just its step count", () => {
	const panel = createChatPanel({ getOutputStyle: () => "compact" });
	const steps = [
		{ id: "a", capability: "write", args: { path: "trace-a.txt" }, result: RESULT },
		{ id: "b", capability: "write", args: { path: "trace-b.txt" }, result: RESULT },
	];
	panel.applyEvent({
		type: "tool_execution_start",
		toolCallId: "chain",
		toolName: "gateway",
		args: { op: "chain", steps },
	});
	panel.applyEvent({
		type: "tool_execution_end",
		toolCallId: "chain",
		toolName: "gateway",
		isError: false,
		result: { details: { op: "chain", chainResults: steps } },
		autoApproved: "yolo",
	} as ChatLoopEvent);
	const output = panel.render(80).map(stripTerminalSequences).join("\n");
	match(output, /YOLO auto-approved · no prompt/);
	match(output, /write trace-a\.txt/);
	match(output, /write trace-b\.txt/);
});

test("compact never folds an allowed call into its neighbors", () => {
	const panel = createChatPanel({ getOutputStyle: () => "compact", now: () => 1_000 });
	// Reads outside the workspace ask at default; a run of reads is one fold.
	settle(panel, "read-a", "none", "read", { path: "/etc/hosts" });
	settle(panel, "read-b", "granted", "read", { path: "/etc/passwd" });
	settle(panel, "read-c", "none", "read", { path: "/etc/group" });
	const rendered = panel.render(100).map(stripTerminalSequences).join("\n");
	match(rendered, /› allowed by you/u, rendered);
	match(rendered, /\/etc\/passwd/u, rendered);
});

test("a parked row drops the facts its docked card already shows, and keeps them once the card leaves", () => {
	const panel = createChatPanel({ getOutputStyle: () => "standard", now: () => 1_000 });
	panel.applyEvent({
		type: "tool_execution_start",
		toolCallId: "bash-1",
		toolName: "bash",
		args: ARGS,
	} as ChatLoopEvent);
	const park = (docked: boolean): string => {
		panel.applyEvent({
			type: "tool_approval_state",
			toolCallId: "bash-1",
			state: "awaiting-approval",
			view: VIEW,
			...(docked ? { docked } : {}),
		});
		return panel.render(100).map(stripTerminalSequences).join("\n");
	};
	match(park(false), /held this call for you/u);
	const docked = park(true);
	match(docked, /git restore \.` ⏸ awaiting approval/u);
	doesNotMatch(docked, /held this call for you/u);
	match(park(false), /held this call for you/u);
});
