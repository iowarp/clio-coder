import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { mock, test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { createMiddlewareToolChoiceControl } from "../../src/domains/middleware/index.js";
import {
	EMPTY_CAPABILITIES,
	type ProvidersContract,
	type RuntimeDescriptor,
} from "../../src/domains/providers/index.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import { firstTokenStallLimitMs, recordFirstTokenMs } from "../../src/domains/session/retry.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { applyToolRounds, streamToolRound } from "../../src/engine/provider-payload.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import type { Model } from "../../src/engine/types.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { keptRows } from "../../src/interactive/kept-rows.js";
import type { ChatLoopEvent } from "../../src/session-control/chat-loop.js";
import { createChatLoop } from "../../src/session-control/chat-loop.js";
import { createRegistry } from "../../src/tools/registry.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const WIDTHS = [60, 80, 120, 200] as const;

/**
 * A settled retry row used to stop the frozen prefix at its position, so every
 * streamed token re-rendered it and every settled row after it. The stream tick
 * must render only the live answer, and a later update of the same attempt must
 * still reach the screen.
 */
test("a settled retry row joins the frozen prefix and a stream tick renders only the live answer", () => {
	for (const width of WIDTHS) {
		let rendered = -1;
		const panel = createChatPanel({
			now: () => 0,
			onRenderMetrics: (metrics) => {
				rendered = metrics.entriesRendered;
			},
		});
		panel.applyEvent({ type: "retry_status", status: { phase: "retrying", attempt: 1, maxAttempts: 3 } });
		panel.appendUser("Explain the render path of a streamed token.");
		panel.applyEvent({ type: "agent_start" } as never);
		panel.applyEvent({ type: "message_start", message: { role: "assistant" } } as never);
		panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: "The panel " } as never);
		// This frame freezes the settled rows; from here on only the answer streams.
		panel.renderRegions(width);
		panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: "then " } as never);
		const first = panel.renderRegions(width);
		ok(first.prefix.length > 0, `${width}: the retry and prompt rows are frozen`);
		for (const delta of ["renders ", "only ", "its ", "tail."]) {
			panel.applyEvent({ type: "text_delta", contentIndex: 0, delta } as never);
			const frame = panel.renderRegions(width);
			strictEqual(frame.prefix, first.prefix, `${width}: the settled rows are the same array every tick`);
			strictEqual(rendered, 1, `${width}: a stream tick renders one entry`);
			for (const line of [...frame.prefix, ...frame.tail]) ok(visibleWidth(line) <= width);
		}
	}
});

/**
 * Built-in rows read the terminal height only through their preview budgets, so a height change those budgets
 * absorb keeps every settled row; a replay block, which its caller renders from the raw height, still reads it.
 */
test("a height change inside every preview budget keeps the settled rows and still reaches a replay block", () => {
	let rows = 40;
	let rendered = -1;
	const panel = createChatPanel({
		now: () => 0,
		getTerminalRows: () => rows,
		onRenderMetrics: (metrics) => {
			rendered = metrics.entriesRendered;
		},
	});
	panel.applyEvent({ type: "retry_status", status: { phase: "retrying", attempt: 1, maxAttempts: 3 } });
	panel.appendUser("Explain the render path of a resize.");
	// This frame freezes the settled rows.
	panel.renderRegions(80);
	rows = 41;
	const settled = panel.renderRegions(80);
	ok(settled.prefix.length > 0, "the retry and prompt rows are frozen");
	strictEqual(rendered, 0, "no entry renders again");
	rows = 43;
	strictEqual(panel.renderRegions(80).prefix, settled.prefix, "the settled rows are the same array");
	panel.appendReplayBlock((_width, _detail, _unbounded, height) => [`${height} rows`]);
	panel.renderRegions(80);
	rows = 42;
	match(panel.render(80).map(stripTerminalSequences).join("\n"), /42 rows/u);
	strictEqual(rendered, 1, "only the replay block renders again");
	// A short terminal shrinks the budgets, so every row that reads one renders again.
	rows = 12;
	panel.renderRegions(80);
	strictEqual(rendered, 3);
});

