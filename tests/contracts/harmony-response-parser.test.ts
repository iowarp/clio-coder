import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { openAICompletionsApiProvider } from "../../src/engine/apis/openai-completions.js";
import {
	HarmonyResponseParser,
	type HarmonySegment,
	normalizeHarmonyToolName,
} from "../../src/engine/harmony-response.js";

/**
 * #435: the raw-Harmony parser test added with 2bd9b1b95 was deleted in
 * 7102795ad and `HarmonyResponseParser` ran untested since. The two adapter
 * cases below are that test, driven through an injected fetch instead of a
 * listening server; the golden cases cover the full frame grammar, each fed
 * split at every byte boundary so chunking can never change the segments.
 */

type Golden = { name: string; input: string; expected: HarmonySegment[] };

const TOOL = (name: string, argsText: string, incomplete = false, constrain?: string): HarmonySegment => ({
	kind: "tool",
	name,
	argsText,
	incomplete,
	...(constrain !== undefined ? { constrain } : {}),
});

const GOLDENS: Golden[] = [
	{
		name: "final only",
		input: "<|start|>assistant<|channel|>final<|message|>Hi there! What can I help with today?<|return|>",
		expected: [{ kind: "text", text: "Hi there! What can I help with today?" }],
	},
	{
		name: "analysis then final",
		input:
			"<|channel|>analysis<|message|>User greets. Reply briefly.<|end|><|start|>assistant<|channel|>final<|message|>Hello.<|return|>",
		expected: [
			{ kind: "thinking", text: "User greets. Reply briefly.", channel: "analysis" },
			{ kind: "text", text: "Hello." },
		],
	},
	{
		name: "commentary tool call with the recipient after the channel and <|constrain|>json",
		input: '<|channel|>commentary to=functions.bash <|constrain|>json<|message|>{"command":"ls /tmp"}<|call|>',
		expected: [TOOL("bash", '{"command":"ls /tmp"}', false, "json")],
	},
	{
		name: "tool call with the recipient before the channel and bare json",
		input: '<|start|>assistant to=functions.bash<|channel|>commentary json<|message|>{"command":"ls /tmp"}<|call|>',
		expected: [TOOL("bash", '{"command":"ls /tmp"}', false, "json")],
	},
	{
		name: "two consecutive tool calls",
		input:
			'<|channel|>commentary to=functions.read <|constrain|>json<|message|>{"path":"a"}<|call|>' +
			'<|start|>assistant<|channel|>commentary to=functions.read <|constrain|>json<|message|>{"path":"b"}<|call|>',
		expected: [TOOL("read", '{"path":"a"}', false, "json"), TOOL("read", '{"path":"b"}', false, "json")],
	},
	{
		name: "tool call without <|call|> at end of stream is incomplete",
		input: '<|channel|>commentary to=functions.bash <|constrain|>json<|message|>{"command":"ls',
		expected: [TOOL("bash", '{"command":"ls', true, "json")],
	},
	{
		name: "analysis, then a tool call, then nothing visible",
		input:
			"<|channel|>analysis<|message|>Need the listing.<|end|><|start|>assistant<|channel|>commentary to=functions.bash <|constrain|>json<|message|>{}<|call|>",
		expected: [{ kind: "thinking", text: "Need the listing.", channel: "analysis" }, TOOL("bash", "{}", false, "json")],
	},
	{
		name: "a browser recipient is thinking, never a tool",
		input: '<|channel|>commentary to=browser.search <|constrain|>json<|message|>{"q":"vllm"}<|call|>',
		expected: [
			{
				kind: "thinking",
				text: '{"q":"vllm"}',
				channel: "commentary",
				note: "recipient browser.search is not a function",
			},
		],
	},
	{
		name: "commentary without a recipient is thinking",
		input: "<|channel|>commentary<|message|>I will list the files first.<|end|>",
		expected: [{ kind: "thinking", text: "I will list the files first.", channel: "commentary" }],
	},
	{
		name: "constrained final-channel JSON is visible text",
		input: '<|channel|>final <|constrain|>json<|message|>{"tag":"CLIO_RC_JSON","ok":true}',
		expected: [{ kind: "text", text: '{"tag":"CLIO_RC_JSON","ok":true}' }],
	},
	{
		name: "a role-only frame is final text",
		input: "<|start|>assistant<|message|>Plain answer.<|end|>",
		expected: [{ kind: "text", text: "Plain answer." }],
	},
	{
		name: "unknown markers pass through as text",
		input: "<|foo|>bar<|unknown_token|>",
		expected: [{ kind: "text", text: "<|foo|>bar<|unknown_token|>" }],
	},
	{
		name: "ordinary text that only resembles a marker is untouched",
		input: "Write <|start then <|channel|| and <|message to open a frame; <|startup|> is not one.",
		expected: [
			{ kind: "text", text: "Write <|start then <|channel|| and <|message to open a frame; <|startup|> is not one." },
		],
	},
	{
		name: "plain text without markers",
		input: "The answer is 6.",
		expected: [{ kind: "text", text: "The answer is 6." }],
	},
];

