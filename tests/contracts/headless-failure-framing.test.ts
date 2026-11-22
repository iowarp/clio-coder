import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { writeFrame } from "../../src/cli/modes/jsonl.js";
import { prefixHeadlessFailure, runHeadlessMainAgent } from "../../src/cli/modes/print.js";
import { createToolCallIdMinter } from "../../src/cli/modes/run-json-schema-v2.js";
import { mapExitCode } from "../../src/cli/run.js";
import {
	completionExitCode,
	noteAgentAnswer,
	noteAgentRunCompletion,
	withRunFailureReporting,
	withRunResultV2,
} from "../../src/cli/run-failure.js";
import { agentRunCompletion, dispatchAnswerText } from "../../src/cli/run-output.js";
import { finishRunResult } from "../../src/domains/dispatch/run-settlement.js";
import { CITATION_CHECK_PREFIX } from "../../src/domains/safety/citation-grounding.js";
import type { ChatLoopRunSnapshot } from "../../src/session-control/chat-loop.js";
import { CONTEXT_OVERFLOW_STOP_NOTICE_KEY } from "../../src/session-control/chat-loop-messages.js";
import { formatDispatchOutput } from "../../src/tools/dispatch-runner.js";
import { settleStubBuilder } from "../harness/dispatch.js";
import { fixtureEnvelope, fixtureReceiptDraft } from "../harness/receipt.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

test("headless budget and admission stops do not report an endpoint outage", () => {
	const chat = {
		lastRunSnapshot: () => ({ targetId: "openai-codex", runtimeId: "openai-codex" }) as ChatLoopRunSnapshot,
	};
	const budget = "budget_ceiling: this run's priced spend $0.0007 reached its --max-cost-usd $0.0006 cap.";
	strictEqual(prefixHeadlessFailure(chat, budget), budget);
	const admission = "IMAGE_INPUT_UNSUPPORTED: this route does not accept images";
	strictEqual(prefixHeadlessFailure(chat, admission, true), admission);
	const provider = prefixHeadlessFailure(chat, "HTTP 503");
	match(provider, /target 'openai-codex' \(openai-codex\): HTTP 503/u);
	doesNotMatch(provider, /endpoint unavailable/u);
});

const answerMessage = (text: string): object => ({
	role: "assistant",
	stopReason: "stop",
	content: [{ type: "text", text }],
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
});

/** Stdout of a headless run whose answer drew a citation check before the final reply. */
async function stdoutAfterCitationCheck(
	answer: string,
	reply: string,
	mode: "text" | "json",
	stderr: string[] = [],
): Promise<string> {
	let handler: (event: unknown) => void = () => {};
	const stub: Record<string, unknown> = {
		onEvent: (next: (event: unknown) => void) => {
			handler = next;
			return () => {};
		},
		getSessionId: () => null,
		submit: async () => {
			handler({ type: "agent_start" });
			handler({ type: "message_end", message: answerMessage(answer) });
			handler({ type: "turn_end", message: answerMessage(answer), toolResults: [] });
			handler({
				type: "notice",
				level: "warning",
				surface: "transcript",
				source: "reminder",
				text: `${CITATION_CHECK_PREFIX} README.md:2 cite line numbers no tool printed; Before answering, re-read each cited region with read line_numbers=true.`,
			});
			handler({ type: "message_end", message: answerMessage(reply) });
			handler({ type: "turn_end", message: answerMessage(reply), toolResults: [] });
			handler({ type: "agent_end", messages: [answerMessage(answer), answerMessage(reply)] });
		},
		whenSettled: async () => {},
		lastRunSnapshot: () => null,
		isStreaming: () => false,
	};
	const chat = new Proxy(stub, { get: (target, key) => (key in target ? target[key as string] : undefined) });
	const written: string[] = [];
	const write = process.stdout.write;
	const writeError = process.stderr.write;
	process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
		written.push(String(chunk));
		for (const argument of rest) if (typeof argument === "function") argument();
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		stderr.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		await runHeadlessMainAgent(
			chat as never,
			{
				prompt: "x",
				mode,
				shutdown: { onDrain() {}, getExitCode: () => 0, isShuttingDown: () => false },
			} as never,
		);
	} finally {
		process.stdout.write = write;
		process.stderr.write = writeError;
	}
	return written.join("");
}

test("a reply to a citation check that holds only corrections keeps the answer it corrects", async () => {
	const answer = "The entry point is c_to_k in src/convert.py.\nRun the tests with python3 -m pytest -q (README.md:2).";
	const reply = "Citations re-verified; README.md:2 holds.";
	const env = await isolateClioEnv("headless-citation-check-");
	try {
		const text = await stdoutAfterCitationCheck(answer, reply, "text");
		ok(text.includes(answer), text);
		ok(text.includes(reply), text);
		const frames = (stdout: string) =>
			stdout
				.split("\n")
				.filter(Boolean)
				.map((line) => JSON.parse(line))
				.filter((frame) => frame.type === "turn_end");
		// The JSON stream's last turn_end.message is where its answer lives (bt-29); schema v2 reframes it.
		const full = frames(await stdoutAfterCitationCheck(answer, reply, "json")).at(-1);
		strictEqual(full.message.content[0].text, `${answer}\n\n${reply}`);
	} finally {
		env.restore();
	}
});

test("a reply to a citation check that rewrites each line with citations is printed alone", async () => {
	const answer =
		"At the default level, workspace edits run without asking.\nEdits ask only outside the workspace roots.\nSource: docs/architecture/safety-model.md, lines 11-21.";
	const reply =
		"At the `default` level, workspace edits run without asking (safety-model.md:15).\nEdits ask only outside the workspace and scratch roots (safety-model.md:15).\nSource: docs/architecture/safety-model.md, lines 11-20.";
	const env = await isolateClioEnv("headless-citation-check-");
	try {
		strictEqual(await stdoutAfterCitationCheck(answer, reply, "text"), `${reply}\n`);
	} finally {
		env.restore();
	}
});

