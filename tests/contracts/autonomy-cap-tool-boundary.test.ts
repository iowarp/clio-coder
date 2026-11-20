import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { Type } from "typebox";
import { runHeadlessMainAgent } from "../../src/cli/modes/print.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { clioStateDir } from "../../src/core/xdg.js";
import {
	EMPTY_CAPABILITIES,
	type ProvidersContract,
	type RuntimeDescriptor,
} from "../../src/domains/providers/index.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import { loadSessionTelemetrySource } from "../../src/domains/session/telemetry-source.js";
import { readCallJournal } from "../../src/domains/telemetry/call-journal.js";
import type { TelemetryContract } from "../../src/domains/telemetry/contract.js";
import { telemetrySessionDirectory } from "../../src/domains/telemetry/paths.js";
import { whyStopped } from "../../src/domains/telemetry/read-model.js";
import { createSessionJournals } from "../../src/domains/telemetry/session-journals.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { openAICompletionsApiProvider } from "../../src/engine/apis/openai-completions.js";
import type { Model } from "../../src/engine/types.js";
import { type ChatLoop, type ChatLoopEvent, createChatLoop } from "../../src/session-control/chat-loop.js";
import { createRegistry } from "../../src/tools/registry.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

// F-C16: the yolo cap halt aborted an extension's record write in flight. A
// stop deferred to the tool boundary lets the started call finish and ends
// the turn before its next model request.

const target = { id: "cap-boundary-fixture", runtime: "litellm", url: "http://fixture.invalid:4000" };
const model = litellm.synthesizeModel(target, "cap-boundary-model", null) as Model<"openai-completions">;
const CAP_REASON = "[CLIO Coder] yolo paused: the 5M-token cap was reached.";

let env: IsolatedClioEnv;
let previousCwd: string;
beforeEach(async () => {
	env = await isolateClioEnv("cap-boundary-");
	previousCwd = process.cwd();
	const project = join(env.dir, "project");
	mkdirSync(project);
	process.chdir(project);
});
afterEach(() => {
	process.chdir(previousCwd);
	env.restore();
});

/**
 * The first `toolRounds` requests each ask for one tool call; any later request answers with `reply`, or with the
 * next of a list of replies. Each request's tool count and tool_choice are kept.
 */
