import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";

import { openAICompletionsApiProvider } from "../../src/engine/apis/openai-completions.js";
import { createGemmaChannelFilter, type GemmaChannelSegment } from "../../src/engine/gemma-channel-filter.js";
import { closeServer, type OpenAICompatFixture, startOpenAICompatFixture } from "../harness/openai-compat-fixture.js";

const fixtures: OpenAICompatFixture[] = [];

afterEach(async () => {
	await Promise.all(fixtures.splice(0).map((fixture) => closeServer(fixture.server)));
});

function filtered(chunks: string[]): GemmaChannelSegment[] {
	const filter = createGemmaChannelFilter();
	return [...chunks.flatMap((chunk) => filter.push(chunk)), ...filter.flush()];
}

async function fixture(reply: string): Promise<OpenAICompatFixture> {
	const started = await startOpenAICompatFixture(reply);
	fixtures.push(started);
	return started;
}

function model(server: OpenAICompatFixture, id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "openai-compat",
		baseUrl: `${server.url}/v1`,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
		clioCoder: { targetId: "fixture", runtimeId: "openai-compat" },
	} as unknown as Model<"openai-completions">;
}

async function streamReply(server: OpenAICompatFixture, id: string): Promise<{ text: string; thinking: string }> {
	const text: string[] = [];
	const thinking: string[] = [];
	const stream = openAICompletionsApiProvider.streamSimple(
		model(server, id),
		{ messages: [{ role: "user", content: "hello", timestamp: 0 }] },
		{ apiKey: "fixture", reasoning: "low" },
	);
	for await (const event of stream) {
		if (event.type === "text_delta") text.push(event.delta);
		if (event.type === "thinking_delta") thinking.push(event.delta);
	}
	return { text: text.join(""), thinking: thinking.join("") };
}

describe("contracts/gemma-4 channel filtering", () => {
	it("reassembles a thought marker split across chunks", () => {
		deepStrictEqual(filtered(["<|chan", "nel>thought\nsecret<chan", "nel|>answer"]), [
			{ kind: "thinking", content: "secret" },
			{ kind: "text", content: "answer" },
		]);
	});

	it("drops a bare ownthought label and a fallback tool-call region", () => {
		deepStrictEqual(filtered(["ownthought\n", '<tool_call|>{"name":"read"}', "<|tool_call|>Done."]), [
			{ kind: "text", content: "Done." },
		]);
	});

	it("drops an orphan thought closer while idle", () => {
		const segments = filtered(["before<channel|>after"]);
		strictEqual(segments.map((segment) => segment.content).join(""), "beforeafter");
		strictEqual(
			segments.every((segment) => segment.kind === "text"),
			true,
		);
	});

	it("reclassifies gemma channel text on the OpenAI-compatible stream", async () => {
		const server = await fixture("<|channel>own-think\nprivate thought<channel|>Visible answer.");
		const result = await streamReply(server, "google/gemma-4-26b-a4b");
		strictEqual(result.text, "Visible answer.");
		strictEqual(result.thinking, "private thought");
		strictEqual(result.text.includes("<|channel>"), false);
	});

	it("leaves the same marker bytes untouched for a non-gemma family", async () => {
		const reply = "<|channel>thought\nprivate<channel|>visible";
		const server = await fixture(reply);
		const result = await streamReply(server, "qwen3.8-27b");
		strictEqual(result.text, reply);
		strictEqual(result.thinking, "");
	});
});
