import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { Type } from "typebox";
import { runHeadlessMainAgent } from "../../src/cli/modes/print.js";
import { BusChannels } from "../../src/core/bus-events.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { readRunJournal } from "../../src/domains/eval/metrics/invariants.js";
import {
	EMPTY_CAPABILITIES,
	type ProvidersContract,
	type RuntimeDescriptor,
} from "../../src/domains/providers/index.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import { isSessionEntry, isSessionHeader, type SessionEntry } from "../../src/domains/session/index.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { openAICompletionsApiProvider } from "../../src/engine/apis/openai-completions.js";
import { readSessionFileEntries, sessionPaths } from "../../src/engine/session.js";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import type { Model } from "../../src/engine/types.js";
import { type ChatLoopEvent, createChatLoop } from "../../src/interactive/chat-loop.js";
import { recordValue } from "../../src/interactive/chat-loop-messages.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { rehydrateChatPanelFromTurns } from "../../src/interactive/chat-renderer.js";
import { renderSessionHtml } from "../../src/interactive/export-html/index.js";
import { buildModelReplayAgentMessagesFromTurns } from "../../src/interactive/model-session-replay.js";
import { createRegistry } from "../../src/tools/registry.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

const PARTIAL = "CANCEL_PARTIAL_ONCE";
const THOUGHT = "CANCEL_THINKING_ONCE";
const target = { id: "cancellation-fixture", runtime: "litellm", url: "http://fixture.invalid:4000" };
const model = litellm.synthesizeModel(target, "unknown-cancellation-model", null) as Model<"openai-completions">;
model.reasoning = true;
const capabilities = {
	...EMPTY_CAPABILITIES,
	chat: true,
	tools: false,
	reasoning: true,
	contextWindow: 131072,
	maxTokens: 4096,
};
type WireMode = "partial" | "thinking" | "empty" | "success" | "failure" | "tool";

// Only the HTTP transport is deterministic. pi's SSE decoder, provider adapter,
// engine Agent, chat event pipeline, renderer and session writer are real.
function transport(mode: WireMode) {
	let calls = 0;
	let aborted = 0;
	let requestedResolve!: () => void;
	const requested = new Promise<void>((resolve) => {
		requestedResolve = resolve;
	});
	const fetch: typeof globalThis.fetch = async (_input, init) => {
		calls += 1;
		requestedResolve();
		if (mode === "failure")
			return new Response(
				JSON.stringify({ error: { message: "Request aborted by upstream deployment: HTTP 503", type: "server_error" } }),
				{ status: 503, headers: { "content-type": "application/json" } },
			);
		const signal = init?.signal;
		const encoder = new TextEncoder();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				const send = (delta: Record<string, unknown>, finish_reason: string | null = null) =>
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({ id: "fixture-completion", object: "chat.completion.chunk", model: model.id, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
						),
					);
				if (mode === "success" || (mode === "tool" && calls === 1)) {
					send(
						mode === "tool"
							? {
									role: "assistant",
									tool_calls: [{ index: 0, id: "cancel-tool", type: "function", function: { name: "read", arguments: "{}" } }],
								}
							: { role: "assistant", content: "PONG" },
					);
					send({}, mode === "tool" ? "tool_calls" : "stop");
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					controller.close();
					return;
				}
				const abort = () => {
					aborted += 1;
					controller.error(new DOMException("The operation was aborted", "AbortError"));
				};
				if (signal?.aborted) {
					abort();
					return;
				}
				signal?.addEventListener("abort", abort, { once: true });
				send({
					role: "assistant",
					...(mode === "partial" ? { content: PARTIAL } : mode === "thinking" ? { reasoning_content: THOUGHT } : {}),
				});
			},
		});
		return new Response(body, { headers: { "content-type": "text/event-stream" } });
	};
	return { fetch, requested, calls: () => calls, aborted: () => aborted };
}