function transport(toolRounds = 1, reply: string | ReadonlyArray<string> = "PONG") {
	let calls = 0;
	const requests: Array<{ tools: number; toolChoice: unknown }> = [];
	const fetch: typeof globalThis.fetch = async (_input, init) => {
		calls += 1;
		const sent = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
			tools?: unknown[];
			tool_choice?: unknown;
		};
		requests.push({ tools: sent.tools?.length ?? 0, toolChoice: sent.tool_choice });
		const text = typeof reply === "string" ? reply : (reply[Math.min(calls - toolRounds - 1, reply.length - 1)] ?? "");
		const encoder = new TextEncoder();
		const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) =>
			encoder.encode(
				`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: model.id, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
			);
		const first = calls <= toolRounds;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					chunk(
						first
							? {
									role: "assistant",
									tool_calls: [
										{ index: 0, id: `record-${calls}`, type: "function", function: { name: "read", arguments: "{}" } },
									],
								}
							: { role: "assistant", content: text },
					),
				);
				controller.enqueue(chunk({}, first ? "tool_calls" : "stop"));
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
			},
		});
		return new Response(body, { headers: { "content-type": "text/event-stream" } });
	};
	return { fetch, calls: () => calls, requests };
}

/** A real engine and session journal over the fixture wire, with `run` standing in for the read tool. */
function fixture(
	toolRounds: number,
	run: (loop: ChatLoop, signal: AbortSignal | undefined) => Promise<void>,
	reply?: string | ReadonlyArray<string>,
	/** Keep the turn runtime's own stream (tool rounds and tool_choice) and swap only its fetch. */
	throughToolRounds = false,
) {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = false;
	settings.chat.target = target.id;
	settings.chat.model = model.id;
	settings.chat.thinkingLevel = "off";
	settings.targets = [{ ...target, defaultModel: model.id }];
	const runtime: RuntimeDescriptor = {
		...litellm,
		auth: "none",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true, contextWindow: 131072, maxTokens: 4096 },
		synthesizeModel: () => ({ ...model, input: ["text"], contextWindow: 131072, maxTokens: 4096 }),
	};
	const context = dispatchStubContext({ settings, runtime });
	const session = createSessionBundle(context).contract;
	const safety = context.getContract("safety");
	ok(safety);
	const registry = createRegistry({ safety, autonomy: () => "yolo" });
	const wire = transport(toolRounds, reply);
	const journals = createSessionJournals(clioStateDir(), () => {
		throw new Error("fixture journal unavailable");
	});
	const loop: ChatLoop = createChatLoop({
		telemetry: { acquireTelemetrySession: journals.acquire } as unknown as TelemetryContract,
		getSettings: () => settings,
		providers: context.getContract("providers") as ProvidersContract,
		knownTargets: () => new Set([target.id]),
		session,
		readSessionEntries: () => session.readEntries(),
		toolRegistry: registry,
		bus: context.bus,
		createAgent: (options) =>
			createEngineAgent(
				throughToolRounds && options?.transcriptStreamFn !== undefined
					? {
							...options,
							transcriptStreamFn: (
								(stream) => (requestModel, requestContext, requestOptions) =>
									stream(requestModel, requestContext, {
										...requestOptions,
										apiKey: "fixture",
										fetch: (...args) => wire.fetch(...args),
									})
							)(options.transcriptStreamFn),
						}
					: {
							...options,
							streamFn: (requestModel, requestContext, requestOptions) =>
								openAICompletionsApiProvider.streamSimple(requestModel as Model<"openai-completions">, requestContext, {
									...requestOptions,
									apiKey: "fixture",
									fetch: (...args) => wire.fetch(...args),
								}),
						},
			),
	});
	registry.register({
		name: ToolNames.Read,
		description: "Stands in for an extension record write or a bash command a stop lands during",
		parameters: Type.Object({}),
		baseActionClass: "read",
		async run(_args, options) {
			await run(loop, options?.signal);
			return { kind: "ok", output: "recorded" };
		},
	});
	/** The session's journal once flushed, and the turns it settled. */
	const journal = async () => {
		await journals.flush();
		const sessionId = session.current()?.id;
		ok(sessionId);
		const read = await readCallJournal(telemetrySessionDirectory(clioStateDir(), sessionId));
		const settled = <K extends "turn.settled" | "call.settled">(k: K) =>
			read.records.flatMap(({ record }) =>
				record.k === k ? [record.data as Extract<typeof record, { k: K }>["data"]] : [],
			);
		return { sessionId, turns: settled("turn.settled"), calls: settled("call.settled") };
	};
	const close = async () => {
		loop.dispose();
		await loop.whenSettled();
		await session.close();
	};
	return { loop, wire, journal, close, settings, bus: context.bus };
}

it("a cap halt during a tool call lets the call finish and sends no further model request", {
	timeout: 10_000,
}, async () => {
	const tool = { started: false, completed: false, sawAbort: false };
	const f = fixture(1, async (loop, signal) => {
		tool.started = true;
		// The window latches inside the call that crossed the line, as the orchestrator's onHalt does.
		loop.cancel({ reason: CAP_REASON, source: "autonomy", auditReason: "autonomous-cap", atToolBoundary: true });
		await new Promise((resolve) => setTimeout(resolve, 20));
		tool.sawAbort = signal?.aborted === true;
		tool.completed = true;
	});
	const events: ChatLoopEvent[] = [];
	f.loop.onEvent((event) => {
		events.push(event);
	});
	try {
		await f.loop.submit("Record the section.");
		await f.loop.whenSettled();
		ok(tool.started);
		ok(tool.completed);
		strictEqual(tool.sawAbort, false);
		const ended = events.find(
			(event) => event.type === "tool_execution_end" && (event as { toolCallId?: string }).toolCallId === "record-1",
		) as { isError?: boolean } | undefined;
		strictEqual(ended?.isError, false);
		strictEqual(f.wire.calls(), 1);
		ok(
			events.some((event) => event.type === "notice" && (event as { text?: string }).text === CAP_REASON),
			"the turn closes with the cap's notice",
		);
		// The cap is the harness's own stop, named on the turn's settlement (bt-26 N2d). It landed at the tool
		// boundary after the call ended, so no stage of that call reads as cut (bt-26 N2f), and why-stopped says
		// so from that call's toolUse though the turn itself settles aborted (bt-26 N2g).
		const { sessionId, turns } = await f.journal();
		deepStrictEqual(
			turns.map((turn) => [turn.stopReason, turn.terminal.cause, turn.terminal.stage]),
			[["aborted", "autonomy_stop", null]],
		);
		const source = loadSessionTelemetrySource(clioStateDir(), sessionId);
		ok(source);
		const findings = whyStopped(source).findings;
		ok(findings.includes("The last turn stopped (aborted) on autonomy_stop at the tool boundary."), findings.join("\n"));
	} finally {
		await f.close();
	}
});

it("a headless yolo run whose turn budget rolls at the tool boundary exits 0 on the continuation's answer (XR-6)", {
	timeout: 10_000,
}, async () => {
	// The roll's deferred loop-guard stop closes the turn as interrupted; that closing record must not end the run.
	const f = fixture(1, async () => {
		f.bus.emit("safety.tool_budget_exceeded", {
			tool: "read",
			callsThisTurn: 9,
			softBudget: 8,
			hardCeiling: 23,
			interrupted: false,
			at: Date.now(),
			rolled: true,
		});
	});
	f.settings.safety.autonomy = "yolo";
	const events: ChatLoopEvent[] = [];
	f.loop.onEvent((event) => {
		events.push(event);
	});
	try {
		const code = await runHeadlessMainAgent(f.loop, {
			prompt: "Read the files.",
			mode: "text",
			shutdown: { onDrain() {}, getExitCode: () => 0, isShuttingDown: () => false },
		});
		strictEqual(code, 0);
		strictEqual(f.wire.calls(), 2);
		const closing = events.find(
			(event) =>
				event.type === "notice" &&
				(event as { key?: string; surface?: string }).key === "turn.interrupted" &&
				(event as { surface?: string }).surface === "transcript",
		) as { text?: string; redirect?: true } | undefined;
		ok(closing?.text?.includes("Turn budget rolled"), JSON.stringify(closing));
		strictEqual(closing?.redirect, true);
	} finally {
		await f.close();
	}
});

it("a scheduled job's clock ending a turn mid-tool names job_clock as the stop, not an internal abort (SC-2)", {
	timeout: 10_000,
}, async () => {
	const f = fixture(1, async (loop, signal) => {
		loop.cancel({ reason: "Scheduled job occurrence ended.", source: "job_clock", auditReason: "job occurrence ended" });
		await new Promise((resolve) => setTimeout(resolve, 20));
		ok(signal?.aborted === true);
	});
	try {
		await f.loop.submit("Record the section.");
		await f.loop.whenSettled();
		const { turns, calls } = await f.journal();
		deepStrictEqual(
			turns.map((turn) => turn.terminal.cause),
			["job_clock"],
		);
		ok(
			calls.every((call) => call.stop?.failure !== "internal"),
			JSON.stringify(calls.map((call) => call.stop)),
		);
	} finally {
		await f.close();
	}
});

it("a headless --timeout during a tool after a steer settles the turn on shutdown with every call it opened", {
	timeout: 10_000,
}, async () => {
	// The steer files its own user entry and moves the active turn id; the follow-up call the shutdown leaves unsent
	// was leased under it, and the run's turn still settles with that call and its cause (bt-26 N2h).
	let shuttingDown = false;
	let rounds = 0;
	const f = fixture(2, async (loop) => {
		rounds += 1;
		if (rounds === 1) ok(loop.steer("Also check the docs."));
		else {
			// A `run --timeout` deadline reaches the loop as the composition root's drain disposing it.
			shuttingDown = true;
			loop.dispose();
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	try {
		const code = await runHeadlessMainAgent(f.loop, {
			prompt: "Record the section.",
			mode: "text",
			shutdown: { onDrain() {}, getExitCode: () => (shuttingDown ? 124 : 0), isShuttingDown: () => shuttingDown },
		});
		strictEqual(code, 124);
		strictEqual(f.wire.calls(), 2);
		const { turns, calls } = await f.journal();
		strictEqual(calls.length, 3);
		deepStrictEqual(
			[calls.at(-1)?.disposition, calls.at(-1)?.stop],
			["never_sent", { reason: "aborted", failure: "shutdown" }],
		);
		deepStrictEqual(
			turns.map((turn) => [turn.stopReason, turn.terminal.cause, turn.terminal.callIds]),
			[["aborted", "shutdown", calls.map((call) => call.callId)]],
		);
	} finally {
		await f.close();
	}
});

it("run --output-schema's repair turn goes out text-only with its tool list kept; an answer turn with tools does not", {
	timeout: 10_000,
}, async () => {
	// SPEC L5: the second request carries no callable tool (tool_choice none) and the same tools for the cache prefix (D8).
	const f = fixture(0, async () => {}, ["not json", '{"fixed":true}', "plain answer"], true);
	try {
		const code = await runHeadlessMainAgent(f.loop, {
			prompt: "Is it fixed?",
			mode: "text",
			outputSchema: { type: "object", properties: { fixed: { type: "boolean" } }, required: ["fixed"] },
			shutdown: { onDrain() {}, getExitCode: () => 0, isShuttingDown: () => false },
		});
		strictEqual(code, 0);
		strictEqual(f.wire.calls(), 2);
		const [first, repair] = f.wire.requests;
		ok(first && repair);
		ok(first.toolChoice !== "none", JSON.stringify(first));
		strictEqual(repair.toolChoice, "none", JSON.stringify(f.wire.requests));
		strictEqual(repair.tools, first.tools);
		ok(repair.tools > 0);
		// An ordinary answer-mode turn that keeps its tools is not locked.
		await f.loop.submit("Answer plainly.", { constraints: { mode: "answer" } });
		await f.loop.whenSettled();
		strictEqual(f.wire.calls(), 3);
		ok(f.wire.requests[2]?.toolChoice !== "none", JSON.stringify(f.wire.requests[2]));
	} finally {
		await f.close();
	}
});

it("a turn that keeps writing its tool call as text settles failed with the reason, and why-stopped names it", {
	timeout: 10_000,
}, async () => {
	// bt-session-res J1: past the re-prompt cap the run fails on tool-call markup; why-stopped read "ended normally".
	const f = fixture(
		0,
		async () => {},
		'Reading part 5 next. <tool_call id="x" name="read">{"path": "notes.txt"}</tool_call>',
	);
	try {
		await f.loop.submit("Read the notes.");
		await f.loop.whenSettled();
		strictEqual(f.wire.calls(), 4);
		const { sessionId, turns } = await f.journal();
		deepStrictEqual(
			turns.map((turn) => [turn.stopReason, turn.terminal.cause, turn.terminal.noAnswer]),
			[["stop", null, "tool_call_announced"]],
		);
		const source = loadSessionTelemetrySource(clioStateDir(), sessionId);
		ok(source);
		const why = whyStopped(source);
		strictEqual(why.lastTurn?.noAnswer, "tool_call_announced");
		ok(!why.findings.some((line) => line.includes("ended normally")), why.findings.join("\n"));
		ok(
			why.findings.includes(
				"The last turn failed without an answer (stop, tool_call_announced): the model said what it would do next and wrote the call as plain text (tool-call markup), so nothing ran.",
			),
			why.findings.join("\n"),
		);
	} finally {
		await f.close();
	}
});