test("an update of the same retry attempt replaces its frozen row", () => {
	for (const width of WIDTHS) {
		const panel = createChatPanel({ now: () => 0 });
		panel.applyEvent({ type: "retry_status", status: { phase: "retrying", attempt: 1, maxAttempts: 3 } });
		panel.renderRegions(width);
		panel.renderRegions(width);
		panel.applyEvent({ type: "retry_status", status: { phase: "recovered", attempt: 1, maxAttempts: 3 } });
		const plain = panel.render(width).map(stripTerminalSequences).join("\n");
		match(plain, /recovered after 1 attempt/u);
		strictEqual((plain.match(/↻/gu) ?? []).length, 1);
	}
});

/**
 * A stream tick reports how many leading rows of the live tail are last tick's strings, and the terminal renderer
 * skips those rows. The count must never cover a row that changed: neither the open tail of a plain reply, nor rows
 * above it that a late reference definition rewrites. Either streamed frame must match the same reply rendered fresh.
 */
test("the rows a stream tick vouches for are last tick's rows, even when a late definition rewrites earlier ones", () => {
	const paragraphs = Array.from(
		{ length: 40 },
		(_, index) => `Paragraph ${index} of the answer, with prose that wraps.\n\n`,
	);
	const texts = [
		`${paragraphs.join("")}Done.`,
		`See [the guide][ref] first.\n\n${paragraphs.join("")}[ref]: https://example.com/guide\n\nDone.`,
	];
	const start = (panel: ReturnType<typeof createChatPanel>): void => {
		panel.appendUser("Write the guide.");
		panel.applyEvent({ type: "agent_start" } as never);
		panel.applyEvent({ type: "message_start", message: { role: "assistant" } } as never);
	};
	for (const text of texts) {
		const panel = createChatPanel({ now: () => 0 });
		start(panel);
		let previous = panel.renderRegions(80);
		let vouched = 0;
		for (const delta of text.match(/[\s\S]{1,23}/gu) ?? []) {
			panel.applyEvent({ type: "text_delta", contentIndex: 0, delta } as never);
			const frame = panel.renderRegions(80);
			const kept = frame.prefix === previous.prefix ? keptRows(frame.tail, previous.tail) : 0;
			for (let row = 0; row < kept; row += 1)
				strictEqual(
					frame.tail[row],
					previous.tail[row],
					`row ${row} of ${kept} vouched for after ${JSON.stringify(delta)}`,
				);
			vouched += kept;
			previous = frame;
		}
		ok(vouched > 0, "stream ticks vouch for unchanged rows");
		const fresh = createChatPanel({ now: () => 0 });
		start(fresh);
		fresh.applyEvent({ type: "text_delta", contentIndex: 0, delta: text } as never);
		strictEqual(panel.render(80).join("\n"), fresh.render(80).join("\n"));
	}
});

/**
 * A kept-rows record names the rows it was taken against without holding them: when it held them, the latest frame
 * held the one before, which held the one before that, and a 500 KB reply kept every frame's rows alive (#428).
 */
test("a streamed frame's rows do not keep earlier frames' rows alive", async () => {
	setFlagsFromString("--expose-gc");
	const gc = runInNewContext("gc") as () => void;
	const panel = createChatPanel({ now: () => 0 });
	panel.appendUser("Write the guide.");
	panel.applyEvent({ type: "agent_start" } as never);
	panel.applyEvent({ type: "message_start", message: { role: "assistant" } } as never);
	const paragraph = "A paragraph of the answer, with prose that wraps.\n\n";
	panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: paragraph.repeat(20) } as never);
	panel.renderRegions(80);
	panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: "More " } as never);
	const first = new WeakRef(panel.renderRegions(80).tail);
	for (let frame = 0; frame < 20; frame += 1) {
		panel.applyEvent({ type: "text_delta", contentIndex: 0, delta: frame % 4 === 3 ? paragraph : "words " } as never);
		panel.renderRegions(80);
	}
	await new Promise((resolve) => setImmediate(resolve));
	gc();
	strictEqual(first.deref(), undefined, "the first frame's tail was collected");
});

