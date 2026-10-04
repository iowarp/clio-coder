import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { Type } from "typebox";
import { runHeadlessMainAgent } from "../../src/cli/modes/print.js";
import { BusChannels } from "../../src/core/bus-events.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { ToolNames } from "../../src/core/tool-names.js";
import {
	EMPTY_CAPABILITIES,
	type ProvidersContract,
	type RuntimeDescriptor,
} from "../../src/domains/providers/index.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import type { VisionSidecar } from "../../src/domains/providers/vision-sidecar.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import { isSessionEntry, isSessionHeader, type SessionEntry } from "../../src/domains/session/index.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { openAICompletionsApiProvider } from "../../src/engine/apis/openai-completions.js";
import { readSessionFileEntries, sessionPaths } from "../../src/engine/session.js";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import type { Model } from "../../src/engine/types.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { rehydrateChatPanelFromTurns } from "../../src/interactive/chat-renderer.js";
import { renderSessionHtml } from "../../src/interactive/export-html/index.js";
import { expandInteractiveSubmitAsync } from "../../src/interactive/interactive-application.js";
import { buildSummary } from "../../src/interactive/status/summary.js";
import { resolveFooterVerb } from "../../src/interactive/status/verbs.js";
import { clioTheme, GLYPH } from "../../src/interactive/theme/index.js";
import { type ChatLoopEvent, createChatLoop } from "../../src/session-control/chat-loop.js";
import { recordValue } from "../../src/session-control/chat-loop-messages.js";
import { buildModelReplayAgentMessagesFromTurns } from "../../src/session-control/model-session-replay.js";
import { INITIAL_STATUS } from "../../src/session-control/status-types.js";
import { createRegistry } from "../../src/tools/registry.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { readRunJournal } from "../harness/run-journal.js";
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
type WireMode = "partial" | "thinking" | "empty" | "success" | "failure" | "tool" | "guard";

// Only the HTTP transport is deterministic. pi's SSE decoder, provider adapter,
// engine Agent, chat event pipeline, renderer and session writer are real.
function transport(mode: WireMode) {
	let calls = 0;
	let aborted = 0;
	const requestBodies: string[] = [];
	let requestedResolve!: () => void;
	const requested = new Promise<void>((resolve) => {
		requestedResolve = resolve;
	});
	const fetch: typeof globalThis.fetch = async (_input, init) => {
		calls += 1;
		requestBodies.push(String(init?.body ?? ""));
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
				if (mode === "guard") {
					send({
						role: "assistant",
						tool_calls: [
							{
								index: 0,
								id: "guard-tool",
								type: "function",
								function: {
									name: "read",
									arguments: JSON.stringify({ content: "x".repeat(2 * 1024 * 1024) }),
								},
							},
						],
					});
					return;
				}
				send({
					role: "assistant",
					...(mode === "partial" ? { content: PARTIAL } : mode === "thinking" ? { reasoning_content: THOUGHT } : {}),
				});
			},
		});
		return new Response(body, { headers: { "content-type": "text/event-stream" } });
	};
	return { fetch, requested, calls: () => calls, aborted: () => aborted, requestBodies: () => requestBodies };
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

