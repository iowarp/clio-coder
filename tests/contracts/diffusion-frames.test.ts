import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";

import inceptionRuntime from "../../src/domains/providers/runtimes/cloud/inception.js";
import {
	readDiffusionFrame,
	setDiffusionFramesEnabled,
	settledPrefixLength,
} from "../../src/engine/apis/diffusion-frames.js";
import { openAICompletionsApiProvider } from "../../src/engine/apis/openai-completions.js";
import { hasAssistantGenerationDelta } from "../../src/interactive/assistant-generation-timing.js";
import { createChatPanel } from "../../src/interactive/chat-panel.js";
import { reduceStatus } from "../../src/interactive/status/state-machine.js";
import { INITIAL_STATUS } from "../../src/interactive/status/types.js";
import { resolveFooterVerb } from "../../src/interactive/status/verbs.js";
import { SGR_DIM } from "../../src/interactive/theme/index.js";

afterEach(() => setDiffusionFramesEnabled(false));

const FRAMES = [
	"```py\ndef p(x)\x1f: r%t\n",
	"```py\ndef parse(line):\n    !k@\n",
	"```py\ndef parse(line):\n    return 1\n",
];

/** The wire shape Inception returns for `diffusing: true`, measured against the live API. */
function diffusingResponse(frames: ReadonlyArray<string>): Response {
	const chunks = frames.map((content, index) => ({
		id: "chatcmpl-frame",
		model: "mercury-2.5",
		choices: [
			{
				index: 0,
				delta: { role: "assistant", content, tool_calls: [] },
				finish_reason: index === frames.length - 1 ? "stop" : null,
			},
		],
		diffusion_meta: { diffusion_content: true, diffusion_progress: index / (frames.length - 1) },
		reasoning_summary: null,
	}));
	const closing = {
		id: "chatcmpl-frame",
		model: "mercury-2.5",
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
	};
	const body = [...[...chunks, closing].map((chunk) => `data: ${JSON.stringify(chunk)}`), "data: [DONE]", ""].join(
		"\n\n",
	);
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/**
 * A preamble followed by a tool call, as Inception streams it with
 * `diffusing: true`: the whole content frame is repeated on every chunk that
 * carries a tool-call argument delta, and the resolved text arrives last,
 * after the tool call began. Measured live against mercury-2.5.
 */
function diffusingToolCallResponse(noisy: string, resolved: string): Response {
	const call = (toolCall: Record<string, unknown>) => [{ index: 0, type: "function", ...toolCall }];
	const deltas: Array<{ content: string; tool_calls: unknown[]; progress: number; finish: string | null }> = [
		{ content: noisy, tool_calls: [], progress: 0, finish: null },
		{
			content: noisy,
			tool_calls: call({ id: "call_1", function: { name: "read", arguments: "{" } }),
			progress: 0,
			finish: null,
		},
		{
			content: noisy,
			tool_calls: call({ id: null, function: { name: null, arguments: '"path": "src/main.ts"}' } }),
			progress: 0,
			finish: null,
		},
		{ content: resolved, tool_calls: [], progress: 1, finish: "tool_calls" },
	];
	const chunks = deltas.map((delta) => ({
		id: "chatcmpl-frame",
		model: "mercury-2.5",
		choices: [
			{
				index: 0,
				delta: { role: "assistant", content: delta.content, tool_calls: delta.tool_calls },
				finish_reason: delta.finish,
			},
		],
		diffusion_meta: { diffusion_content: true, diffusion_progress: delta.progress },
	}));
	const closing = {
		id: "chatcmpl-frame",
		model: "mercury-2.5",
		choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
	};
	const body = [...[...chunks, closing].map((chunk) => `data: ${JSON.stringify(chunk)}`), "data: [DONE]", ""].join(
		"\n\n",
	);
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function plainResponse(text: string): Response {
	const chunks = [
		{ model: "mercury-2.5", choices: [{ index: 0, delta: { content: text } }] },
		{ model: "mercury-2.5", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
	];
	const body = [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`), "data: [DONE]", ""].join("\n\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function mercury(): Model<"openai-completions"> {
	return inceptionRuntime.synthesizeModel(
		{ id: "inception", runtime: "inception", defaultModel: "mercury-2.5" },
		"mercury-2.5",
		null,
	) as Model<"openai-completions">;
}

interface Collected {
	events: AssistantMessageEvent[];
	/** The wire body, parsed from what the fetch stub received. */
	body: Record<string, unknown>;
	/** The partial's text block at the moment each text_delta was emitted. */
	partialTexts: string[];
}

async function collect(response: () => Response): Promise<Collected> {
	const events: AssistantMessageEvent[] = [];
	const partialTexts: string[] = [];
	let body: Record<string, unknown> = {};
	const context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] } as unknown as Context;
	for await (const event of openAICompletionsApiProvider.streamSimple(mercury(), context, {
		apiKey: "test-key",
		fetch: async (_input, init) => {
			body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			return response();
		},
	})) {
		if (event.type === "text_delta") {
			const block = event.partial.content[event.contentIndex];
			partialTexts.push(block?.type === "text" ? block.text : "");
		}
		events.push(event);
	}
	return { events, body, partialTexts };
}

function plain(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are the subject under test.
	return text.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("diffusion frames through the completions adapter", () => {
	it("requests frames only when the interactive surface enabled them", async () => {
		const headless = await collect(() => plainResponse("done"));
		strictEqual(headless.body.diffusing, undefined, "a headless request never asks for frames");

		setDiffusionFramesEnabled(true);
		const interactive = await collect(() => plainResponse("done"));
		strictEqual(interactive.body.diffusing, true);
		strictEqual(interactive.body.stream, true, "frames only exist on a streamed request");
	});

	it("marks each whole frame, keeps the partial on the frame, and settles the final message on the last one", async () => {
		setDiffusionFramesEnabled(true);
		const { events, partialTexts } = await collect(() => diffusingResponse(FRAMES));
		const deltas = events.filter((event) => event.type === "text_delta");
		strictEqual(deltas.length, FRAMES.length);
		const framed = deltas.map((event, index) => {
			ok(event.type === "text_delta");
			const frame = readDiffusionFrame(event);
			ok(frame, `frame ${index} carries its marker`);
			strictEqual(frame.progress, index / (FRAMES.length - 1));
			strictEqual(event.delta, "", "a frame is never an append");
			return frame.text;
		});
		deepStrictEqual(framed, FRAMES, "each marker carries exactly its frame");
		// The shared block is rewritten per frame but pi-ai keeps appending to it
		// as later chunks arrive, so a snapshot may lag. It must still end on the
		// final frame, which is what the agent's context keeps.
		strictEqual(partialTexts[partialTexts.length - 1], FRAMES[FRAMES.length - 1]);
		const done = events.find((event) => event.type === "done");
		ok(done?.type === "done");
		deepStrictEqual(done.message.content, [{ type: "text", text: FRAMES[FRAMES.length - 1] }]);
	});

	it("keeps one text block and one intact tool call when frames interleave with tool-call deltas", async () => {
		setDiffusionFramesEnabled(true);
		const { events } = await collect(() => diffusingToolCallResponse("I wYll r%ad the f!le.", "I will read the file."));
		const frames = events.flatMap((event) => {
			const frame = event.type === "text_delta" ? readDiffusionFrame(event) : null;
			return frame ? [frame.text] : [];
		});
		deepStrictEqual(frames, [
			"I wYll r%ad the f!le.",
			"I wYll r%ad the f!le.",
			"I wYll r%ad the f!le.",
			"I will read the file.",
		]);
		const done = events.find((event) => event.type === "done");
		ok(done?.type === "done");
		strictEqual(done.message.stopReason, "toolUse");
		deepStrictEqual(
			done.message.content.map((block) => (block.type === "toolCall" ? { ...block } : block)),
			[
				{ type: "text", text: "I will read the file." },
				{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "src/main.ts" } },
			],
		);
	});

	it("passes an ordinary delta stream through untouched even when frames are enabled", async () => {
		setDiffusionFramesEnabled(true);
		const { events } = await collect(() => plainResponse("plain"));
		const delta = events.find((event) => event.type === "text_delta");
		ok(delta?.type === "text_delta");
		strictEqual(delta.delta, "plain");
		strictEqual(readDiffusionFrame(delta), null);
		const done = events.find((event) => event.type === "done");
		ok(done?.type === "done");
		deepStrictEqual(done.message.content, [{ type: "text", text: "plain" }]);
	});
});

describe("diffusion frames in the chat panel", () => {
	it("replaces the live segment per frame, dims what is still denoising, and finalizes clean", () => {
		const panel = createChatPanel();
		panel.applyEvent({ type: "text_frame", contentIndex: 0, text: FRAMES[0] ?? "", progress: 0 });
		let rendered = panel.render(80).join("\n");
		ok(plain(rendered).includes("def p(x)"), "the first frame shows its noise");

		panel.applyEvent({ type: "text_frame", contentIndex: 0, text: FRAMES[1] ?? "", progress: 0.5 });
		rendered = panel.render(80).join("\n");
		const text = plain(rendered);
		ok(!text.includes("def p(x)"), "a frame replaces the previous frame rather than extending it");
		ok(text.includes("def parse(line):"));
		ok(rendered.includes(SGR_DIM), "the unsettled remainder renders dim");
		const settled = settledPrefixLength(FRAMES[0] ?? "", FRAMES[1] ?? "");
		strictEqual((FRAMES[1] ?? "").slice(0, settled), "```py\ndef p");

		panel.applyEvent({ type: "text_frame", contentIndex: 0, text: FRAMES[2] ?? "", progress: 1 });
		rendered = panel.render(80).join("\n");
		ok(!rendered.includes(SGR_DIM), "a complete frame has nothing left to dim");
		ok(plain(rendered).includes("return 1"));
	});

	it("keeps a preamble's frames in one segment above the tool call it announces", () => {
		const panel = createChatPanel();
		const toolCall = { type: "toolCall", id: "call_1", name: "read", arguments: { path: "src/main.ts" } };
		const partial = { role: "assistant", content: [{ type: "text", text: "" }, toolCall] };
		panel.applyEvent({ type: "message_start", message: { role: "assistant", content: [] } } as never);
		panel.applyEvent({ type: "text_frame", contentIndex: 0, text: "I wYll r%ad the f!le.", progress: 0 });
		panel.applyEvent({
			type: "message_update",
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, partial },
		} as never);
		panel.applyEvent({ type: "text_frame", contentIndex: 0, text: "I wYll r%ad the f!le.", progress: 0 });
		panel.applyEvent({ type: "text_frame", contentIndex: 0, text: "I will read the file.", progress: 1 });
		panel.applyEvent({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "I will read the file." }, toolCall] },
		} as never);
		const text = plain(panel.render(80).join("\n"));
		ok(!text.includes("r%ad"), "no noise frame survives above the tool call");
		strictEqual(text.split("I will read the file.").length - 1, 1, "the resolved preamble renders once");
		ok(text.indexOf("I will read the file.") < text.indexOf("read"), "the preamble stays above the tool line");
	});
});