test("a reply to a citation check that restates the answer is printed alone", async () => {
	const answer = "The entry point is c_to_k in src/convert.py.\nRun the tests with python3 -m pytest -q (README.md:2).";
	const reply = `Confirmed with line numbers; the citations stand.\n\n${answer}`;
	const env = await isolateClioEnv("headless-citation-check-");
	try {
		const text = await stdoutAfterCitationCheck(answer, reply, "text");
		strictEqual(text, `${reply}\n`);
	} finally {
		env.restore();
	}
});

test("a citation check reaches the operator's stderr as one line, not the model's instruction", async () => {
	const answer = "Run the tests with python3 -m pytest -q (README.md:2).";
	const env = await isolateClioEnv("headless-citation-check-");
	try {
		const stderr: string[] = [];
		await stdoutAfterCitationCheck(answer, "README.md:2 holds.", "text", stderr);
		strictEqual(stderr.join(""), "clio-coder run: reminder to the model: Citation check\n");
	} finally {
		env.restore();
	}
});

/** Exit code and stderr of a headless change run whose one dispatch call failed with `text` and dropped details. */
async function failedDispatchRun(text: string): Promise<{ code: number; stderr: string }> {
	let handler: (event: unknown) => void = () => {};
	const reply = answerMessage("The delegated change did not land.");
	const stub: Record<string, unknown> = {
		onEvent: (next: (event: unknown) => void) => {
			handler = next;
			return () => {};
		},
		getSessionId: () => null,
		submit: async () => {
			handler({ type: "agent_start" });
			handler({ type: "tool_execution_start", toolCallId: "call-dispatch", toolName: "dispatch", args: {} });
			// A thrown tool error reaches the transcript with its details replaced by {}.
			handler({
				type: "tool_execution_end",
				toolCallId: "call-dispatch",
				toolName: "dispatch",
				result: { content: [{ type: "text", text }], details: {} },
				isError: true,
				outcome: "error",
				actionClass: "dispatch",
				decision: "allowed",
			});
			handler({ type: "message_end", message: reply });
			handler({ type: "turn_end", message: reply, toolResults: [] });
			handler({ type: "agent_end", messages: [reply] });
		},
		whenSettled: async () => {},
		lastRunSnapshot: () => null,
		isStreaming: () => false,
	};
	const chat = new Proxy(stub, { get: (target, key) => (key in target ? target[key as string] : undefined) });
	const stderr: string[] = [];
	const write = process.stdout.write;
	const writeError = process.stderr.write;
	process.stdout.write = ((_chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
		for (const argument of rest) if (typeof argument === "function") argument();
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		stderr.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	try {
		const code = await runHeadlessMainAgent(
			chat as never,
			{
				prompt: "Apply the change.",
				mode: "text",
				shutdown: { onDrain() {}, getExitCode: () => 0, isShuttingDown: () => false },
			} as never,
		);
		return { code, stderr: stderr.join("") };
	} finally {
		process.stdout.write = write;
		process.stderr.write = writeError;
	}
}

test("a dispatch whose worker started and failed is not reported as never started (bt-45 H6)", async () => {
	const env = await isolateClioEnv("headless-dispatch-failed-");
	try {
		const started = await failedDispatchRun(
			`dispatch (sequential) total=1 failed=1\nruns=1hj006g52rl9\nbatch observed_tool_calls=2 cost=not measured\n\n- 1hj006g52rl9 agent=debugger exit=1 target=litellm model=mini/qwen3.8-27b-iq4r-v4 tokens=unknown trust="sealed; no validation observed; ${"completion not applied; ".repeat(8)}" outcome=failed detail=worker process signal: SIGKILL`,
		);
		strictEqual(started.code, 1, started.stderr);
		match(
			started.stderr,
			/no-op: the delegated task failed \(1hj006g52rl9 agent=debugger exit=1 outcome=failed detail=worker process signal: SIGKILL\) and no write succeeded/u,
		);
		doesNotMatch(started.stderr, /never started/u);

		// A failed run's failure message repeats its outcome detail; the reason names the worker cause once, at its end.
		const sigkill =
			"stderr: [worker] bulk evidence incomplete: the worker was terminated by SIGKILL before it finished its output; worker process signal: SIGKILL";
		const timeout = "exit code 1; worker_turn_timeout: round 2 exceeded the 3 second response limit";
		for (const [mode, detail, failureMessage] of [
			["sequential", `exit code 1; ${sigkill}`, sigkill],
			["parallel", timeout, timeout],
		] as const) {
			const envelope = fixtureEnvelope("13k9l997q5o5");
			const settled = finishRunResult(fixtureReceiptDraft(envelope), envelope, {
				terminal: { terminalReason: "completed" },
				processExitCode: 0,
				frameType: null,
				usage: undefined,
			}).result;
			const receipt = { ...settled, exitCode: 1, outcome: "failed" as const, outcomeDetail: detail, failureMessage };
			const summary = { count: 0, types: [], lastAssistantText: "", terminalAttemptRunId: receipt.runId };
			const failed = await failedDispatchRun(formatDispatchOutput(mode, [{ receipt, summary }], 16384));
			strictEqual(failed.code, 1, failed.stderr);
			ok(failed.stderr.includes(`13k9l997q5o5 agent=coder exit=1 outcome=failed detail=`), failed.stderr);
			ok(failed.stderr.includes(`${failureMessage.slice(-60)}) and no write succeeded`), failed.stderr);
			doesNotMatch(failed.stderr, /failure=/u);
		}

		// c16-B: a dispatch refused before any worker ran keeps its wording and its exit 1 no-op.
		const unstarted = await failedDispatchRun("dispatch: admission denied: unknown fleet node 'no-such-node'");
		strictEqual(unstarted.code, 1, unstarted.stderr);
		match(
			unstarted.stderr,
			/no-op: the delegated task never started \(dispatch: admission denied: unknown fleet node 'no-such-node'\) and no write succeeded/u,
		);
	} finally {
		env.restore();
	}
});

/** A headless run whose answer ends on a call it only wrote out, as the turn runtime stamps it; v2 when `format` is set. */
async function writtenCallRun(
	format?: "json" | "stream-json",
	override?: Record<string, unknown>,
	output?: { path: string; cwd: string },
	extra: {
		snapshot?: Partial<ChatLoopRunSnapshot>;
		after?: object[];
		exitCode?: true;
		declared?: Record<string, unknown>;
		/** The host's seal, as the chat loop reports it after turn_end. */
		sealed?: Record<string, unknown>;
		/** Runs the turn dispatched, given the main run's id; `steered` names the ones steer canceled. */
		children?: { runs: (rootRunId: string) => object[]; steered?: ReadonlySet<string> };
		/** Events the turn emits before its reply's message_end. */
		before?: object[];
		/** A terminating tool other than finish that runs after the reply, with the text its result carries. */
		terminating?: { toolName: string; text: string };
		/** The run's messages as agent_end carries them, when more than the reply. */
		ended?: object[];
	} = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	let handler: (event: unknown) => void = () => {};
	const reply = override ?? {
		...answerMessage(
			'The file holds 50 data rows.\n<tool_call>{"name":"read","arguments":{"path":"data.csv"}}</tool_call>',
		),
		clioCoderWrittenCalls: ["read"],
	};
	let rootRunId = "";
	const stub: Record<string, unknown> = {
		onEvent: (next: (event: unknown) => void) => {
			handler = next;
			return () => {};
		},
		getSessionId: () => null,
		submit: async (_prompt: string, options?: { hostRun?: { runId?: string } }) => {
			rootRunId = options?.hostRun?.runId ?? "";
			handler({ type: "agent_start" });
			for (const event of extra.before ?? []) handler(event);
			handler({ type: "message_end", message: reply });
			if (extra.declared !== undefined) {
				handler({ type: "tool_execution_start", toolCallId: "f1", toolName: "finish", args: extra.declared });
				handler({
					type: "tool_execution_end",
					toolCallId: "f1",
					toolName: "finish",
					isError: false,
					outcome: "ok",
					result: {
						terminate: true,
						content: [{ type: "text", text: "completion declared" }],
						details: { completion: extra.declared },
					},
				});
			}
			const terminating = extra.terminating;
			if (terminating !== undefined) {
				handler({ type: "tool_execution_start", toolCallId: "t1", toolName: terminating.toolName, args: {} });
				handler({
					type: "tool_execution_end",
					toolCallId: "t1",
					toolName: terminating.toolName,
					isError: false,
					outcome: "ok",
					result: { terminate: true, content: [{ type: "text", text: terminating.text }], details: {} },
				});
			}
			handler({ type: "turn_end", message: reply, toolResults: [] });
			handler({ type: "agent_end", messages: extra.ended ?? [reply] });
			for (const event of extra.after ?? []) handler(event);
		},
		whenSettled: async () => {},
		lastRunSnapshot: () => extra.snapshot ?? null,
		lastTurnCompletion: () => extra.sealed ?? null,
		isStreaming: () => false,
	};
	const chat = new Proxy(stub, { get: (target, key) => (key in target ? target[key as string] : undefined) });
	const stdout: string[] = [];
	const stderr: string[] = [];
	const write = process.stdout.write;
	const writeError = process.stderr.write;
	process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
		stdout.push(String(chunk));
		for (const argument of rest) if (typeof argument === "function") argument();
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		stderr.push(String(chunk));
		return true;
	}) as typeof process.stderr.write;
	const run = () =>
		runHeadlessMainAgent(
			chat as never,
			{
				prompt: "How many rows?",
				mode: format === undefined ? "text" : "json",
				shutdown: { onDrain() {}, getExitCode: () => 0, isShuttingDown: () => false },
				...(extra.children !== undefined
					? {
							dispatch: {
								listRuns: () => extra.children?.runs(rootRunId) ?? [],
								canceledBySteer: (id: string) => extra.children?.steered?.has(id) === true,
							},
						}
					: {}),
			} as never,
		);
	try {
		const code =
			format !== undefined
				? await withRunResultV2(
						{ format, mode: "main", verify: [], ...(extra.exitCode ? { exitCode: true as const } : {}) },
						run,
					)
				: output !== undefined
					? await withRunFailureReporting(run, output)
					: await run();
		return { code, stdout: stdout.join(""), stderr: stderr.join("") };
	} finally {
		process.stdout.write = write;
		process.stderr.write = writeError;
	}
}