/**
 * MD11 replay, on virtual time (timers, Date and performance.now advance only when the test ticks them).
 * Event sequence on a calibrated hosted route (20 first tokens of 2 s, so the limit is max(30 s, 10 x 2 s) = 30 s, well
 * under the 180 s mid-stream window): request 1 gets no response and its server ignores the abort; the watchdog cuts it
 * at 30 s; the retry, request 2, starts 25 s in (a healthy slow first token under the limit) and asks for one tool call;
 * request 1 then answers late, headers and a tool call of its own; the tool locks tools, and on this route, where
 * "none" re-renders the prompt, request 3 is a compliance-first round the payload layer holds whole: its provider starts
 * at 2 s and finishes at 40 s, so the turn sees its first token at 40 s, past the adaptive limit, and it is not cut.
 * Transport assertions: three requests, the retry sent at the adaptive limit, one tool effect, one answer on screen,
 * nothing of the late completion, and the retry ladder's typed outcome `recovered`. The limit rows: a cold route (under
 * 5 first tokens) keeps the mid-stream window, a calibrated one takes max(30 s, 10 x p95) capped at it, and a local
 * route keeps its first-token window.
 */
test("a calibrated route's silent request is cut at the adaptive limit and leaves one answer and one tool effect", {
	timeout: 60_000,
}, async () => {
	const retry = { streamStallMs: 180_000, firstTokenStallMs: 600_000 };
	strictEqual(firstTokenStallLimitMs(retry, "cloud", [1_000, 1_000, 1_000, 1_000]), 180_000, "cold route");
	strictEqual(firstTokenStallLimitMs(retry, "cloud", [900, 1_000, 1_100, 1_200, 2_000]), 30_000, "30 s floor");
	strictEqual(firstTokenStallLimitMs(retry, "subscription", [4_000, 5_000, 5_500, 6_000, 6_000]), 60_000, "10 x p95");
	strictEqual(firstTokenStallLimitMs(retry, "cloud", [40_000, 40_000, 40_000, 40_000, 40_000]), 180_000, "capped");
	strictEqual(firstTokenStallLimitMs(retry, "protocol", [1_000, 1_000, 1_000, 1_000, 1_000]), 600_000, "local");

	const env = await isolateClioEnv("md11-stall-");
	const previousCwd = process.cwd();
	const project = join(env.dir, "project");
	mkdirSync(project);
	process.chdir(project);
	const target = { id: "md11-fixture", runtime: "openai-compat", url: "http://fixture.invalid:4000" };
	const model = litellm.synthesizeModel(target, "md11-model", null) as Model<"openai-completions">;
	for (let sample = 0; sample < 20; sample += 1) recordFirstTokenMs(target.id, model.id, 2_000);
	// Mark the route as one where "none" re-renders the prompt, the way the payload layer learns it: a text-only round
	// whose cache read collapsed. Its next text-only round is compliance-first, held whole until it completes.
	const routeModel = { ...model, input: ["text" as const], contextWindow: 131072, maxTokens: 4096 };
	const markRound = async (cacheRead: number, round: Parameters<typeof applyToolRounds>[3]) => {
		const readTool = { name: "read", description: "read", parameters: Type.Object({}) };
		const controlled = applyToolRounds(routeModel, { messages: [], tools: [readTool] }, undefined, round, target.id);
		const reply = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "ok" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 10,
				output: 1,
				cacheRead,
				cacheWrite: 0,
				totalTokens: 11 + cacheRead,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: 0,
		};
		await streamToolRound(
			routeModel,
			controlled,
			() => {
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "stop", message: reply });
				stream.end(reply);
				return stream;
			},
			target.id,
		).result();
	};
	await markRound(8192, []);
	await markRound(0, [{ kind: "text-only" }]);
	const encoder = new TextEncoder();
	const frame = (delta: Record<string, unknown>, finish: string | null = null) =>
		encoder.encode(
			`data: ${JSON.stringify({ id: "md11", object: "chat.completion.chunk", model: model.id, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
		);
	const toolCall = (id: string) => ({
		role: "assistant",
		tool_calls: [{ index: 0, id, type: "function", function: { name: "read", arguments: "{}" } }],
	});
	const sse = (frames: (controller: ReadableStreamDefaultController<Uint8Array>) => void) =>
		new Response(new ReadableStream<Uint8Array>({ start: frames }), { headers: { "content-type": "text/event-stream" } });
	const sentAt: number[] = [];
	const late: { release: (() => void) | null } = { release: null };
	const fetch: typeof globalThis.fetch = async () => {
		sentAt.push(Date.now());
		if (sentAt.length === 1)
			// No response at all until the retry is on the wire; then headers and a tool call of its own.
			return new Promise<Response>((resolve) => {
				late.release = () => {
					late.release = null;
					resolve(
						sse((controller) => {
							controller.enqueue(frame(toolCall("record-late")));
							controller.enqueue(frame({}, "tool_calls"));
							controller.enqueue(encoder.encode("data: [DONE]\n\n"));
							controller.close();
						}),
					);
				};
			});
		late.release?.();
		if (sentAt.length === 2)
			// A healthy slow first token, under the adaptive limit.
			return sse((controller) => {
				setTimeout(() => {
					controller.enqueue(frame(toolCall("record-2")));
					controller.enqueue(frame({}, "tool_calls"));
					controller.enqueue(encoder.encode("data: [DONE]\n\n"));
					controller.close();
				}, 25_000);
			});
		// The held round: its provider starts at 2 s and finishes at 40 s; the turn sees all of it at 40 s.
		return sse((controller) => {
			setTimeout(() => controller.enqueue(frame({ role: "assistant", content: "DONE_" })), 2_000);
			setTimeout(() => {
				controller.enqueue(frame({ content: "ANSWER" }));
				controller.enqueue(frame({}, "stop"));
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
			}, 40_000);
		});
	};
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = false;
	settings.chat.target = target.id;
	settings.chat.model = model.id;
	settings.chat.thinkingLevel = "off";
	settings.chat.retry = { ...settings.chat.retry, enabled: true, baseDelayMs: 1, streamStallMs: 180_000 };
	settings.targets = [{ ...target, defaultModel: model.id }];
	const runtime: RuntimeDescriptor = {
		...litellm,
		id: target.runtime,
		tier: "cloud",
		auth: "none",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true, contextWindow: 131072, maxTokens: 4096 },
		synthesizeModel: () => routeModel,
	};
	const context = dispatchStubContext({ settings, runtime });
	const safety = context.getContract("safety");
	ok(safety);
	const registry = createRegistry({ safety, autonomy: () => "yolo" });
	const toolRuns: string[] = [];
	const toolChoice = createMiddlewareToolChoiceControl();
	registry.register({
		name: ToolNames.Read,
		description: "Counts its effects",
		parameters: Type.Object({}),
		baseActionClass: "read",
		async run() {
			toolRuns.push("read");
			// Its effect locks tools for the next round, which makes that round text-only.
			toolChoice.apply([{ kind: "lock_tools" }]);
			return { kind: "ok", output: "recorded" };
		},
	});
	const loop = createChatLoop({
		getSettings: () => settings,
		providers: context.getContract("providers") as ProvidersContract,
		knownTargets: () => new Set([target.id]),
		toolRegistry: registry,
		middlewareToolChoice: toolChoice,
		bus: context.bus,
		// The turn runtime's own stream, with only its fetch swapped and the abort signal withheld from the provider,
		// so only the watchdog can end request 1.
		createAgent: (options) =>
			createEngineAgent(
				options?.transcriptStreamFn === undefined
					? options
					: {
							...options,
							transcriptStreamFn: ((stream) => (requestModel, requestContext, requestOptions) => {
								const { signal: _withheld, ...unsignalled } = requestOptions ?? {};
								return stream(requestModel, requestContext, { ...unsignalled, apiKey: "fixture", fetch });
							})(options.transcriptStreamFn),
						},
			),
	});
	const events: ChatLoopEvent[] = [];
	const panel = createChatPanel({ now: () => 0 });
	loop.onEvent((event) => {
		events.push(event);
		panel.applyEvent(event);
	});
	mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_000_000 });
	mock.method(performance, "now", () => Date.now());
	/** Advance virtual time in 250 ms steps, letting I/O and promises run between steps, until `until` settles. */
	const drive = async (until: Promise<unknown>, capMs = 400_000): Promise<boolean> => {
		let done = false;
		until.then(
			() => {
				done = true;
			},
			() => {
				done = true;
			},
		);
		for (let elapsed = 0; !done && elapsed <= capMs; elapsed += 250) {
			for (let turn = 0; turn < 20 && !done; turn += 1) await new Promise((resolve) => setImmediate(resolve));
			if (!done) mock.timers.tick(250);
		}
		return done;
	};
	try {
		panel.appendUser("hello");
		ok(await drive(loop.submit("hello").then(() => loop.whenSettled())), "the turn settled");
		for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
		strictEqual(sentAt.length, 3, "the cut request, its retry and the answer after the tool; nothing more");
		const cutAfter = (sentAt[1] ?? 0) - (sentAt[0] ?? 0);
		ok(
			cutAfter >= 30_000 && cutAfter < 31_000,
			`the retry went out at the adaptive limit, not the window: ${cutAfter} ms`,
		);
		strictEqual(late.release, null, "request 1 answered after its retry was sent");
		deepStrictEqual(toolRuns, ["read"], "one tool effect");
		const ran = events.flatMap((event) =>
			event.type === "tool_execution_end" ? [(event as { toolCallId?: string }).toolCallId] : [],
		);
		deepStrictEqual(ran, ["record-2"], "only the retry's tool call ran");
		const answers = events.flatMap((event) => (event.type === "text_delta" ? [event.delta] : []));
		strictEqual(answers.join(""), "DONE_ANSWER", "one logical result; neither the 25 s nor the held round was cut");
		const lastRound = events.flatMap((event) =>
			event.type === "message_end" && event.message.role === "assistant"
				? [(event.message as { toolRounds?: Array<{ downgradeReason?: string }> }).toolRounds?.[0]?.downgradeReason]
				: [],
		);
		strictEqual(lastRound.at(-1), "none re-renders the prompt on this route", "the last round was held whole");
		const heldAfter = Date.now() - (sentAt[2] ?? 0);
		ok(heldAfter >= 40_000, `the held round's output reached the turn after the adaptive limit: ${heldAfter} ms`);
		const phases = events.flatMap((event) =>
			event.type === "retry_status" ? [(event as { status: { phase: string } }).status.phase] : [],
		);
		strictEqual(phases.filter((phase) => phase === "scheduled").length, 1, "one stall, one retry");
		strictEqual(phases.at(-1), "recovered", "the ladder's typed outcome");
		match(JSON.stringify(events), /stream stalled: no first token from md11-fixture for 30s/u);
		const screen = stripTerminalSequences(
			[...panel.renderRegions(100).prefix, ...panel.renderRegions(100).tail].join("\n"),
		);
		strictEqual(screen.split("DONE_ANSWER").length - 1, 1, "the answer is on screen once");
		ok(!screen.includes("record-late"), "the late completion never reached the screen");
	} finally {
		late.release?.();
		loop.dispose();
		await drive(loop.whenSettled(), 10_000);
		mock.timers.reset();
		mock.restoreAll();
		process.chdir(previousCwd);
		env.restore();
	}
});
