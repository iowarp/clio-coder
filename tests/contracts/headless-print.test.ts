import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

	it("an interrupted turn exits nonzero with the abort reason, never a fabricated answer", async () => {
		// The interrupt notice is a typed notice event keyed "turn.interrupted";
		// it must drive the exit code even when the aborted run also produced
		// partial assistant text or an internal error message.
		const chat = buildFakeChatLoop([
			{
				type: "message_end",
				message: { role: "assistant", content: [{ type: "text", text: "partial thought" }], stopReason: "stop" },
			},
			{
				type: "notice",
				surface: "transcript",
				level: "warning",
				key: "turn.interrupted",
				text: "[Clio Coder] active response cancelled.",
			},
		] as unknown as ChatLoopEvent[]);
		const exitCode = await runHeadlessMainAgent(chat, { prompt: "long task" });
		strictEqual(exitCode, 1);
	});

	it("a transcript notice is never the turn's answer", async () => {
		// Pre-0.3.0 notices were fake assistant message_end events keyed off a
		// "[Clio Coder]" text prefix; a notice without the prefix became the
		// answer with exit 0. Typed notices cannot be mistaken for output.
		const chat = buildFakeChatLoop([
			{
				type: "notice",
				surface: "transcript",
				level: "error",
				text: "session.append: no current session",
			},
		] as unknown as ChatLoopEvent[]);
		const exitCode = await runHeadlessMainAgent(chat, { prompt: "hi" });
		strictEqual(exitCode, 1);
	});

	it("accumulates usage across agent segments in the run receipt", async () => {
		// A headless turn can span several agent segments (middleware nudges and
		// finish-contract reprompts start new agent runs); each agent_end
		// carries only its own segment's messages. The receipt must sum the
		// segments: keeping only the last one recorded 23808 of a measured
		// ~204640-token live run.
		const savedStateDir = process.env.CLIO_STATE_DIR;
		process.env.CLIO_STATE_DIR = mkdtempSync(join(tmpdir(), "clio-headless-usage-"));
		try {
			const usageMessage = (tokens: number) => ({
				role: "assistant",
				content: [{ type: "text", text: "segment answer" }],
				usage: { input: tokens - 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: tokens },
			});
			const chat = buildFakeChatLoop([
				{ type: "agent_end", messages: [usageMessage(1000)] },
				// Notice-only segment: no usage, must not clobber the total.
				{ type: "agent_end", messages: [] },
				{ type: "agent_end", messages: [usageMessage(200)] },
				{ type: "message_end", message: usageMessage(0) },
			] as unknown as ChatLoopEvent[]);
			(chat as unknown as { lastRunSnapshot: () => unknown }).lastRunSnapshot = () => ({
				runtimeKind: "http",
				targetId: "test-target",
				wireModelId: "test-model",
				runtimeId: "llamacpp",
				autonomy: "read-only",
				sessionId: "fake-session",
				cwd: process.cwd(),
				promptSignature: "sig",
				toolSignature: "sig",
				compiledPromptHash: "hash",
				staticCompositionHash: "hash",
			});
			const exitCode = await runHeadlessMainAgent(chat, { prompt: "multi-segment" });
			strictEqual(exitCode, 0);
			const receiptsDir = join(process.env.CLIO_STATE_DIR ?? "", "receipts");
			const files = readdirSync(receiptsDir).filter((name) => name.endsWith(".json"));
			strictEqual(files.length, 1, "one receipt recorded");
			const receipt = JSON.parse(readFileSync(join(receiptsDir, files[0] ?? ""), "utf8")) as {
				tokenCount: number;
				outputTokenCount: number;
				autonomyEnforcement?: unknown;
			};
			strictEqual(receipt.tokenCount, 1200, "segments sum instead of last-segment-wins");
			ok(receipt.outputTokenCount === 20, "per-field totals sum too");
			deepStrictEqual(receipt.autonomyEnforcement, { grade: "mediated", autonomy: "read-only" });
		} finally {
			if (savedStateDir === undefined) delete process.env.CLIO_STATE_DIR;
			else process.env.CLIO_STATE_DIR = savedStateDir;
		}
	});
});