function fixture(initialMode: WireMode, readTurn?: () => void, visionSidecar?: VisionSidecar, visionCapable = false) {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = false;
	settings.chat.target = target.id;
	settings.chat.model = model.id;
	settings.chat.thinkingLevel = "off";
	settings.targets = [{ ...target, defaultModel: model.id }];
	if (visionCapable && settings.targets[0]) settings.targets[0].capabilities = { vision: true };
	const runtime: RuntimeDescriptor = {
		...litellm,
		auth: "none",
		defaultCapabilities: {
			...capabilities,
			tools: initialMode === "tool" || initialMode === "guard",
			vision: visionCapable,
		},
		synthesizeModel: () => ({
			...model,
			input: visionCapable ? ["text", "image"] : ["text"],
			contextWindow: 131072,
			maxTokens: 4096,
		}),
	};
	const context = dispatchStubContext({ settings, runtime });
	const session = createSessionBundle(context).contract;
	const safety = context.getContract<SafetyContract>("safety");
	ok(safety);
	const registry = createRegistry({ safety, autonomy: () => "yolo" });
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
		...(visionSidecar ? { visionSidecar } : {}),
		...(readTurn ? { readTurn } : {}),
		providers: context.getContract<ProvidersContract>("providers") as ProvidersContract,
		knownTargets: () => new Set([target.id]),
		session,
		...(initialMode === "tool" || initialMode === "guard" ? { toolRegistry: registry } : {}),
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

it("starts the decision brief once per operator turn and never holds the chat request on it", {
	timeout: 10_000,
}, async () => {
	let briefs = 0;
	const h = fixture("success", () => {
		briefs += 1;
	});
	try {
		await h.loop.submit("The brief is started, not awaited.");
		strictEqual(briefs, 1);
		strictEqual(h.wire().calls(), 1, "the turn reached the chat model");

		await h.loop.submit("A later turn starts its own brief.");
		strictEqual(briefs, 2);
		strictEqual(h.wire().calls(), 2);
	} finally {
		await h.close();
	}
});

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

it("the argument guard remains visible live and after persistence without an operator cancel or retry", {
	timeout: 15_000,
}, async () => {
	const f = fixture("guard");
	try {
		await f.loop.submit("Start");
		strictEqual(f.wire().calls(), 1);
		strictEqual(f.wire().aborted(), 1);
		strictEqual(f.events.filter((event) => event.type === "retry_status").length, 0);
		strictEqual(f.events.filter((event) => event.type === "tool_execution_start").length, 0);
		const assistants = f.entries().filter((entry) => entry.kind === "message" && entry.role === "assistant");
		strictEqual(assistants.length, 1);
		const persisted = assistants[0];
		ok(persisted?.kind === "message");
		const payload = recordValue(persisted.payload);
		ok(payload);
		strictEqual(payload.stopReason, "aborted");
		strictEqual(payload.clioCoderAbortReason, "tool_argument_generation");
		match(String(payload.errorMessage), /byte safety ceiling/);
		const replay = createChatPanel({ getOutputStyle: () => "detailed" });
		rehydrateChatPanelFromTurns(replay, f.entries());
		for (const panel of [f.panel, replay]) {
			const rendered = panel.render(120).map(stripTerminalSequences).join("\n");
			match(rendered, /Tool argument generation stopped/);
			match(rendered, /byte safety ceiling/);
			doesNotMatch(rendered, /Cancelled at your request|\bCancelled\b|provider retry/);
		}
		const end = f.events.filter((event) => event.type === "agent_end").at(-1);
		ok(end?.type === "agent_end");
		const summary = buildSummary({
			startedAt: 1,
			endedAt: 2,
			modelId: model.id,
			targetId: target.id,
			messages: end.messages,
			watchdogPeak: 0,
			cancelled: false,
		});
		strictEqual(summary.stopReason, "generation_guard");
		match(resolveFooterVerb({ ...INITIAL_STATUS, phase: "ended", summary }, 2, 120)?.text ?? "", /Generation stopped/);
		f.next();
		await f.loop.submit("Next prompt");
		match(f.panel.render(120).map(stripTerminalSequences).join("\n"), /PONG/);
	} finally {
		await f.close();
	}
});

// BT-013: the footer settles an operator cancel as `⊘ cancelled`, so the
// transcript row closing the same hollow turn carries that mark in `dim`. A
// loop-guard stop is Clio stopping a runaway turn, a warning, and keeps `⚠`.
for (const source of ["stream_cancel", "loop_guard"] as const) {
	const title =
		source === "stream_cancel"
			? "an operator cancel closes its hollow turn with the cancelled mark the footer uses"
			: "a loop-guard stop closes its hollow turn with the warning mark";
	it(title, { timeout: 15_000 }, async () => {
		const f = fixture("empty");
		try {
			const started = new Promise<void>((resolve) =>
				f.loop.onEvent((event) => {
					if (event.type === "message_start" && event.message.role === "assistant") resolve();
				}),
			);
			const pending = f.loop.submit("Start streaming");
			await started;
			if (source === "stream_cancel") f.loop.cancel();
			else f.loop.cancel({ source, reason: "[Clio Coder] loop guard stopped repeated calls." });
			await pending;
			const rows = f.panel.render(120);
			const live = rows.map(stripTerminalSequences).join("\n");
			const theme = clioTheme();
			if (source === "stream_cancel") {
				// The Cancelled outcome is the one report of an Esc.
				match(live, /⊘ Cancelled\b/u);
				strictEqual(live.split("Cancelled").length - 1, 1, live);
				doesNotMatch(live, /\[aborted\]|active response cancelled/u);
				doesNotMatch(live, new RegExp(GLYPH.warn, "u"));
				const row = rows.find((line) => stripTerminalSequences(line).includes("Cancelled"));
				ok(row?.includes(GLYPH.cancelled), row);
			} else {
				match(live, /! loop guard stopped repeated calls\./u);
				const row = rows.find((line) => stripTerminalSequences(line).includes("loop guard stopped"));
				ok(row?.includes(`${theme.fg("warning", GLYPH.warn)} `), row);
			}
		} finally {
			await f.close();
		}
	});
}

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

it("a text-only route refuses an image before the provider receives bytes", { timeout: 15_000 }, async () => {
	const f = fixture("success");
	const notices: string[] = [];
	f.loop.onEvent((event) => {
		if (event.type === "notice" && event.admission?.reason === "image-input-unsupported") notices.push(event.text);
	});
	try {
		writeFileSync(
			join(process.cwd(), "pixel.png"),
			Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==",
				"base64",
			),
		);
		const expanded = await expandInteractiveSubmitAsync("Inspect @pixel.png", undefined, process.cwd());
		strictEqual(expanded.images.length, 1);
		await f.loop.submit(expanded.text, { images: expanded.images });
		strictEqual(f.wire().calls(), 0);
		strictEqual(notices.length, 1);
		match(notices[0] ?? "", /IMAGE_INPUT_UNSUPPORTED.*cancellation-fixture\/unknown-cancellation-model/u);
		strictEqual(f.session.current(), null);
	} finally {
		await f.close();
	}
});