test("text-mode -o holds the printed answer on exit 0 and leaves stdout and the exit code as they were (CLI-P22)", async (t) => {
	const env = await isolateClioEnv("headless-text-output-");
	t.after(() => env.restore());
	const output = { path: "out.txt", cwd: env.dir };
	const file = join(env.dir, "out.txt");
	const pong = answerMessage("pong") as Record<string, unknown>;
	const plain = await writtenCallRun(undefined, pong);
	writeFileSync(file, "stale\n");
	const written = await writtenCallRun(undefined, pong, output);
	strictEqual(plain.code, 0, plain.stderr);
	strictEqual(written.code, plain.code, written.stderr);
	strictEqual(written.stdout, plain.stdout);
	strictEqual(readFileSync(file, "utf8"), plain.stdout);
	// A failed run leaves no file, not the stale one; a missing directory refuses before the run.
	writeFileSync(file, "stale\n");
	const failed = { ...answerMessage(""), content: [], stopReason: "error", errorMessage: "429 Too Many Requests" };
	strictEqual((await writtenCallRun(undefined, failed, output)).code, 1);
	strictEqual(existsSync(file), false);
	const missing = await writtenCallRun(undefined, pong, { path: "nope/out.txt", cwd: env.dir });
	strictEqual(missing.code, 2);
	strictEqual(missing.stdout, "");
	match(missing.stderr, /--output-last-message directory does not exist: /u);
});