for (const api of ["stream", "streamSimple"] as const) {
	it(`${api} preserves partial content and structured cancellation without route-failure advice`, {
		timeout: 10_000,
	}, async () => {
		const wire = transport("partial");
		const abort = new AbortController();
		const stream = openAICompletionsApiProvider[api](
			model,
			{ messages: [{ role: "user", content: "start", timestamp: 0 }] },
			{ apiKey: "fixture", signal: abort.signal, fetch: wire.fetch },
		);
		for await (const event of stream) if (event.type === "text_delta") abort.abort();
		const result = await stream.result();
		strictEqual(result.stopReason, "aborted");
		strictEqual(
			result.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join(""),
			PARTIAL,
		);
		doesNotMatch(result.errorMessage ?? "", /LiteLLM route|\/model|failed/iu);
		strictEqual(wire.calls(), 1);
		strictEqual(wire.aborted(), 1);
	});
}

it("a genuine LiteLLM failure keeps route advice even when upstream prose says aborted", {
	timeout: 10_000,
}, async () => {
	const wire = transport("failure");
	const result = await openAICompletionsApiProvider
		.streamSimple(
			model,
			{ messages: [{ role: "user", content: "start", timestamp: 0 }] },
			{ apiKey: "fixture", fetch: wire.fetch },
		)
		.result();
	strictEqual(result.stopReason, "error");
	match(result.errorMessage ?? "", /LiteLLM route.*failed/su);
	match(result.errorMessage ?? "", /Request aborted by upstream deployment/u);
	strictEqual(wire.calls(), 1, "no hidden provider retry");
});

it("an already-aborted provider request remains cancellation", { timeout: 10_000 }, async () => {
	const abort = new AbortController();
	abort.abort();
	const wire = transport("empty");
	const result = await openAICompletionsApiProvider
		.streamSimple(
			model,
			{ messages: [{ role: "user", content: "start", timestamp: 0 }] },
			{ apiKey: "fixture", signal: abort.signal, fetch: wire.fetch },
		)
		.result();
	strictEqual(result.stopReason, "aborted");
	doesNotMatch(result.errorMessage ?? "", /LiteLLM route|\/model/u);
});

let env: IsolatedClioEnv;
let previousCwd: string;
beforeEach(async () => {
	env = await isolateClioEnv("dog-cancel-");
	previousCwd = process.cwd();
	const project = join(env.dir, "project");
	mkdirSync(project);
	process.chdir(project);
});
afterEach(() => {
	process.chdir(previousCwd);
	env.restore();
});

function readFixtureEntries(path: string): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (const entry of readSessionFileEntries(path)) {
		if (isSessionHeader(entry)) continue;
		ok(isSessionEntry(entry), "fixture ledger must contain valid SessionEntry records");
		entries.push(entry);
	}
	return entries;
}

