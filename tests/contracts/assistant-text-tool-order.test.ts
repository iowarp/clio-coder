import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { openAICompletionsApiProvider } from "../../src/engine/apis/openai-completions.js";
import { filterAssistantProseStream } from "../../src/engine/assistant-prose-stream.js";

/**
 * The openai-compatible adapter keeps a text block open while a tool call
 * streams and closes it only at the end of the message. The sentinel stripper
 * and the prose filter each hold a tail of the text, which then reached the
 * transcript after the tool rows: "I'll look at the project firs", the tool
 * rows, then a stray "t." bubble.
 */

const MODEL_ID = "fake-model";

function sse(frames: unknown[]): Response {
	const body = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function frame(delta: Record<string, unknown>, finish: string | null = null): unknown {
	return {
		id: "chatcmpl-order",
		object: "chat.completion.chunk",
		created: 1,
		model: MODEL_ID,
		choices: [{ index: 0, delta, finish_reason: finish }],
	};
}

async function streamEvents(words: string[]): Promise<Array<{ type: string; delta?: string }>> {
	const model = {
		id: MODEL_ID,
		name: MODEL_ID,
		api: "openai-completions",
		provider: "fake",
		baseUrl: "http://127.0.0.1:1/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 4096,
		compat: { maxTokensField: "max_tokens", supportsUsageInStreaming: true },
	} satisfies Parameters<typeof openAICompletionsApiProvider.stream>[0];
	const frames = [
		...words.map((content) => frame({ content })),
		frame({
			tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }],
		}),
		frame({}, "tool_calls"),
	];
	const source = openAICompletionsApiProvider.stream(
		model,
		{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
		{ apiKey: "sk-test", fetch: async () => sse(frames) },
	);
	const events: Array<{ type: string; delta?: string }> = [];
	for await (const event of filterAssistantProseStream(source, model)) {
		if (event.type === "error") throw new Error(event.error.errorMessage ?? "stream error");
		events.push(event.type === "text_delta" ? { type: event.type, delta: event.delta } : { type: event.type });
	}
	return events;
}

describe("contracts/assistant-text-tool-order", () => {
	it("releases every held character of the text before the tool call starts", async () => {
		const events = await streamEvents(["I'll look at the ", "project first."]);
		const toolStart = events.findIndex((event) => event.type === "toolcall_start");
		strictEqual(toolStart > 0, true);
		const before = events
			.slice(0, toolStart)
			.filter((event) => event.type === "text_delta")
			.map((event) => event.delta)
			.join("");
		strictEqual(before, "I'll look at the project first.");
		deepStrictEqual(
			events.slice(toolStart).filter((event) => event.type === "text_delta" && event.delta !== ""),
			[],
		);
	});
});