// Last in the file: the v2 writer keeps its started mark for the rest of the process.
test("an answer ending on a written call stays exit 0 in v1 and fails as no_answer under v2 (CLI-13)", async (t) => {
	const env = await isolateClioEnv("headless-written-call-");
	t.after(() => env.restore());
	const v1 = await writtenCallRun();
	strictEqual(v1.code, 0, v1.stderr);
	strictEqual(v1.stdout, "The file holds 50 data rows.\n");
	match(v1.stderr, /The answer ends on a written read call/u);
	const v2 = await writtenCallRun("json");
	strictEqual(v2.code, 1, v2.stderr);
	const envelope = JSON.parse(v2.stdout.trim().split("\n").at(-1) ?? "{}") as {
		outcome?: string;
		exitCode?: number;
		causes?: Array<{ code: string; message?: string }>;
	};
	strictEqual(envelope.outcome, "failed");
	strictEqual(envelope.exitCode, 1);
	strictEqual(envelope.causes?.[0]?.code, "no_answer");
	match(envelope.causes?.[0]?.message ?? "", /written read call/u);
	strictEqual(v2.stderr.split("written read call").length - 1, 1, v2.stderr);
});

test("a provider error that ends the run is provider_error under v2 and unchanged in v1 (CLI-P12)", async (t) => {
	const env = await isolateClioEnv("headless-provider-error-");
	t.after(() => env.restore());
	const failed = { ...answerMessage(""), content: [], stopReason: "error", errorMessage: "429 Too Many Requests" };
	const v1 = await writtenCallRun(undefined, failed);
	strictEqual(v1.code, 1, v1.stderr);
	match(v1.stderr, /429 Too Many Requests/u);
	const v2 = await writtenCallRun("json", failed);
	strictEqual(v2.code, 1, v2.stderr);
	const envelope = JSON.parse(v2.stdout.trim().split("\n").at(-1) ?? "{}") as {
		outcomeDetail?: string;
		causes?: Array<{ code: string; message?: string }>;
	};
	strictEqual(envelope.causes?.[0]?.code, "provider_error", v2.stdout);
	strictEqual(envelope.outcomeDetail, "provider_error");
	match(envelope.causes?.[0]?.message ?? "", /429 Too Many Requests/u);
	// The context guard's stop is the window's, not the provider's (FX-22a): context_overflow with its words, and its
	// stderr names no route. A provider failure keeps the route on stderr.
	const stop = "[CLIO Coder] This turn stopped: after compaction about 61943 input tokens plus 12288 reserved";
	const guard = {
		...failed,
		errorMessage: stop,
		failure: { invoked: true, stage: "harness", httpStatus: null, errorClass: "oversized_tool_result", retryAttempts: 0 },
	};
	const route = { snapshot: { targetId: "copilot", runtimeId: "copilot" } };
	match((await writtenCallRun(undefined, failed, undefined, route)).stderr, /target 'copilot' \(copilot\): /u);
	const guardV1 = await writtenCallRun(undefined, guard, undefined, route);
	strictEqual(guardV1.code, 1, guardV1.stderr);
	match(guardV1.stderr, /This turn stopped: after compaction/u);
	doesNotMatch(guardV1.stderr, /target 'copilot'/u);
	const guardV2 = await writtenCallRun("json", guard);
	strictEqual(guardV2.code, 1, guardV2.stderr);
	const guardEnvelope = JSON.parse(guardV2.stdout.trim().split("\n").at(-1) ?? "{}") as typeof envelope;
	strictEqual(guardEnvelope.causes?.[0]?.code, "context_overflow", guardV2.stdout);
	strictEqual(guardEnvelope.outcomeDetail, "context_overflow");
	strictEqual(guardEnvelope.causes?.[0]?.message, stop);
	// Overflow recovery's keyed stop notice, not the refusal's words, makes the same cause; the route's refusal keeps its route.
	const refused = { ...failed, errorMessage: "400 prompt is too long: 70000 tokens > 65536 maximum" };
	const gaveUp = {
		type: "notice",
		level: "info",
		surface: "transcript",
		key: CONTEXT_OVERFLOW_STOP_NOTICE_KEY,
		text: "[CLIO Coder] context overflow persisted after compaction",
	};
	const recoveryV1 = await writtenCallRun(undefined, refused, undefined, { ...route, after: [gaveUp] });
	strictEqual(recoveryV1.code, 1, recoveryV1.stderr);
	match(recoveryV1.stderr, /target 'copilot'/u);
	const recoveryV2 = await writtenCallRun("json", refused, undefined, { after: [gaveUp] });
	strictEqual(recoveryV2.code, 1, recoveryV2.stderr);
	const recoveryEnvelope = JSON.parse(recoveryV2.stdout.trim().split("\n").at(-1) ?? "{}") as typeof envelope;
	strictEqual(recoveryEnvelope.causes?.[0]?.code, "context_overflow", recoveryV2.stdout);
	match(recoveryEnvelope.causes?.[0]?.message ?? "", /prompt is too long/u);
});

