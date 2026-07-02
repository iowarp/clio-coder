import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { runHeadlessMainAgent } from "../../src/cli/modes/print.js";
import type { ChatLoop, ChatLoopEvent } from "../../src/interactive/chat-loop.js";

function buildFakeChatLoop(events: ChatLoopEvent[]): ChatLoop {
	const handlers: Array<(event: ChatLoopEvent) => void> = [];
	return {
		async submit() {
			for (const event of events) for (const h of handlers) h(event);
		},
		steer() {
			return false;
		},
		queueFollowUp() {
			return false;
		},
		clearQueuedFollowUps() {
			return [];
		},
		queuedMessages() {
			return { items: [] } as unknown as ReturnType<ChatLoop["queuedMessages"]>;
		},
		cancel() {},
		onEvent(handler: (event: ChatLoopEvent) => void) {
			handlers.push(handler);
			return () => {
				const idx = handlers.indexOf(handler);
				if (idx >= 0) handlers.splice(idx, 1);
			};
		},
		getSessionId() {
			return "fake-session";
		},
		isStreaming() {
			return false;
		},
		contextUsage() {
			return {} as ReturnType<ChatLoop["contextUsage"]>;
		},
		contextLedger() {
			return {} as ReturnType<ChatLoop["contextLedger"]>;
		},
		async compact() {},
	} as unknown as ChatLoop;
}

describe("contracts/headless-print", () => {
	it("exits 0 with empty output when the turn ends on a terminating tool result (artifact plan)", async () => {
		// Regression for FINDINGS.md F2's headless corroboration: a turn whose
		// only action is a terminal artifact (kind=plan/review/report) never
		// produces an assistant message_end (ToolResult.terminate skips the
		// follow-up LLM call), so headless `clio run` used to report "no
		// assistant response" and exit 1 even though the tool did real,
		// successful work.
		const chat = buildFakeChatLoop([
			{ type: "tool_execution_start", toolCallId: "1", toolName: "artifact", args: { kind: "plan" } },
			{
				type: "tool_execution_end",
				toolCallId: "1",
				toolName: "artifact",
				result: { content: [], details: {}, terminate: true },
				isError: false,
			},
		] as unknown as ChatLoopEvent[]);
		const exitCode = await runHeadlessMainAgent(chat, { prompt: "write a plan" });
		strictEqual(exitCode, 0);
	});

	it("still exits 1 with no assistant response when nothing at all happened", async () => {
		const chat = buildFakeChatLoop([]);
		const exitCode = await runHeadlessMainAgent(chat, { prompt: "do nothing" });
		strictEqual(exitCode, 1);
	});

	it("still returns the real assistant text when the turn ends normally", async () => {
		const chat = buildFakeChatLoop([
			{
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "hello" }], stopReason: "stop" },
			},
		] as unknown as ChatLoopEvent[]);
		const exitCode = await runHeadlessMainAgent(chat, { prompt: "hi" });
		strictEqual(exitCode, 0);
	});

	it("a non-terminating tool result with no assistant text still exits 1", async () => {
		const chat = buildFakeChatLoop([
			{ type: "tool_execution_start", toolCallId: "1", toolName: "read", args: {} },
			{
				type: "tool_execution_end",
				toolCallId: "1",
				toolName: "read",
				result: { content: [], details: {} },
				isError: false,
			},
		] as unknown as ChatLoopEvent[]);
		const exitCode = await runHeadlessMainAgent(chat, { prompt: "read a file" });
		strictEqual(exitCode, 1);
	});
});