function fixture(initialMode: WireMode) {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = false;
	settings.chat.target = target.id;
	settings.chat.model = model.id;
	settings.chat.thinkingLevel = "off";
	settings.targets = [{ ...target, defaultModel: model.id }];
	const runtime: RuntimeDescriptor = {
		...litellm,
		auth: "none",
		defaultCapabilities: { ...capabilities, tools: initialMode === "tool" },
		synthesizeModel: () => ({ ...model, contextWindow: 131072, maxTokens: 4096 }),
	};
	const context = dispatchStubContext({ settings, runtime });
	const session = createSessionBundle(context).contract;
	const safety = context.getContract<SafetyContract>("safety");
	ok(safety);
	const registry = createRegistry({ safety, autonomy: () => "full-auto" });
	let toolStarted!: () => void;
	const toolRunning = new Promise<void>((resolve) => {
		toolStarted = resolve;
	});
	registry.register({
		name: ToolNames.Read,
		description: "Wait for fixture cancellation",
		parameters: Type.Object({}),
		baseActionClass: "read",
		async run(_args, options) {
			toolStarted();
			await new Promise<void>((resolve) => {
				if (options?.signal?.aborted) resolve();
				else options?.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			return { kind: "error", message: "Fixture tool cancelled" };
		},
	});
	let wire = transport(initialMode);
	const events: ChatLoopEvent[] = [];
	const audit: unknown[] = [];
	context.bus.on(BusChannels.RunAborted, (event) => {
		audit.push(event);
	});
	const panel = createChatPanel({ getOutputStyle: () => "detailed" });
	const loop = createChatLoop({
		getSettings: () => settings,
		providers: context.getContract<ProvidersContract>("providers") as ProvidersContract,
		knownTargets: () => new Set([target.id]),
		session,
		...(initialMode === "tool" ? { toolRegistry: registry } : {}),
		bus: context.bus,
		readSessionEntries: () => {
			const meta = session.current();
			return meta ? readFixtureEntries(sessionPaths(meta).current) : [];
		},
		createAgent: (options) =>
			createEngineAgent({
				...options,
				streamFn: (requestModel, requestContext, requestOptions) =>
					openAICompletionsApiProvider.streamSimple(requestModel as Model<"openai-completions">, requestContext, {
						...requestOptions,
						apiKey: "fixture",
						fetch: (...args) => wire.fetch(...args),
					}),
			}),
	});
	loop.onEvent((event) => {
		events.push(event);
		panel.applyEvent(event);
	});
	return {
		loop,
		panel,
		session,
		events,
		audit,
		toolRunning,
		wire: () => wire,
		next() {
			wire = transport("success");
		},
		entries() {
			const meta = session.current();
			ok(meta);
			return readFixtureEntries(sessionPaths(meta).current);
		},
		async close() {
			loop.dispose();
			await loop.whenSettled();
			await session.close();
		},
	};
}

for (const mode of ["partial", "thinking", "empty"] as const) {
	it(`${mode} cancellation closes once and remains usable live, after resume, and in export`, {
		timeout: 15_000,
	}, async () => {
		const f = fixture(mode);
		try {
			const started = new Promise<void>((resolve) =>
				f.loop.onEvent((event) => {
					if (
						(mode === "partial" && event.type === "text_delta") ||
						(mode === "thinking" && event.type === "thinking_delta") ||
						(mode === "empty" && event.type === "message_start" && event.message.role === "assistant")
					)
						resolve();
				}),
			);
			const pending = f.loop.submit("Start streaming");
			await started;
			f.loop.cancel();
			await pending;
			const assistants = f.entries().filter((entry) => entry.kind === "message" && entry.role === "assistant");
			strictEqual(assistants.length, 1, JSON.stringify(assistants));
			const assistant = assistants[0];
			ok(assistant?.kind === "message");
			const payload = recordValue(assistant.payload);
			ok(payload);
			strictEqual(payload.stopReason, "aborted");
			const usage = recordValue(payload.usage);
			ok(usage);
			strictEqual(usage.estimated, true);
			if (mode !== "empty") ok(Number(usage.output) > 0);
			const serialized = JSON.stringify(assistant);
			doesNotMatch(serialized, /LiteLLM route|\/model/u);
			if (mode === "partial") match(serialized, new RegExp(PARTIAL));
			if (mode === "thinking") match(serialized, new RegExp(THOUGHT));
			strictEqual(f.wire().calls(), 1);
			strictEqual(f.audit.length, 1);
			const live = f.panel.render(120).map(stripTerminalSequences).join("\n");
			if (mode === "partial") strictEqual(live.split(PARTIAL).length - 1, 1, live);
			match(live, /cancelled/iu);
			doesNotMatch(live, /LiteLLM route|\/model/u);

			const replay = createChatPanel({ getOutputStyle: () => "detailed" });
			rehydrateChatPanelFromTurns(replay, f.entries());
			const resumedLines = replay.render(120);
			const resumed = resumedLines.map(stripTerminalSequences).join("\n");
			if (mode === "partial") strictEqual(resumed.split(PARTIAL).length - 1, 1, resumed);
			if (mode === "thinking") strictEqual(resumed.split(THOUGHT).length - 1, 1, resumed);
			match(resumed, /cancelled/iu);
			doesNotMatch(resumed, /LiteLLM route|\/model/u);
			const meta = f.session.current();
			ok(meta);
			const html = renderSessionHtml({ sessionId: meta.id, exportedAt: "2026-09-07T00:00:00Z", ansiLines: resumedLines });
			if (mode === "partial") strictEqual(html.split(PARTIAL).length - 1, 1);
			doesNotMatch(html, /LiteLLM route|\/model/u);
			f.next();
			await f.loop.submit("Next prompt");
			match(f.panel.render(120).map(stripTerminalSequences).join("\n"), /PONG/u);
			await f.session.close();
			f.session.resume(meta.id);
			f.loop.resetForSession(f.session.tree().leafId, buildModelReplayAgentMessagesFromTurns(f.entries()));
			await f.loop.submit("After resume");
			const after = f.entries().filter((entry) => entry.kind === "message" && entry.role === "assistant");
			strictEqual(after.length, 3);
		} finally {
			await f.close();
		}
	});
}

it("loop-guard interruption keeps its own reason on the single partial assistant", { timeout: 15_000 }, async () => {
	const f = fixture("partial");
	try {
		f.loop.onEvent((event) => {
			if (event.type === "text_delta")
				f.loop.cancel({ source: "loop_guard", reason: "[Clio Coder] loop guard stopped repeated calls." });
		});
		await f.loop.submit("Start");
		const assistants = f.entries().filter((entry) => entry.kind === "message" && entry.role === "assistant");
		strictEqual(assistants.length, 1);
		match(JSON.stringify(assistants[0]), /loop guard stopped repeated calls/u);
		match(JSON.stringify(assistants[0]), new RegExp(PARTIAL));
		doesNotMatch(JSON.stringify(assistants[0]), /active response cancelled|LiteLLM route/u);
	} finally {
		await f.close();
	}
});

it("a tool cancellation persists its result before exactly one closing assistant and permits the next turn", {
	timeout: 15_000,
}, async () => {
	const f = fixture("tool");
	try {
		const pending = f.loop.submit("Use read");
		await f.toolRunning;
		f.loop.cancel();
		await pending;
		const entries = f.entries();
		const call = entries.findIndex((entry) => entry.kind === "message" && entry.role === "tool_call");
		const result = entries.findIndex((entry) => entry.kind === "message" && entry.role === "tool_result");
		const closings = entries.filter(
			(entry) =>
				entry.kind === "message" && entry.role === "assistant" && recordValue(entry.payload)?.stopReason === "aborted",
		);
		strictEqual(closings.length, 1);
		const closing = closings[0];
		ok(closing);
		ok(call >= 0 && result > call && entries.indexOf(closing) > result, JSON.stringify(entries));
		doesNotMatch(JSON.stringify(entries), /LiteLLM route|\/model/u);
		f.next();
		await f.loop.submit("Next");
		match(f.panel.render(120).map(stripTerminalSequences).join("\n"), /PONG/u);
	} finally {
		await f.close();
	}
});

it("the real chat loop persists and displays one genuine gateway failure without retrying it", {
	timeout: 15_000,
}, async () => {
	const f = fixture("failure");
	try {
		await f.loop.submit("Start");
		const assistants = f.entries().filter((entry) => entry.kind === "message" && entry.role === "assistant");
		strictEqual(assistants.length, 1);
		match(JSON.stringify(assistants), /LiteLLM route.*failed/su);
		strictEqual(f.wire().calls(), 1);
		strictEqual(f.audit.length, 0);
		f.next();
		await f.loop.submit("Next");
		match(f.panel.render(120).map(stripTerminalSequences).join("\n"), /PONG/u);
	} finally {
		await f.close();
	}
});

it("headless shutdown retains its cancelled receipt and exit 143 without route advice", {
	timeout: 15_000,
}, async (t) => {
	const output: string[] = [];
	t.mock.method(process.stdout, "write", (chunk: string, callback?: () => void) => {
		output.push(String(chunk));
		callback?.();
		return true;
	});
	t.mock.method(process.stderr, "write", () => true);
	const f = fixture("partial");
	let shuttingDown = false;
	let drain: (() => void | Promise<void>) | undefined;
	f.loop.onEvent((event) => {
		if (event.type === "text_delta") {
			shuttingDown = true;
			f.loop.cancel();
		}
	});
	try {
		const code = await runHeadlessMainAgent(f.loop, {
			prompt: "Start",
			mode: "json",
			shutdown: {
				onDrain: (hook) => {
					drain = hook;
				},
				getExitCode: () => (shuttingDown ? 143 : 0),
				isShuttingDown: () => shuttingDown,
			},
		});
		await drain?.();
		strictEqual(code, 143);
		const journal = readRunJournal(join(env.dir, "state"));
		ok(journal);
		strictEqual(journal.receipts.length, 1);
		deepStrictEqual([journal.receipts[0]?.outcome, journal.receipts[0]?.exitCode], ["canceled", 143]);
		doesNotMatch(output.join(""), /LiteLLM route|\/model/u);
	} finally {
		await f.close();
	}
});