test("a declared not_done or partly_done keeps exit 0, rides the envelope, and --exit-code maps it to 1 (fleet design 4.3)", async (t) => {
	const env = await isolateClioEnv("headless-completion-");
	t.after(() => env.restore());
	type Envelope = { exitCode?: number; outcome?: string; causes?: unknown[]; completion?: unknown };
	const last = (stdout: string): Envelope => JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as Envelope;
	const declining = { ...answerMessage("Not done: the task names a schema I was not given.") };
	const notDone = {
		state: "not_done",
		limitations: [{ what: "no schema given", why: "missing_access" }],
		unverified: [],
	};
	const text = await writtenCallRun(undefined, declining, undefined, { declared: notDone });
	strictEqual(text.code, 0, text.stderr);
	// The reply beside finish stays the answer; the tool's own result text does not replace it.
	match(text.stdout, /^Not done: the task names a schema/u);
	strictEqual(completionExitCode(text.code, true), 1);
	strictEqual(completionExitCode(text.code, false), 0);
	const v2 = await writtenCallRun("json", declining, undefined, { declared: notDone });
	strictEqual(v2.code, 0, v2.stderr);
	deepStrictEqual(last(v2.stdout).completion, {
		declared: true,
		claimed: "not_done",
		assessed: "not_done",
		state: "not_done",
		limitations: notDone.limitations,
		unverified: [],
	});
	const mapped = await writtenCallRun("json", declining, undefined, { exitCode: true, declared: notDone });
	strictEqual(mapped.code, 1, mapped.stderr);
	strictEqual(last(mapped.stdout).exitCode, 1);
	strictEqual(last(mapped.stdout).outcome, "succeeded");
	deepStrictEqual(last(mapped.stdout).causes, []);
	const partly = await writtenCallRun("json", declining, undefined, {
		exitCode: true,
		declared: { state: "partly_done" },
	});
	strictEqual(partly.code, 1, partly.stderr);
	strictEqual((last(partly.stdout).completion as { state?: string }).state, "partly_done");
	const done = await writtenCallRun("json", declining, undefined, { exitCode: true, declared: { state: "done" } });
	strictEqual(done.code, 0, done.stderr);
	// The envelope's state is the host's assessment: a done the turn's facts lowered maps to 1.
	const lowered = { declared: true, claimed: "done", assessed: "partly_done", facts: ["open_task"] };
	const sealedDone = await writtenCallRun("json", declining, undefined, {
		exitCode: true,
		declared: { state: "done" },
		sealed: { ...lowered, limitations: [], unverified: [] },
	});
	strictEqual(sealedDone.code, 1, sealedDone.stderr);
	deepStrictEqual(last(sealedDone.stdout).completion, {
		...lowered,
		state: "partly_done",
		limitations: [],
		unverified: [],
	});
	// A plain answer declares nothing: declared false, exit 0 with or without the flag. Reply text is never read.
	const plain = await writtenCallRun("json", answerMessage("Not done.") as Record<string, unknown>, undefined, {
		exitCode: true,
	});
	strictEqual(plain.code, 0, plain.stderr);
	deepStrictEqual(last(plain.stdout).completion, {
		declared: false,
		claimed: null,
		assessed: "unknown",
		state: "unknown",
		limitations: [],
		unverified: [],
	});
});

test("run --agent's run_end carries its sealed receipt's completion; a refused execute call makes a done partly_done (CLI-P58)", async (t) => {
	const env = await isolateClioEnv("headless-agent-completion-");
	t.after(() => env.restore());
	const report = { mutatedPaths: ["calc.py"], validations: [], declaredChecks: ["python3 calc.py: refused"] };
	const sealed = {
		...fixtureReceiptDraft(fixtureEnvelope()),
		digest: "d",
		output: {
			state: "final",
			text: "",
			bytes: 0,
			truncated: false,
			structured: { kind: "mutation-report", data: report },
		},
	};
	const refused = { tool: "bash", actionClass: "execute", permissionRequired: true, reason: "headless run denies asks" };
	const safety = { decisions: {}, blockedAttempts: [], permissionRequestedAttempts: [refused] };
	const envelopeOf = async (receipt: object) => {
		const stdout: string[] = [];
		const write = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
			stdout.push(String(chunk));
			for (const argument of rest) if (typeof argument === "function") argument();
			return true;
		}) as typeof process.stdout.write;
		try {
			const code = await withRunResultV2({ format: "json", mode: "agent", agentId: "coder", verify: [] }, async () => {
				writeFrame({ type: "result", result: receipt } as never);
				noteAgentRunCompletion(agentRunCompletion(receipt as never));
				return 0;
			});
			strictEqual(code, 0);
			const end = JSON.parse(stdout.join("").trim().split("\n").at(-1) ?? "{}");
			return end as { exitCode?: number; outcome?: string; completion?: unknown };
		} finally {
			process.stdout.write = write;
		}
	};
	const partly = await envelopeOf({ ...sealed, safety });
	// Additive: the exit code and outcome stay the worker's own.
	strictEqual(partly.exitCode, 0);
	strictEqual(partly.outcome, "succeeded");
	deepStrictEqual(partly.completion, {
		declared: true,
		claimed: "done",
		assessed: "partly_done",
		state: "partly_done",
		facts: ["refused_check"],
		limitations: [{ what: "bash call refused: headless run denies asks", why: "blocked_by_policy" }],
		unverified: ["python3 calc.py: refused"],
	});
	// A check that verified the run after the refusal leaves the done standing.
	const verified = await envelopeOf({
		...sealed,
		safety,
		verification: { state: "verified", basis: "validation-tool" },
	});
	strictEqual((verified.completion as { state?: string }).state, "done");
});