describe("diffusion frames in the footer and timing", () => {
	it("counts a frame as generated text even though its delta is empty", async () => {
		setDiffusionFramesEnabled(true);
		const { events } = await collect(() => diffusingResponse(FRAMES));
		const first = events.find((event) => event.type === "text_delta");
		ok(first?.type === "text_delta");
		strictEqual(first.delta, "");
		strictEqual(hasAssistantGenerationDelta(first), true, "the first frame is the call's first token");
		strictEqual(hasAssistantGenerationDelta({ type: "text_delta", delta: "" }), false);
	});

	it("moves the footer from waiting to writing on the first frame", () => {
		const ctx = { now: 1000, localRuntime: false };
		let state = reduceStatus(INITIAL_STATUS, { type: "agent_start" } as never, ctx);
		state = reduceStatus(state, { type: "turn_start" } as never, ctx);
		state = reduceStatus(state, { type: "text_frame", contentIndex: 0, text: "x", progress: 0 }, ctx);
		strictEqual(state.phase, "writing");
		state = reduceStatus(state, { type: "text_frame", contentIndex: 0, text: "xy", progress: 0.5 }, ctx);
		const footer = resolveFooterVerb(state, 1000, 100)?.text ?? "";
		ok(/Writing/i.test(footer), footer);
		ok(!/\d+%/.test(footer), "the provider's completion flag is not a denoising gauge");
	});
});
