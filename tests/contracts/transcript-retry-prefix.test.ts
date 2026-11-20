import { match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ProvidersContract, RuntimeDescriptor } from "../../src/domains/providers/index.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import { firstTokenStallLimitMs } from "../../src/domains/session/retry.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { openAICompletionsApiProvider } from "../../src/engine/apis/openai-completions.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import type { Model } from "../../src/engine/types.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { keptRows } from "../../src/interactive/kept-rows.js";
import { type ChatLoopEvent, createChatLoop } from "../../src/session-control/chat-loop.js";
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
 * MD11 replay. Event sequence: request 1 is sent to a hosted route and never produces a first token, and its server
 * ignores the abort; the first-token watchdog ends it at the limit; the retry, request 2, answers; only then does
 * request 1 complete late. Transport assertions: two requests, one answer on screen, nothing of the late completion.
 * The limit rows: a cold route (under 5 first tokens) keeps the mid-stream window, a calibrated one takes
 * max(30 s, 10 x p95) capped at that window, and a local route keeps its first-token window.
 */
test("a request the first-token watchdog ends leaves one answer on screen, whatever the original sends late", {
	timeout: 20_000,
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
	const target = { id: "stall-fixture", runtime: "openai-compat", url: "http://fixture.invalid:4000" };
	const model = litellm.synthesizeModel(target, "stall-model", null) as Model<"openai-completions">;
	const encoder = new TextEncoder();
	const chunk = (content: string | null, finish: string | null = null) =>
		encoder.encode(
			`data: ${JSON.stringify({ id: "md11", object: "chat.completion.chunk", model: model.id, choices: [{ index: 0, delta: content === null ? {} : { role: "assistant", content }, finish_reason: finish }] })}\n\n`,
		);
	let requests = 0;
	let completeLate: (() => void) | null = null;
	let fallback: ReturnType<typeof setTimeout> | undefined;
	const fetch: typeof globalThis.fetch = async () => {
		requests += 1;
		if (requests === 1) {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					// The server never looks at the abort signal; it answers when it answers.
					completeLate = () => {
						completeLate = null;
						clearTimeout(fallback);
						controller.enqueue(chunk("LATE_ANSWER"));
						controller.enqueue(chunk(null, "stop"));
						controller.enqueue(encoder.encode("data: [DONE]\n\n"));
						controller.close();
					};
					fallback = setTimeout(() => completeLate?.(), 3_000);
				},
			});
			return new Response(body, { headers: { "content-type": "text/event-stream" } });
		}
		// The original completes only after its retry is on the wire.
		completeLate?.();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(chunk("RETRY_ANSWER"));
				controller.enqueue(chunk(null, "stop"));
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
			},
		});
		return new Response(body, { headers: { "content-type": "text/event-stream" } });
	};
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = false;
	settings.chat.target = target.id;
	settings.chat.model = model.id;
	settings.chat.thinkingLevel = "off";
	settings.chat.retry = { ...settings.chat.retry, enabled: true, baseDelayMs: 1, streamStallMs: 150 };
	settings.targets = [{ ...target, defaultModel: model.id }];
	const runtime: RuntimeDescriptor = {
		...litellm,
		id: target.runtime,
		tier: "cloud",
		auth: "none",
		synthesizeModel: () => ({ ...model, contextWindow: 131072, maxTokens: 4096 }),
	};
	const context = dispatchStubContext({ settings, runtime });
	const loop = createChatLoop({
		getSettings: () => settings,
		providers: context.getContract("providers") as ProvidersContract,
		knownTargets: () => new Set([target.id]),
		bus: context.bus,
		createAgent: (options) =>
			createEngineAgent({
				...options,
				// The provider never sees the abort signal, so only the watchdog can end request 1.
				streamFn: (requestModel, requestContext, requestOptions) => {
					const { signal: _ignored, ...unsignalled } = requestOptions ?? {};
					return openAICompletionsApiProvider.streamSimple(requestModel as Model<"openai-completions">, requestContext, {
						...unsignalled,
						apiKey: "fixture",
						fetch,
					});
				},
			}),
	});
	const events: ChatLoopEvent[] = [];
	const panel = createChatPanel({ now: () => 0 });
	loop.onEvent((event) => {
		events.push(event);
		panel.applyEvent(event);
	});
	try {
		panel.appendUser("hello");
		await loop.submit("hello");
		await loop.whenSettled();
		// Let the late completion drain through whatever still holds request 1.
		await new Promise((resolve) => setImmediate(resolve));
		strictEqual(requests, 2, "the stalled request was retried once");
		strictEqual(completeLate, null, "the original completed after its retry was sent");
		const answers = events.flatMap((event) => (event.type === "text_delta" ? [event.delta] : []));
		strictEqual(answers.join(""), "RETRY_ANSWER", "one logical result reached the turn");
		match(JSON.stringify(events), /stream stalled: no first token from stall-fixture/u);
		const screen = stripTerminalSequences(
			[...panel.renderRegions(100).prefix, ...panel.renderRegions(100).tail].join("\n"),
		);
		strictEqual(screen.split("RETRY_ANSWER").length - 1, 1, "the answer is on screen once");
		ok(!screen.includes("LATE_ANSWER"), "the late completion never reached the screen");
	} finally {
		clearTimeout(fallback);
		loop.dispose();
		await loop.whenSettled();
		process.chdir(previousCwd);
		env.restore();
	}
});