test("run --agent's result.text is the worker's answer in words; its sealed contract stays on the receipt (row 362)", async (t) => {
	const env = await isolateClioEnv("headless-agent-answer-");
	t.after(() => env.restore());
	const report = { mutatedPaths: ["src/math.js"], validations: [], summary: "Added clamp." };
	const json = JSON.stringify(report);
	const receipt = {
		...fixtureReceiptDraft(fixtureEnvelope()),
		digest: "d",
		output: {
			state: "final",
			text: json,
			bytes: json.length,
			truncated: false,
			structured: { version: 1, kind: "mutation-report", data: report },
		},
	};
	strictEqual(dispatchAnswerText(json, receipt as never), "Added clamp.\nchanged: src/math.js");
	strictEqual(dispatchAnswerText("Plain words.", receipt as never), "Plain words.");
	const stdout: string[] = [];
	const write = process.stdout.write;
	process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
		stdout.push(String(chunk));
		for (const argument of rest) if (typeof argument === "function") argument();
		return true;
	}) as typeof process.stdout.write;
	try {
		const code = await withRunResultV2({ format: "json", mode: "agent", agentId: "coder", verify: [] }, async () => {
			writeFrame({ type: "result", result: receipt } as never);
			noteAgentAnswer(dispatchAnswerText(json, receipt as never));
			return 0;
		});
		strictEqual(code, 0);
	} finally {
		process.stdout.write = write;
	}
	const end = JSON.parse(stdout.join("").trim().split("\n").at(-1) ?? "{}") as {
		result?: { text?: string };
		dispatch?: { runs?: Array<{ output?: { structured?: { kind?: string } } }> };
	};
	strictEqual(end.result?.text, "Added clamp.\nchanged: src/math.js");
	strictEqual(end.dispatch?.runs?.[0]?.output?.structured?.kind, "mutation-report");
});

test("a v2 run_end lists every child run the main agent dispatched, a steer cancel as canceled (row 164)", async (t) => {
	const env = await isolateClioEnv("headless-dispatch-runs-");
	t.after(() => env.restore());
	const child =
		(id: string, agentId: string, outcome: string, second: number, parentRunId?: string) => (rootRunId: string) => ({
			id,
			agentId,
			task: `task of ${id}`,
			status: outcome === "succeeded" ? "completed" : "failed",
			outcome,
			startedAt: `2026-11-20T00:00:0${second}.000Z`,
			endedAt: `2026-11-20T00:00:0${second + 1}.000Z`,
			lineage: { rootRunId, parentRunId: parentRunId ?? rootRunId, attempt: parentRunId ? 1 : 0, depth: 1 },
		});
	// Listed newest first, as a ledger may; the envelope lists them oldest first.
	const children = {
		runs: (root: string) =>
			[
				child("steered", "coder", "failed", 4),
				child("retry", "debugger", "succeeded", 3, "first"),
				child("scouted", "scout", "succeeded", 2),
				child("first", "debugger", "failed", 1),
			].map((make) => make(root)),
		steered: new Set(["steered"]),
	};
	const pong = answerMessage("pong") as Record<string, unknown>;
	const v2 = await writtenCallRun("json", pong, undefined, { children });
	strictEqual(v2.code, 0, v2.stderr);
	const envelope = JSON.parse(v2.stdout.trim().split("\n").at(-1) ?? "{}") as {
		dispatch?: { runs?: Array<Record<string, unknown>>; undelivered?: unknown[] };
	};
	deepStrictEqual(
		envelope.dispatch?.runs?.map(({ runId, agentId, outcome }) => [runId, agentId, outcome]),
		[
			["first", "debugger", "failed"],
			["scouted", "scout", "succeeded"],
			["retry", "debugger", "succeeded"],
			["steered", "coder", "canceled"],
		],
	);
	match(String(envelope.dispatch?.runs?.[3]?.outcomeDetail), /canceled through steer/u);
	deepStrictEqual(envelope.dispatch?.undelivered, []);
	// No children: an empty list, as before.
	const alone = await writtenCallRun("json", pong);
	deepStrictEqual((JSON.parse(alone.stdout.trim()) as { dispatch?: { runs?: unknown[] } }).dispatch?.runs, []);
});

test("v2 stream-json tool frames carry Clio's tc_<turn>_<n> id and the provider's beside it (CLI-8)", async (t) => {
	const env = await isolateClioEnv("headless-tool-call-ids-");
	t.after(() => env.restore());
	const call = (id: string, name: string) => ({ type: "toolCall", id, name, arguments: {} });
	const asks = (...calls: object[]) => ({ ...answerMessage(""), stopReason: "toolUse", content: calls });
	const result = { content: [{ type: "text", text: "ok" }], details: {} };
	const ran = (id: string, toolName: string) => [
		{ type: "tool_execution_start", toolCallId: id, toolName, args: {} },
		{ type: "tool_execution_end", toolCallId: id, toolName, result, isError: false },
	];
	const first = asks(call("call_B", "read"), call("call_A", "grep"));
	// The second turn's provider numbers its calls again from the same id.
	const second = asks(call("call_B", "read"));
	const before = [
		{ type: "turn_start" },
		{ type: "message_end", message: first },
		// Parallel execution settles out of the message's order; the ids follow the message.
		...ran("call_A", "grep"),
		...ran("call_B", "read"),
		{ type: "message_end", message: { role: "toolResult", toolCallId: "call_B", toolName: "read", content: [] } },
		{ type: "turn_end", message: first, toolResults: [] },
		{ type: "turn_start" },
		{ type: "message_end", message: second },
		...ran("call_B", "read"),
	];
	const pong = answerMessage("pong") as Record<string, unknown>;
	const v2 = await writtenCallRun("stream-json", pong, undefined, { before });
	strictEqual(v2.code, 0, v2.stderr);
	const frames = v2.stdout
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as Record<string, unknown> & { message?: Record<string, unknown> });
	deepStrictEqual(
		frames
			.filter((frame) => String(frame.type).startsWith("tool_execution_"))
			.map((frame) => [frame.type, frame.toolCallId, frame.providerToolCallId]),
		[
			["tool_execution_start", "tc_1_2", "call_A"],
			["tool_execution_end", "tc_1_2", "call_A"],
			["tool_execution_start", "tc_1_1", "call_B"],
			["tool_execution_end", "tc_1_1", "call_B"],
			["tool_execution_start", "tc_2_1", "call_B"],
			["tool_execution_end", "tc_2_1", "call_B"],
		],
	);
	const toolResult = frames.find((frame) => frame.message?.role === "toolResult")?.message;
	deepStrictEqual([toolResult?.toolCallId, toolResult?.providerToolCallId], ["tc_1_1", "call_B"]);
	// The model's own toolCall blocks keep the provider's id as sent.
	match(v2.stdout, /"type":"toolCall","id":"call_A"/u);
	// A gateway chain step names its parent by Clio's id; its provider id is the chain call's.
	const mint = createToolCallIdMinter();
	mint({ type: "turn_start" });
	mint({ type: "tool_execution_start", toolCallId: "gw" });
	deepStrictEqual(mint({ type: "tool_execution_end", toolCallId: "gw:s2", parentToolCallId: "gw" }), {
		type: "tool_execution_end",
		toolCallId: "tc_1_1:s2",
		parentToolCallId: "tc_1_1",
		providerToolCallId: "gw",
	});
});

