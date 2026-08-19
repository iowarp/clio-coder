import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runHeadlessMainAgent } from "../../src/cli/modes/print.js";
import { resetXdgCache } from "../../src/core/xdg.js";
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
	function captureStdout(): { text: () => string; restore: () => void } {
		const original = process.stdout.write;
		let captured = "";
		// The callback matters: runHeadlessMainAgent ends on a flush that awaits it.
		process.stdout.write = ((
			chunk: string | Uint8Array,
			encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
			callback?: (error?: Error | null) => void,
		): boolean => {
			captured += String(chunk);
			const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
			done?.(null);
			return true;
		}) as typeof process.stdout.write;
		return { text: () => captured, restore: () => (process.stdout.write = original) };
	}

	function captureStderr(): { text: () => string; restore: () => void } {
		const original = process.stderr.write;
		let captured = "";
		process.stderr.write = ((chunk: string | Uint8Array): boolean => {
			captured += String(chunk);
			return true;
		}) as typeof process.stderr.write;
		return { text: () => captured, restore: () => (process.stderr.write = original) };
	}

	it("prints the terminating tool's result when the artifact is the whole answer", async () => {
		// F4 of the 3b sweep: a headless turn that ended on a terminating artifact
		// wrote PLAN.md, printed nothing at all, and exited 0. The tool's own
		// result is what the operator needed: what was written, and where.
		const chat = buildFakeChatLoop([
			{ type: "tool_execution_start", toolCallId: "1", toolName: "artifact", args: { kind: "plan" } },
			{
				type: "tool_execution_end",
				toolCallId: "1",
				toolName: "artifact",
				result: {
					content: [{ type: "text", text: "wrote plan artifact (572B) to PLAN.md" }],
					details: { kind: "plan", paths: ["/work/PLAN.md"] },
					terminate: true,
				},
				isError: false,
			},
		] as unknown as ChatLoopEvent[]);
		const stdout = captureStdout();
		try {
			const exitCode = await runHeadlessMainAgent(chat, { prompt: "write a plan" });
			strictEqual(exitCode, 0);
			strictEqual(stdout.text(), "wrote plan artifact (572B) to PLAN.md\n");
		} finally {
			stdout.restore();
		}
	});

	it("supersedes mid-workflow chatter with the terminating tool's result", async () => {
		// The near-miss is worse than the silence: the last assistant text before
		// the artifact call was a dangling "let me try...", and that is what the
		// CLI printed for a turn that had already written its report.
		const chat = buildFakeChatLoop([
			{
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Let me take a step back and search for a couple more papers." }],
					stopReason: "stop",
				},
			},
			{ type: "tool_execution_start", toolCallId: "1", toolName: "artifact", args: { kind: "report" } },
			{
				type: "tool_execution_end",
				toolCallId: "1",
				toolName: "artifact",
				result: {
					content: [{ type: "text", text: "wrote report artifact (3566B) to REPORT.md" }],
					details: { kind: "report", paths: ["/work/REPORT.md"] },
					terminate: true,
				},
				isError: false,
			},
		] as unknown as ChatLoopEvent[]);
		const stdout = captureStdout();
		try {
			const exitCode = await runHeadlessMainAgent(chat, { prompt: "survey the literature" });
			strictEqual(exitCode, 0);
			strictEqual(stdout.text(), "wrote report artifact (3566B) to REPORT.md\n");
		} finally {
			stdout.restore();
		}
	});

	it("exits 0 when the turn ends on a terminating tool result that said nothing (artifact plan)", async () => {
		// Regression for FINDINGS.md F2's headless corroboration: a turn whose
		// only action is a terminal artifact (kind=plan/review/report) never
		// produces an assistant message_end (ToolResult.terminate skips the
		// follow-up LLM call), so headless `clio-coder run` used to report "no
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

	it("prefixes a provider failure with its target and records the corrected outcome detail", async () => {
		const savedStateDir = process.env.CLIO_CODER_STATE_DIR;
		process.env.CLIO_CODER_STATE_DIR = mkdtempSync(join(tmpdir(), "clio-headless-failure-"));
		resetXdgCache();
		const stderr = captureStderr();
		try {
			const chat = buildFakeChatLoop([
				{
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "" }],
						stopReason: "error",
						errorMessage: "stream stalled: no output for 15s",
					},
				},
			] as unknown as ChatLoopEvent[]);
			(chat as unknown as { lastRunSnapshot: () => unknown }).lastRunSnapshot = () => runSnapshot();

			const exitCode = await runHeadlessMainAgent(chat, { prompt: "wait for the model" });
			strictEqual(exitCode, 1);
			const expected = "target 'test-target' (llamacpp http://127.0.0.1:8080): stream stalled: no output for 15s";
			ok(stderr.text().endsWith(`${expected}\n`), "the final stderr line carries the attributed failure");

			const receiptsDir = join(process.env.CLIO_CODER_STATE_DIR ?? "", "receipts");
			const files = readdirSync(receiptsDir).filter((name) => name.endsWith(".json"));
			strictEqual(files.length, 1, "one failed receipt recorded");
			const receipt = JSON.parse(readFileSync(join(receiptsDir, files[0] ?? ""), "utf8")) as {
				outcomeDetail?: string;
				failureMessage?: string;
			};
			strictEqual(receipt.outcomeDetail, "stream stalled: no output for 15s");
			strictEqual(receipt.failureMessage, "stream stalled: no output for 15s");
		} finally {
			stderr.restore();
			if (savedStateDir === undefined) delete process.env.CLIO_CODER_STATE_DIR;
			else process.env.CLIO_CODER_STATE_DIR = savedStateDir;
			resetXdgCache();
		}
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
		// finish-contract reprompts start new agent runs). Usage is accrued once
		// per completed assistant message; the agent_end that republishes the
		// same segment must not count it a second time.
		const savedStateDir = process.env.CLIO_CODER_STATE_DIR;
		process.env.CLIO_CODER_STATE_DIR = mkdtempSync(join(tmpdir(), "clio-headless-usage-"));
		resetXdgCache();
		try {
			const usageMessage = (tokens: number) => ({
				role: "assistant",
				content: [{ type: "text", text: "segment answer" }],
				usage: { input: tokens - 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: tokens },
			});
			const first = usageMessage(1000);
			const second = usageMessage(200);
			const chat = buildFakeChatLoop([
				{ type: "message_end", message: first },
				{ type: "agent_end", messages: [first] },
				// Notice-only segment: no usage, must not clobber the total.
				{ type: "agent_end", messages: [] },
				{ type: "message_end", message: second },
				{ type: "agent_end", messages: [second] },
			] as unknown as ChatLoopEvent[]);
			(chat as unknown as { lastRunSnapshot: () => unknown }).lastRunSnapshot = () => runSnapshot();
			const exitCode = await runHeadlessMainAgent(chat, { prompt: "multi-segment" });
			strictEqual(exitCode, 0);
			const receiptsDir = join(process.env.CLIO_CODER_STATE_DIR ?? "", "receipts");
			const files = readdirSync(receiptsDir).filter((name) => name.endsWith(".json"));
			strictEqual(files.length, 1, "one receipt recorded");
			const receipt = JSON.parse(readFileSync(join(receiptsDir, files[0] ?? ""), "utf8")) as {
				tokenCount: number;
				outputTokenCount: number;
				autonomyEnforcement?: unknown;
			};
			strictEqual(receipt.tokenCount, 1200, "messages sum, and agent_end never double counts them");
			ok(receipt.outputTokenCount === 20, "per-field totals sum too");
			deepStrictEqual(receipt.autonomyEnforcement, { grade: "mediated", autonomy: "read-only" });
		} finally {
			if (savedStateDir === undefined) delete process.env.CLIO_CODER_STATE_DIR;
			else process.env.CLIO_CODER_STATE_DIR = savedStateDir;
			resetXdgCache();
		}
	});

	it("seals a canceled receipt for a run the shutdown signal interrupts", async () => {
		// A SIGINT exits the process from inside the shutdown coordinator,
		// strictly before the awaited submit resumes. A soak of SciCode problem
		// 11 interrupted mid-step consumed 1,008,198 reported tokens and left no
		// receipt at all. The drain phase seals it instead.
		const savedStateDir = process.env.CLIO_CODER_STATE_DIR;
		process.env.CLIO_CODER_STATE_DIR = mkdtempSync(join(tmpdir(), "clio-headless-interrupt-"));
		resetXdgCache();
		try {
			const drainHooks: Array<() => void | Promise<void>> = [];
			let interrupted = false;
			let releaseSubmit = (): void => {};
			const submitted = new Promise<void>((resolveSubmit) => {
				releaseSubmit = resolveSubmit;
			});
			const chat = buildFakeChatLoop([]);
			let emit: (event: ChatLoopEvent) => void = () => {};
			const baseOnEvent = chat.onEvent.bind(chat);
			(chat as unknown as { onEvent: ChatLoop["onEvent"] }).onEvent = (handler) => {
				emit = handler;
				return baseOnEvent(handler);
			};
			(chat as unknown as { submit: ChatLoop["submit"] }).submit = async () => {
				emit({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "partial" }],
						usage: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1000 },
					},
				} as unknown as ChatLoopEvent);
				await submitted;
			};
			(chat as unknown as { lastRunSnapshot: () => unknown }).lastRunSnapshot = () => runSnapshot();

			const running = runHeadlessMainAgent(chat, {
				prompt: "long interrupted task",
				shutdown: {
					onDrain: (hook) => drainHooks.push(hook),
					getExitCode: () => 130,
					isShuttingDown: () => drainHooks.length > 0 && interrupted,
				},
			});
			// Let submit start and stream its first usage-bearing message.
			await new Promise((r) => setTimeout(r, 0));
			interrupted = true;
			for (const hook of drainHooks) await hook();

			const receiptsDir = join(process.env.CLIO_CODER_STATE_DIR ?? "", "receipts");
			const files = readdirSync(receiptsDir).filter((name) => name.endsWith(".json"));
			strictEqual(files.length, 1, "the interrupted run has a receipt");
			const receipt = JSON.parse(readFileSync(join(receiptsDir, files[0] ?? ""), "utf8")) as {
				outcome: string;
				exitCode: number;
				tokenCount: number;
				failureMessage?: string;
			};
			strictEqual(receipt.outcome, "canceled");
			strictEqual(receipt.exitCode, 130, "the receipt reports the signal's exit status");
			strictEqual(receipt.tokenCount, 1000, "usage accrued before the interrupt is accounted");

			releaseSubmit();
			await running;
			strictEqual(
				readdirSync(receiptsDir).filter((name) => name.endsWith(".json")).length,
				1,
				"the completion path does not seal a second receipt",
			);
		} finally {
			if (savedStateDir === undefined) delete process.env.CLIO_CODER_STATE_DIR;
			else process.env.CLIO_CODER_STATE_DIR = savedStateDir;
			resetXdgCache();
		}
	});
});

function runSnapshot(): unknown {
	return {
		runtimeKind: "http",
		targetId: "test-target",
		targetUrl: "http://127.0.0.1:8080",
		wireModelId: "test-model",
		runtimeId: "llamacpp",
		autonomy: "read-only",
		sessionId: "fake-session",
		cwd: process.cwd(),
		promptSignature: "sig",
		toolSignature: "sig",
		compiledPromptHash: "hash",
		staticCompositionHash: "hash",
	};
}