it("a text-only route uses the vision sidecar while keeping the original image in session history", {
	timeout: 15_000,
}, async () => {
	const asked: string[] = [];
	const sidecar: VisionSidecar = {
		configured: () => true,
		label: () => "MiniCPM-V-4.6",
		analyze: async (_images, question) => {
			asked.push(question);
			return {
				target: "mini-vision",
				model: "MiniCPM-V-4.6",
				images: [{ index: 1, description: "A white pixel" }],
				answer: "white",
			};
		},
	};
	const f = fixture("success", undefined, sidecar);
	try {
		const image = { type: "image" as const, mimeType: "image/png", data: "SIDECAR_IMAGE_SENTINEL" };
		await f.loop.submit("What color is this?", { images: [image] });
		strictEqual(f.wire().calls(), 1);
		strictEqual(asked.length, 1);
		strictEqual(asked[0], "What color is this?");
		const body = f.wire().requestBodies()[0] ?? "";
		doesNotMatch(body, /SIDECAR_IMAGE_SENTINEL|image_url/u);
		match(body, /A white pixel/u);
		match(body, /untrusted image observation/u);
		ok(f.events.some((event) => event.type === "notice" && /Processing image with MiniCPM-V-4\.6/u.test(event.text)));
		const user = f.entries().find((entry) => entry.kind === "message" && entry.role === "user");
		ok(user && user.kind === "message");
		match(JSON.stringify(user.payload), /SIDECAR_IMAGE_SENTINEL/u);
		match(JSON.stringify(user.payload), /A white pixel/u);
	} finally {
		await f.close();
	}
});

it("an image-only submission asks the sidecar for a description", { timeout: 15_000 }, async () => {
	let question = "";
	const f = fixture("success", undefined, {
		configured: () => true,
		label: () => "MiniCPM-V-4.6",
		analyze: async (_images, prompt) => {
			question = prompt;
			return {
				target: "mini-vision",
				model: "MiniCPM-V-4.6",
				images: [{ index: 1, description: "a pixel" }],
				answer: "a pixel",
			};
		},
	});
	try {
		await f.loop.submit("", { images: [{ type: "image", mimeType: "image/png", data: "IMAGE_ONLY" }] });
		match(question, /Describe the attached image/u);
		strictEqual(f.wire().calls(), 1);
	} finally {
		await f.close();
	}
});

it("sidecar failure refuses admission without sending the image to the main model", { timeout: 15_000 }, async () => {
	const f = fixture("success", undefined, {
		configured: () => true,
		label: () => "MiniCPM-V-4.6",
		analyze: async () => {
			throw new Error("HTTP 503");
		},
	});
	try {
		await f.loop.submit("Inspect this", { images: [{ type: "image", mimeType: "image/png", data: "SENTINEL" }] });
		strictEqual(f.wire().calls(), 0);
		strictEqual(f.session.current(), null);
		ok(f.events.some((event) => event.type === "notice" && event.admission?.reason === "vision-sidecar-failed"));
	} finally {
		await f.close();
	}
});

it("a vision-capable Qwopus-style route receives images directly without invoking the sidecar", {
	timeout: 15_000,
}, async () => {
	let calls = 0;
	const f = fixture(
		"success",
		undefined,
		{
			configured: () => true,
			label: () => "MiniCPM-V-4.6",
			analyze: async () => {
				calls += 1;
				throw new Error("sidecar should not run");
			},
		},
		true,
	);
	try {
		await f.loop.submit("Describe", {
			images: [{ type: "image", mimeType: "image/png", data: "DIRECT_IMAGE_SENTINEL" }],
		});
		strictEqual(calls, 0);
		strictEqual(f.wire().calls(), 1);
		match(f.wire().requestBodies()[0] ?? "", /DIRECT_IMAGE_SENTINEL/u);
	} finally {
		await f.close();
	}
});

