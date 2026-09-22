import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { type HeadlessShutdownHooks, runHeadlessMainAgent } from "../../src/cli/modes/print.js";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { AgentMessage } from "../../src/engine/types.js";
import type { ChatLoop, ChatLoopEvent } from "../../src/interactive/chat-loop.js";
import { readRunJournal } from "../harness/run-journal.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function assistant(
	stopReason: "error" | "toolUse" | "stop" | "length",
	content: Extract<AgentMessage, { role: "assistant" }>["content"] = [],
): ChatLoopEvent {
	return {
		type: "message_end",
		message: {
			role: "assistant",
			api: "openai-completions",
			provider: "fixture",
			model: "fixture-model",
			timestamp: 1,
			stopReason,
			...(stopReason === "length" ? { rawStopReason: "length" } : {}),
			content,
			...(stopReason === "error" ? { errorMessage: "fixture provider failure" } : {}),
			usage: {
				input: stopReason === "length" ? 47781 : 3,
				output: stopReason === "length" ? 8192 : 2,
				reasoning: stopReason === "length" ? 7926 : 0,
				totalTokens: stopReason === "length" ? 55973 : 5,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0.125, output: 0.125, cacheRead: 0, cacheWrite: 0, total: 0.25 },
			},
		} as AgentMessage,
	};
}

const call = assistant("toolUse", [
	{ type: "toolCall", id: "artifact-1", name: "artifact", arguments: { kind: "report", content: "fixture report" } },
]);
const artifact: ChatLoopEvent = {
	type: "tool_execution_end",
	toolName: "artifact",
	toolCallId: "artifact-1",
	isError: false,
	result: { terminate: true, content: [{ type: "text", text: "wrote fixture report" }], details: { kind: "ok" } },
};
const toolMessage: ChatLoopEvent = {
	type: "message_end",
	message: {
		role: "toolResult",
		toolCallId: "artifact-1",
		toolName: "artifact",
		content: [{ type: "text", text: "wrote fixture report" }],
		isError: false,
		timestamp: 2,
	},
};

function blockedThenRead(actionClass: "execute" | "write"): ChatLoopEvent[] {
	return [
		{
			type: "tool_execution_end",
			toolName: actionClass === "write" ? "edit" : "bash",
			toolCallId: "denied",
			isError: true,
			outcome: "blocked",
			actionClass,
			decision: "blocked",
			result: { content: [{ type: "text", text: "denied" }], details: {} },
		} as ChatLoopEvent,
		{
			type: "tool_execution_end",
			toolName: "read",
			toolCallId: "recovery",
			isError: false,
			outcome: "ok",
			actionClass: "read",
			result: { content: [{ type: "text", text: "three lines" }], details: {} },
		} as ChatLoopEvent,
		assistant("stop", [{ type: "text", text: "The file contains three lines." }]),
	];
}

