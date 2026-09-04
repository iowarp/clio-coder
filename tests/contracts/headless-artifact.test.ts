import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { type HeadlessShutdownHooks, runHeadlessMainAgent } from "../../src/cli/modes/print.js";
import { readRunJournal, receiptInvariantMetrics } from "../../src/domains/eval/metrics/invariants.js";
import type { AgentMessage } from "../../src/engine/types.js";
import type { ChatLoop, ChatLoopEvent } from "../../src/interactive/chat-loop.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function assistant(
	stopReason: "error" | "toolUse" | "stop",
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
			content,
			...(stopReason === "error" ? { errorMessage: "fixture provider failure" } : {}),
			usage: {
				input: 3,
				output: 2,
				totalTokens: 5,
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

// Event-fold coverage, not a provider/eval reproduction. Unlike the original
// local diagnostic, this exercises real receipt persistence and integrity too.
for (const scenario of [
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
	test(`headless settlement: ${scenario.name}`, async () => {
		const scratch = await isolateClioEnv("clio-headless-settlement-");
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
				mode: "json",
				jsonEvents: "terminal",
				shutdown,
			});
			if (shuttingDown) await drain?.();
			const journal = readRunJournal(join(scratch.dir, "state"));
			ok(journal);
			strictEqual(journal.receipts.length, 1);
			const receipt = journal.receipts[0];
			ok(receipt);
			deepStrictEqual(
				{ code, exitCode: receipt.exitCode, outcome: receipt.outcome },
				{ code: scenario.code, exitCode: scenario.code, outcome: scenario.outcome },
			);
			strictEqual(receipt.tokenCount, scenario.calls * 5);
			strictEqual(receipt.costUsd, scenario.calls * 0.25);
			const metrics = receiptInvariantMetrics(journal, code);
			strictEqual(metrics["receipt.integrityValid"], true);
			strictEqual(metrics["receipt.outcomeMatchesExit"], true);
		} finally {
			scratch.restore();
		}
	});
}
