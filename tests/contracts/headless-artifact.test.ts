import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type HeadlessShutdownHooks, runHeadlessMainAgent } from "../../src/cli/modes/print.js";
import { readRunJournal, receiptInvariantMetrics } from "../../src/domains/eval/metrics/invariants.js";
import { runClioRunRunner } from "../../src/domains/eval/runners/clio-run.js";
import type { AgentMessage } from "../../src/engine/types.js";
import type { ChatLoop, ChatLoopEvent } from "../../src/interactive/chat-loop.js";
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

// Event-fold coverage, not a provider/eval reproduction. Unlike the original
// local diagnostic, this exercises real receipt persistence and integrity too.
for (const scenario of [
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
			t.mock.method(process.stdout, "write", (chunk: string, callback?: (error?: Error | null) => void) => {
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
				const metrics = receiptInvariantMetrics(journal, code);
				strictEqual(metrics["receipt.integrityValid"], true);
				strictEqual(metrics["receipt.outcomeMatchesExit"], true);
			} finally {
				scratch.restore();
			}
		});
	}
}

// The eval runner's exit code is the invariant's process-side witness, so it
// has to be the Clio process's own. Through `sh -c` on dash the shell stayed
// the parent: the deadline's SIGTERM stopped the shell, Clio ran on to seal a
// succeeded receipt and exit 0, and the runner reported 124 (issue #275). A
// stand-in entry script shows both halves without a model: its own exit code
// is reported, and the deadline signal reaches it rather than a shell.
test("eval clio-coder-run runner: the deadline and the exit code belong to the Clio process", async () => {
	const scratch = await isolateClioEnv("clio-coder-run-runner-");
	try {
		const entry = join(scratch.dir, "fake-clio.mjs");
		writeFileSync(
			entry,
			[
				'if (process.env.FAKE_CLIO_MODE === "exit-7") process.exit(7);',
				'process.on("SIGTERM", () => { process.stdout.write("terminated\\n"); process.exit(143); });',
				'setTimeout(() => { process.stdout.write("finished\\n"); process.exit(0); }, 5000);',
			].join("\n"),
		);
		const runner = { kind: "clio-coder-run", prompt: "fixture" } as const;
		const target = { id: "fixture" };
		const own = await runClioRunRunner(runner, scratch.dir, entry, 5_000, target, { FAKE_CLIO_MODE: "exit-7" });
		strictEqual(own.exitCode, 7);
		const timedOut = await runClioRunRunner(runner, scratch.dir, entry, 500, target, { FAKE_CLIO_MODE: "linger" });
		strictEqual(timedOut.exitCode, 143, timedOut.stderr);
		match(timedOut.stdout, /terminated/u);
		doesNotMatch(timedOut.stdout, /finished/u);
	} finally {
		scratch.restore();
	}
});