it("cancelling image processing stops admission and leaves the next turn usable", { timeout: 15_000 }, async () => {
	let started!: () => void;
	const entered = new Promise<void>((resolve) => {
		started = resolve;
	});
	const f = fixture("success", undefined, {
		configured: () => true,
		label: () => "MiniCPM-V-4.6",
		analyze: async (_images, _question, signal) => {
			started();
			await new Promise<void>((_resolve, reject) =>
				signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }),
			);
			throw new Error("unreachable");
		},
	});
	try {
		const pending = f.loop.submit("Inspect", {
			images: [{ type: "image", mimeType: "image/png", data: "CANCEL_IMAGE_SENTINEL" }],
		});
		await entered;
		f.loop.cancel();
		await pending;
		strictEqual(f.wire().calls(), 0);
		strictEqual(f.session.current(), null);
		await f.loop.submit("Continue with text");
		strictEqual(f.wire().calls(), 1);
	} finally {
		await f.close();
	}
});

it("a text-only route omits historical images with a visible note before the next request", {
	timeout: 15_000,
}, async () => {
	const f = fixture("success");
	const image = { type: "image" as const, mimeType: "image/png", data: "HISTORICAL_IMAGE_SENTINEL" };
	const priorTurn = {
		role: "user" as const,
		content: [{ type: "text" as const, text: "Earlier image" }, image],
		timestamp: Date.now(),
	};
	try {
		f.loop.resetForSession(null, [priorTurn]);
		await f.loop.submit("Continue");
		strictEqual(f.wire().calls(), 1);
		const body = f.wire().requestBodies()[0] ?? "";
		doesNotMatch(body, /HISTORICAL_IMAGE_SENTINEL/u);
		match(body, /Image omitted/u);
		ok(f.events.some((event) => event.type === "notice" && /1 earlier image.*omitted.*text-only/u.test(event.text)));
		await f.loop.submit("Continue again");
		strictEqual(
			f.events.filter((event) => event.type === "notice" && /earlier image.*omitted.*text-only/u.test(event.text)).length,
			1,
		);
		match(JSON.stringify(priorTurn), /HISTORICAL_IMAGE_SENTINEL/u);
	} finally {
		await f.close();
	}
});

it("headless reports a stable image error before opening a turn", { timeout: 15_000 }, async () => {
	const f = fixture("success");
	const notices: string[] = [];
	f.loop.onEvent((event) => {
		if (event.type === "notice" && event.admission?.reason === "image-input-unsupported") notices.push(event.text);
	});
	try {
		const code = await runHeadlessMainAgent(f.loop, {
			prompt: "Inspect this",
			images: [{ type: "image", mimeType: "image/png", data: "aGVsbG8=" }],
			mode: "json",
		});
		strictEqual(code, 1);
		strictEqual(f.wire().calls(), 0);
		match(notices[0] ?? "", /IMAGE_INPUT_UNSUPPORTED/u);
		const journal = readRunJournal(join(env.dir, "state"));
		strictEqual(journal?.receipts.length ?? 0, 0);
	} finally {
		await f.close();
	}
});

it("headless text mode reports a dispatch scope notice on stderr and ignores a payload that is not one", {
	timeout: 15_000,
}, async () => {
	const f = fixture("success");
	const message = '[dispatch scope] intent.write_roots "." names the whole workspace, so it sets no write boundary.';
	const lines: string[] = [];
	try {
		// The listener fires while the run starts, before its first await, so stderr is
		// only swapped across synchronous code and restored before anything is awaited.
		const write = process.stderr.write;
		process.stderr.write = ((chunk: string | Uint8Array) => {
			lines.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		let running: Promise<number>;
		try {
			running = runHeadlessMainAgent(f.loop, {
				prompt: "Hello",
				mode: "text",
				scopeNotices: (listener) => {
					listener({ code: "write_root_dot_unconfined", level: "warning", message });
					listener({ code: "made_up", level: "warning", message: "not a scope notice" });
					return () => {};
				},
			});
		} finally {
			process.stderr.write = write;
		}
		strictEqual(await running, 0);
		strictEqual(lines.filter((line) => line.includes("[dispatch scope]")).length, 1);
		ok(lines.includes(`clio-coder run: ${message}\n`));
		strictEqual(
			lines.some((line) => line.includes("not a scope notice")),
			false,
		);
	} finally {
		await f.close();
	}
});

it("headless shutdown retains its cancelled receipt and exit 143 without route advice", {
	timeout: 15_000,
}, async () => {
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
	} finally {
		await f.close();
	}
});
