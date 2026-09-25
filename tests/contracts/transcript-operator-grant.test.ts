import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import type { ChatLoopEvent } from "../../src/interactive/chat-loop.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import type { ApprovalRequestView } from "../../src/interactive/permission-overlay.js";

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
		const grant = lines.findIndex((line) => /\? allowed by you · safety-net rail git-restore-discard-all/u.test(line));
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

test("compact never folds an allowed call into its neighbors", () => {
	const panel = createChatPanel({ getOutputStyle: () => "compact", now: () => 1_000 });
	// Reads outside the workspace ask at default; a run of reads is one fold.
	settle(panel, "read-a", "none", "read", { path: "/etc/hosts" });
	settle(panel, "read-b", "granted", "read", { path: "/etc/passwd" });
	settle(panel, "read-c", "none", "read", { path: "/etc/group" });
	const rendered = panel.render(100).map(stripTerminalSequences).join("\n");
	match(rendered, /\? allowed by you/u, rendered);
	match(rendered, /\/etc\/passwd/u, rendered);
});
