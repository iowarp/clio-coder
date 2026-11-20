import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { prefixHeadlessFailure, runHeadlessMainAgent } from "../../src/cli/modes/print.js";
import { completionExitCode, withRunFailureReporting, withRunResultV2 } from "../../src/cli/run-failure.js";
import { finishRunResult } from "../../src/domains/dispatch/run-settlement.js";
import { CITATION_CHECK_PREFIX } from "../../src/domains/safety/citation-grounding.js";
import type { ChatLoopRunSnapshot } from "../../src/session-control/chat-loop.js";
import { CONTEXT_OVERFLOW_STOP_NOTICE_KEY } from "../../src/session-control/chat-loop-messages.js";
import { formatDispatchOutput } from "../../src/tools/dispatch-runner.js";
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
	format?: "json",
	override?: Record<string, unknown>,
	output?: { path: string; cwd: string },
	extra: {
		snapshot?: Partial<ChatLoopRunSnapshot>;
		after?: object[];
		exitCode?: true;
		declared?: Record<string, unknown>;
	} = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	let handler: (event: unknown) => void = () => {};
	const reply = override ?? {
		...answerMessage(
			'The file holds 50 data rows.\n<tool_call>{"name":"read","arguments":{"path":"data.csv"}}</tool_call>',
		),
		clioCoderWrittenCalls: ["read"],
	};
	const stub: Record<string, unknown> = {
		onEvent: (next: (event: unknown) => void) => {
			handler = next;
			return () => {};
		},
		getSessionId: () => null,
		submit: async () => {
			handler({ type: "agent_start" });
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
			handler({ type: "turn_end", message: reply, toolResults: [] });
			handler({ type: "agent_end", messages: [reply] });
			for (const event of extra.after ?? []) handler(event);
		},
		whenSettled: async () => {},
		lastRunSnapshot: () => extra.snapshot ?? null,
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
	deepStrictEqual(last(v2.stdout).completion, { state: "not_done", declared: true });
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
	deepStrictEqual(last(partly.stdout).completion, { state: "partly_done", declared: true });
	const done = await writtenCallRun("json", declining, undefined, { exitCode: true, declared: { state: "done" } });
	strictEqual(done.code, 0, done.stderr);
	// A plain answer declares nothing: declared false, exit 0 with or without the flag. Reply text is never read.
	const plain = await writtenCallRun("json", answerMessage("Not done.") as Record<string, unknown>, undefined, {
		exitCode: true,
	});
	strictEqual(plain.code, 0, plain.stderr);
	deepStrictEqual(last(plain.stdout).completion, { state: "unknown", declared: false });
});