test("every reply of the final user turn reaches stdout, -o and the v2 answer in order; narration does not (CLI-P43)", async (t) => {
	const env = await isolateClioEnv("headless-reply-segments-");
	t.after(() => env.restore());
	const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } };
	const assistant = (stopReason: string, content: object[]) => ({ role: "assistant", stopReason, content, usage });
	const finishCall = { type: "toolCall", id: "f1", name: "finish", arguments: { state: "partly_done" } };
	const review = "Findings:\n1. [blocker] the collector drops a settling firing (src/collector.ts:12).";
	const closing = "Citations re-verified; the ranges hold.";
	const note = "Let me check one more file.";
	// Rounds as the turn runtime emits them: text beside a read is narration, and finish ends the turn with
	// `terminate` (the helper's declared finish), so no message follows it.
	const narration = assistant("toolUse", [
		{ type: "text", text: note },
		{ type: "toolCall", id: "r1", name: "read", arguments: { path: "a.ts" } },
	]);
	const failed = { ...assistant("error", []), errorMessage: "503 overloaded" };
	const round = (message: object) => [
		{ type: "message_end", message },
		{ type: "turn_end", message, toolResults: [] },
	];
	const citationCheck = {
		type: "notice",
		level: "warning",
		surface: "transcript",
		source: "reminder",
		text: `${CITATION_CHECK_PREFIX} src/collector.ts:12 cite line numbers no tool printed; re-read it with line numbers.`,
	};
	const silentFinish = assistant("toolUse", [finishCall]);
	const besideFinish = assistant("toolUse", [{ type: "text", text: closing }, finishCall]);
	const declared = { state: "partly_done" };
	const plan = "wrote plan artifact (42B) to PLAN.md";
	const scenarios: Array<{
		name: string;
		before: object[];
		last: Record<string, unknown>;
		expected: string;
		extra?: { declared?: Record<string, unknown>; terminating?: { toolName: string; text: string } };
	}> = [
		{
			name: "reply, narration beside a read, silent finish",
			before: [...round(answerMessage(review)), ...round(narration)],
			last: silentFinish,
			expected: review,
		},
		{
			name: "reply, transient retry (agent_start), reply beside finish",
			before: [
				...round(answerMessage(review)),
				...round(failed),
				{ type: "agent_end", messages: [failed] },
				{ type: "agent_start" },
			],
			last: besideFinish,
			expected: `${review}\n\n${closing}`,
		},
		{
			name: "citation check, reply beside finish",
			before: [...round(answerMessage(review)), citationCheck],
			last: besideFinish,
			expected: `${review}\n\n${closing}`,
		},
		// No reply at all: narration is never the answer, and neither is the silent finish's own result (CLI-P49).
		{
			name: "narration only, silent finish",
			before: round(narration),
			last: silentFinish,
			expected: "",
		},
		{
			name: "a read with no text, silent finish",
			before: round(assistant("toolUse", [{ type: "toolCall", id: "r1", name: "read", arguments: {} }])),
			last: silentFinish,
			expected: "",
		},
		// An artifact's terminating result is the whole answer, in every output.
		{
			name: "reply, prose beside an artifact",
			before: round(answerMessage(review)),
			last: assistant("toolUse", [
				{ type: "text", text: "Writing the plan now." },
				{ type: "toolCall", id: "t1", name: "artifact", arguments: {} },
			]),
			expected: plan,
			extra: { terminating: { toolName: "artifact", text: plan } },
		},
	];
	for (const { name, before, last, expected, extra = { declared } } of scenarios) {
		// M-6: a finish that ended the run with no reply text is not a success: exit 1, cause no_reply_text.
		const bare = expected.length === 0 && !("terminating" in extra);
		rmSync(join(env.dir, "out.txt"), { force: true });
		const text = await writtenCallRun(undefined, last, { path: "out.txt", cwd: env.dir }, { before, ...extra });
		strictEqual(text.code, bare ? 1 : 0, `${name}: ${text.stderr}`);
		strictEqual(text.stdout, expected.length > 0 ? `${expected}\n` : "", name);
		ok(!text.stdout.includes("completion declared"), name);
		if (expected.length > 0) strictEqual(readFileSync(join(env.dir, "out.txt"), "utf8"), `${expected}\n`, name);
		else ok(!existsSync(join(env.dir, "out.txt")) || readFileSync(join(env.dir, "out.txt"), "utf8").trim() === "", name);
		const v2 = await writtenCallRun("json", last, undefined, { before, ...extra });
		const envelope = JSON.parse(v2.stdout.trim().split("\n").at(-1) ?? "{}") as {
			result?: { text?: string };
			outcome?: string;
			causes?: Array<{ code?: string }>;
		};
		strictEqual(envelope.result?.text, expected, `${name}: ${v2.stdout}`);
		strictEqual(v2.code, bare ? 1 : 0, `${name}: ${v2.stdout}`);
		strictEqual(envelope.outcome, bare ? "failed" : "succeeded", name);
		strictEqual(envelope.causes?.[0]?.code, bare ? "no_reply_text" : undefined, name);
	}
	// Tools ran and the closing message is empty: no answer anywhere, and the narration reaches only stderr.
	const closingEmpty = assistant("stop", []);
	const ran = { role: "toolResult", toolCallId: "r1", toolName: "read", isError: false, content: [] };
	const quiet = { before: round(narration), ended: [narration, ran, closingEmpty] };
	rmSync(join(env.dir, "out.txt"), { force: true });
	const text = await writtenCallRun(undefined, closingEmpty, { path: "out.txt", cwd: env.dir }, quiet);
	strictEqual(text.code, 1, text.stderr);
	strictEqual(text.stdout, "");
	ok(text.stderr.includes(`last text before the tools ran: ${note}`), text.stderr);
	ok(!existsSync(join(env.dir, "out.txt")));
	const v2 = await writtenCallRun("json", closingEmpty, undefined, quiet);
	strictEqual(v2.code, 1, v2.stderr);
	const envelope = JSON.parse(v2.stdout.trim().split("\n").at(-1) ?? "{}") as { result?: { text?: string } };
	strictEqual(envelope.result?.text, "", v2.stdout);
});