function merged(segments: HarmonySegment[]): HarmonySegment[] {
	const out: HarmonySegment[] = [];
	for (const segment of segments) {
		const last = out[out.length - 1];
		if (segment.kind === "text" && last?.kind === "text") {
			last.text += segment.text;
			continue;
		}
		if (
			segment.kind === "thinking" &&
			last?.kind === "thinking" &&
			last.note === segment.note &&
			last.channel === segment.channel
		) {
			last.text += segment.text;
			continue;
		}
		out.push({ ...segment });
	}
	return out;
}

function parse(input: string, splitAt: number | null): HarmonySegment[] {
	const parser = new HarmonyResponseParser();
	const segments: HarmonySegment[] = [];
	if (splitAt === null) segments.push(...parser.push(input));
	else {
		segments.push(...parser.push(input.slice(0, splitAt)));
		segments.push(...parser.push(input.slice(splitAt)));
	}
	segments.push(...parser.flush());
	return merged(segments);
}

function parseByteByByte(input: string): HarmonySegment[] {
	const parser = new HarmonyResponseParser();
	const segments: HarmonySegment[] = [];
	for (const char of input) segments.push(...parser.push(char));
	segments.push(...parser.flush());
	return merged(segments);
}

describe("contracts/harmony-response-parser", () => {
	for (const golden of GOLDENS) {
		it(`${golden.name}: identical segments at every byte boundary`, () => {
			deepStrictEqual(parse(golden.input, null), golden.expected, "whole input");
			for (let split = 1; split < golden.input.length; split++) {
				deepStrictEqual(parse(golden.input, split), golden.expected, `split at byte ${split}`);
			}
			deepStrictEqual(parseByteByByte(golden.input), golden.expected, "one byte per push");
		});
	}

	it("reports whether any marker was consumed", () => {
		const raw = new HarmonyResponseParser();
		raw.push("<|channel|>final<|message|>hi");
		raw.flush();
		strictEqual(raw.markersSeen, true);
		const plain = new HarmonyResponseParser();
		plain.push("hi <|not a marker");
		plain.flush();
		strictEqual(plain.markersSeen, false);
	});

	it("normalizes Harmony tool names and rejects provider artifacts", () => {
		deepStrictEqual(normalizeHarmonyToolName("functions.bash"), { name: "bash" });
		deepStrictEqual(normalizeHarmonyToolName("bash"), { name: "bash" });
		// vllm#58825: a stray `commentary to=assistant` header returned as a tool.
		strictEqual("artifact" in normalizeHarmonyToolName("assistant<|channel|>analysis"), true);
		strictEqual("artifact" in normalizeHarmonyToolName("commentary to=functions.bash"), true);
		strictEqual("artifact" in normalizeHarmonyToolName("bash ls"), true);
		strictEqual("artifact" in normalizeHarmonyToolName("functions."), true);
	});
});

function sse(frames: unknown[]): Response {
	const body = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function chunkFrames(modelId: string, contents: string[]): unknown[] {
	return contents.map((content) => ({
		id: "chatcmpl-harmony",
		object: "chat.completion.chunk",
		created: 1,
		model: modelId,
		choices: [{ index: 0, delta: { content } }],
	}));
}

function stopFrame(modelId: string): unknown {
	return {
		id: "chatcmpl-harmony",
		object: "chat.completion.chunk",
		created: 1,
		model: modelId,
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		usage: { prompt_tokens: 4, completion_tokens: 12, total_tokens: 16 },
	};
}

async function streamText(modelId: string, contents: string[]): Promise<{ streamed: string; final: string }> {
	const model = {
		id: modelId,
		name: modelId,
		api: "openai-completions",
		provider: "llamacpp",
		baseUrl: "http://127.0.0.1:1/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 32768,
		compat: { maxTokensField: "max_tokens", supportsUsageInStreaming: true },
	} satisfies Parameters<typeof openAICompletionsApiProvider.stream>[0];
	const events = openAICompletionsApiProvider.stream(
		model,
		{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
		{
			apiKey: "sk-test",
			fetch: async () => sse([...chunkFrames(modelId, contents), stopFrame(modelId)]),
		},
	);
	const deltas: string[] = [];
	let final = "";
	for await (const event of events) {
		if (event.type === "text_delta") deltas.push(event.delta);
		if (event.type === "error") throw new Error(event.error.errorMessage ?? "stream error");
		if (event.type === "done") {
			final = event.message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("");
		}
	}
	return { streamed: deltas.join(""), final };
}

describe("contracts/harmony-response-parser through the openai-compatible adapter", () => {
	it("strips raw GPT-OSS Harmony final-channel markers from openai-compatible text", async () => {
		const { streamed, final } = await streamText("openai/gpt-oss-20b", [
			"<|start|>assistant<|channel|>",
			"final<|message|>Hi there!",
			" What can I help with today?",
		]);
		strictEqual(streamed, "Hi there! What can I help with today?");
		strictEqual(final, streamed);
		strictEqual(streamed.includes("<|start|>"), false);
		strictEqual(streamed.includes("<|channel|>"), false);
		strictEqual(streamed.includes("<|message|>"), false);
	});

	it("routes Harmony constrained final-channel JSON to visible text", async () => {
		const { streamed, final } = await streamText("gpt-oss:20b", [
			"<|channel|>final <|constrain|>json<|message|>",
			'{"tag":"CLIO_RC_JSON","ok":true}',
		]);
		strictEqual(streamed, '{"tag":"CLIO_RC_JSON","ok":true}');
		strictEqual(final, streamed);
	});
});