// Event-fold coverage, not a provider reproduction. Unlike the original
// local diagnostic, this exercises real receipt persistence and integrity too.
for (const scenario of [
	{
		name: "native read cannot certify recovery of denied execution",
		events: blockedThenRead("execute"),
		code: 1,
		outcome: "failed",
		calls: 1,
	},
	{
		name: "unrelated read cannot recover denied edit",
		events: blockedThenRead("write"),
		code: 1,
		outcome: "failed",
		calls: 1,
	},
	{
		name: "empty terminal output exhaustion retains its specific cause",
		events: [assistant("length")],
		code: 1,
		outcome: "failed",
		calls: 1,
		exhausted: true,
		emptyText: true,
	},
	{
		name: "later terminal output exhaustion supersedes prior artifact",
		events: [call, artifact, assistant("length")],
		code: 1,
		outcome: "failed",
		calls: 2,
		exhausted: true,
		emptyText: true,
	},
	{
		name: "saved shape: earlier chatter cannot hide empty terminal output exhaustion",
		events: [assistant("toolUse", [{ type: "text", text: "Let me investigate." }]), assistant("length")],
		code: 1,
		outcome: "failed",
		calls: 2,
		exhausted: true,
	},
	{
		name: "partial terminal output exhaustion is not completion",
		events: [assistant("length", [{ type: "text", text: "Partial explanation" }])],
		code: 1,
		outcome: "failed",
		calls: 1,
		exhausted: true,
	},
	{
		name: "truncated call followed by natural completion succeeds",
		events: [
			assistant("length", [{ type: "toolCall", id: "truncated", name: "bash", arguments: {} }]),
			toolMessage,
			assistant("stop", [{ type: "text", text: "Complete answer" }]),
		],
		code: 0,
		outcome: "succeeded",
		calls: 2,
	},
	{
		name: "output exhaustion followed by artifact completion succeeds",
		events: [assistant("length"), call, artifact, toolMessage],
		code: 0,
		outcome: "succeeded",
		calls: 2,
	},
	{
		name: "cancellation takes precedence over output exhaustion",
		events: [
			assistant("length"),
			{ type: "notice", surface: "transcript", key: "turn.interrupted", text: "fixture canceled" },
		],
		code: 1,
		outcome: "canceled",
		calls: 1,
	},
	{
		name: "final provider error supersedes output exhaustion",
		events: [assistant("length"), assistant("error")],
		code: 1,
		outcome: "failed",
		calls: 2,
	},
	{ name: "clean tool-only completion", events: [call, artifact, toolMessage], code: 0, outcome: "succeeded", calls: 1 },
	{
		name: "recovered tool-only completion retains failed-call spend",
		events: [assistant("error"), call, artifact, toolMessage],
		code: 0,
		outcome: "succeeded",
		calls: 2,
	},
	{
		name: "subsequent provider failure wins over prior artifact",
		events: [call, artifact, assistant("error")],
		code: 1,
		outcome: "failed",
		calls: 2,
	},
	{
		name: "tool message cannot clear provider failure",
		events: [assistant("error"), toolMessage],
		code: 1,
		outcome: "failed",
		calls: 1,
	},
	{
		name: "empty recovery without an answer still fails",
		events: [assistant("error"), assistant("stop")],
		code: 1,
		outcome: "failed",
		calls: 2,
	},
	{
		name: "failed artifact is not terminal success",
		events: [call, { ...artifact, isError: true }],
		code: 1,
		outcome: "failed",
		calls: 1,
	},
	{
		name: "explicit cancellation wins over artifact",
		events: [
			call,
			artifact,
			{ type: "notice", surface: "transcript", key: "turn.interrupted", text: "fixture canceled" },
		],
		code: 1,
		outcome: "canceled",
		calls: 1,
	},
	{
		name: "shutdown wins over artifact and seals once",
		events: [call, artifact],
		code: 143,
		outcome: "canceled",
		calls: 1,
		shutdown: true,
	},
] as const) {
	for (const mode of ["text", "full", "terminal"] as const) {
		test(`headless settlement: ${scenario.name} (${mode})`, async (t) => {
			let stdout = "";
			let stderr = "";
			const reportWrite = process.stdout.write.bind(process.stdout);
			t.mock.method(process.stdout, "write", (chunk: string, callback?: (error?: Error | null) => void) => {
				if (typeof chunk !== "string") return reportWrite(chunk);
				stdout += String(chunk);
				if (typeof callback === "function") callback();
				return true;
			});
			t.mock.method(process.stderr, "write", (chunk: string) => {
				stderr += String(chunk);
				return true;
			});
			const scratch = await isolateClioEnv("clio-coder-headless-settlement-");
			try {
				let listener: ((event: ChatLoopEvent) => void) | undefined;
				let drain: (() => void | Promise<void>) | undefined;
				const shuttingDown = "shutdown" in scenario;
				const shutdown: HeadlessShutdownHooks = {
					onDrain: (hook) => {
						drain = hook;
					},
					getExitCode: () => (shuttingDown ? 143 : 0),
					isShuttingDown: () => shuttingDown,
				};
				const chat: Pick<ChatLoop, "getSessionId" | "lastRunSnapshot" | "onEvent" | "submit"> = {
					getSessionId: () => "fixture-session",
					lastRunSnapshot: () => ({
						targetId: "fixture",
						targetUrl: "http://127.0.0.1",
						runtimeId: "openai-compat",
						runtimeKind: "http",
						wireModelId: "fixture-model",
						autonomy: "full-auto",
						compiledPromptHash: null,
						staticCompositionHash: null,
						promptSignature: null,
						toolSignature: null,
						sessionId: "fixture-session",
						cwd: scratch.dir,
					}),
					onEvent(callback: (event: ChatLoopEvent) => void) {
						listener = callback;
						return () => {
							listener = undefined;
						};
					},
					async submit() {
						for (const event of scenario.events) listener?.(event as ChatLoopEvent);
						if (shuttingDown) await drain?.();
					},
				};
				const code = await runHeadlessMainAgent(chat as ChatLoop, {
					prompt: "fixture report",
					mode: mode === "text" ? "text" : "json",
					jsonEvents: mode === "full" ? "full" : "terminal",
					shutdown,
				});
				if (shuttingDown) await drain?.();
				const journal = readRunJournal(join(scratch.dir, "state"));
				ok(journal);
				strictEqual(journal.receipts.length, 1);
				const receipt = journal.receipts[0];
				ok(receipt);
				const envelope = journal.envelopes.get(receipt.runId);
				ok(envelope);
				strictEqual(envelope.exitCode, scenario.code);
				strictEqual(envelope.outcomeDetail, receipt.outcomeDetail);
				strictEqual(
					envelope.status,
					scenario.outcome === "succeeded" ? "completed" : scenario.outcome === "canceled" ? "interrupted" : "failed",
				);
				deepStrictEqual(
					{ code, exitCode: receipt.exitCode, outcome: receipt.outcome },
					{ code: scenario.code, exitCode: scenario.code, outcome: scenario.outcome },
				);
				if ("exhausted" in scenario) {
					match(receipt.outcomeDetail ?? "", /output token limit.*stopReason=length/);
					strictEqual(receipt.failureMessage, receipt.outcomeDetail);
				}
				const exhaustedCalls = scenario.events.filter(
					(event) =>
						event.type === "message_end" &&
						"message" in event &&
						event.message.role === "assistant" &&
						event.message.stopReason === "length",
				).length;
				strictEqual(receipt.tokenCount, scenario.calls * 5 + exhaustedCalls * 55968);
				strictEqual(receipt.reasoningTokenCount, exhaustedCalls * 7926);
				if ("exhausted" in scenario) {
					match(stderr, /output token limit.*stopReason=length/);
					strictEqual(stderr.trim().split("\n").at(-1), receipt.failureMessage);
					if (mode === "text") {
						if ("emptyText" in scenario) strictEqual(stdout, "");
						else match(stdout, /Let me investigate\.|Partial explanation/);
					}
					if (mode === "full") {
						match(stdout, /"stopReason":"length"/);
						match(stdout, /"rawStopReason":"length"/);
					}
					if (mode === "terminal") {
						const end = stdout
							.split("\n")
							.filter(Boolean)
							.map((line) => JSON.parse(line))
							.find((event) => event.type === "turn_end");
						strictEqual(end.exitCode, 1);
						strictEqual(end.error, receipt.failureMessage);
					}
				}
				strictEqual(receipt.costUsd, scenario.calls * 0.25);
				ok(verifyReceiptIntegrity(receipt, envelope).ok);
			} finally {
				scratch.restore();
			}
		});
	}
}