test("run --agent coder whose own check failed, or who claimed a check it never ran: the envelope, its dispatch.runs, the card, the rule and the exit code agree with the one grade (M9)", async (t) => {
	const env = await isolateClioEnv("headless-agent-compromised-");
	t.after(() => env.restore());
	const root = join(env.dir, "project");
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "input.txt"), "changed\n");
	for (const [validation, cause] of [
		// Wave-42 m9-1: the worker's own validation failed and no host check ran.
		[
			{ name: "python3 extra.py", passed: false, evidence: "exit 1" },
			/^assurance compromised: the worker's own report lists a failing validation \(python3 extra\.py\)/u,
		],
		// A command claimed as passed that the run never executed is ungrounded, and that compromises a builder too.
		[
			{ name: "npm test", passed: true, evidence: "12 passing" },
			/^assurance compromised: its result is not trusted: a validation it claims was never observed or failed; unverifiable validation: this run claimed "npm test" passed and executed no command at all/u,
		],
	] as const) {
		const { receipt } = await settleStubBuilder({
			cwd: root,
			report: {
				completion: { state: "done", limitations: [], unverified: [] },
				mutatedPaths: ["input.txt"],
				validations: [validation],
			},
		});
		strictEqual(receipt.outcome, "failed", validation.name);
		strictEqual(receipt.outcomeCode, "assurance_compromised");
		strictEqual(receipt.verdict?.assurance, "compromised");
		deepStrictEqual(
			receipt.verdict?.rules.find((entry) => entry.id === "assurance"),
			{ id: "assurance", layer: "V4", status: "fail", code: "assurance_compromised" },
		);
		match(receipt.outcomeDetail ?? "", cause);
		const summary = { count: 0, types: [], lastAssistantText: "", terminalAttemptRunId: receipt.runId };
		match(formatDispatchOutput("single", [{ receipt, summary }], 16_384), new RegExp(cause.source.slice(1), "u"));
		const exit = await mapExitCode(receipt);
		strictEqual(exit, 1);
		const stdout: string[] = [];
		const write = process.stdout.write;
		process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
			stdout.push(String(chunk));
			for (const argument of rest) if (typeof argument === "function") argument();
			return true;
		}) as typeof process.stdout.write;
		let code: number;
		try {
			code = await withRunResultV2({ format: "json", mode: "agent", agentId: "coder", verify: [] }, async () => {
				writeFrame({ type: "result", result: receipt, notRetried: "the host did not retry this failed run" } as never);
				noteAgentRunCompletion(agentRunCompletion(receipt));
				return exit;
			});
		} finally {
			process.stdout.write = write;
		}
		strictEqual(code, 1);
		const end = JSON.parse(stdout.join("").trim().split("\n").at(-1) ?? "{}") as {
			exitCode?: number;
			outcome?: string;
			notRetried?: string;
			causes?: Array<{ code?: string; exitCode?: number; message?: string }>;
			dispatch?: { runs?: Array<{ outcome?: string; outcomeCode?: string; exitCode?: number; outcomeDetail?: string }> };
		};
		strictEqual(end.exitCode, 1);
		strictEqual(end.outcome, "failed");
		// Row 371: why the assignment ran no further attempt rides run_end.
		strictEqual(end.notRetried, "the host did not retry this failed run");
		strictEqual(end.causes?.[0]?.code, "worker_failed");
		match(end.causes?.[0]?.message ?? "", cause);
		strictEqual(end.dispatch?.runs?.[0]?.outcome, "failed");
		strictEqual(end.dispatch?.runs?.[0]?.outcomeCode, "assurance_compromised");
		strictEqual(end.dispatch?.runs?.[0]?.exitCode, 1);
		match(end.dispatch?.runs?.[0]?.outcomeDetail ?? "", cause);
	}
	// Row 371: a limitation the worker recorded through its tool reaches completion.limitations, though its report's
	// own completion listed none.
	const limitedRoot = join(env.dir, "limited");
	mkdirSync(limitedRoot, { recursive: true });
	const limitation = { scope: "test/b.test.js only covers one case", reason: "environment" };
	const { receipt: limited } = await settleStubBuilder({
		cwd: limitedRoot,
		report: { mutatedPaths: [], validations: [], completion: { state: "done", limitations: [], unverified: [] } },
		events: [
			{ type: "tool_execution_start", toolCallId: "lim-1", toolName: "limitation", args: limitation },
			{ type: "tool_execution_end", toolCallId: "lim-1", toolName: "limitation", isError: false, result: {} },
			{ type: "clio_coder_tool_finish", payload: { tool: "limitation", outcome: "ok", durationMs: 1 } },
		],
	});
	deepStrictEqual(limited.recordedLimitations, [limitation]);
	deepStrictEqual(agentRunCompletion(limited).limitations, [
		{ what: "test/b.test.js only covers one case", why: "tool_unavailable" },
	]);
});
