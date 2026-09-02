import { strictEqual } from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";

import { openAICompletionsApiProvider } from "../../src/engine/apis/openai-completions.js";
import { closeServer, type OpenAICompatFixture, startOpenAICompatFixture } from "../harness/openai-compat-fixture.js";

/**
 * The 2026-09-01 naming migration moved synthesized model metadata from
 * `model.clio` to `model.clioCoder` (`synthLocalModel`), and the engine's
 * readers kept reading the old key, so every LM Studio and llama.cpp turn
 * since ran without the runtime payload: LM Studio kept receiving
 * `chat_template_kwargs`, sampling profiles never applied, llama.cpp never
 * got `cache_prompt`. These pin the wire for a model shaped the way the
 * synthesizer shapes it.
 */

const fixtures: OpenAICompatFixture[] = [];

afterEach(async () => {
	await Promise.all(fixtures.splice(0).map((fixture) => closeServer(fixture.server)));
});

async function fixture(id: string): Promise<OpenAICompatFixture> {
	const started = await startOpenAICompatFixture("ok", { models: [{ id, object: "model" }] });
	fixtures.push(started);
	return started;
}

function model(
	server: OpenAICompatFixture,
	id: string,
	provider: "lmstudio" | "llamacpp",
	clioCoder: Record<string, unknown>,
): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: `${server.url}/v1`,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
		compat: { thinkingFormat: "qwen-chat-template" },
		clioCoder: { targetId: "fixture", runtimeId: provider, ...clioCoder },
	} as unknown as Model<"openai-completions">;
}

async function lastRequest(
	server: OpenAICompatFixture,
	target: Model<"openai-completions">,
	reasoning?: string,
): Promise<Record<string, unknown>> {
	const stream = openAICompletionsApiProvider.streamSimple(
		target,
		{ messages: [{ role: "user", content: "hello", timestamp: 0 }] },
		{ apiKey: "fixture", ...(reasoning ? { reasoning } : {}) } as never,
	);
	for await (const event of stream) {
		if (event.type === "error") throw new Error(event.error.errorMessage ?? "stream error");
	}
	const request = server.requests.at(-1);
	if (!request) throw new Error("fixture recorded no chat request");
	return request;
}

describe("contracts/engine reads model.clioCoder", () => {
	it("LM Studio thinking off sends reasoning_effort none and no chat_template_kwargs (#268)", async () => {
		const id = "gemma-4-26b-a4b-it";
		const server = await fixture(id);
		const request = await lastRequest(
			server,
			model(server, id, "lmstudio", { family: "gemma4-26b-a4b", chatTemplateKwargsUnsupported: true }),
		);
		strictEqual(request.reasoning_effort, "none");
		strictEqual(request.chat_template_kwargs, undefined);
	});

	it("LM Studio thinking low on an on-off family sends reasoning_effort low", async () => {
		const id = "nvidia-nemotron-3.5-lightning-30b-a3b";
		const server = await fixture(id);
		const request = await lastRequest(
			server,
			model(server, id, "lmstudio", { family: "nemotron-3.5-lightning-30b-a3b", chatTemplateKwargsUnsupported: true }),
			"low",
		);
		strictEqual(request.reasoning_effort, "low");
		strictEqual(request.chat_template_kwargs, undefined);
	});

	it("applies the family sampling profile from clioCoder.quirks", async () => {
		const id = "qwen3.8-27b-dynamo";
		const server = await fixture(id);
		const request = await lastRequest(
			server,
			model(server, id, "lmstudio", {
				family: "qwen3.8-27b",
				chatTemplateKwargsUnsupported: true,
				quirks: { sampling: { instruct: { temperature: 0.55, topP: 0.8 } } },
			}),
		);
		strictEqual(request.temperature, 0.55);
		strictEqual(request.top_p, 0.8);
	});

	it("llama.cpp keeps the template flag and asks for the prompt cache", async () => {
		const id = "gemma4-26b-moe";
		const server = await fixture(id);
		const request = await lastRequest(
			server,
			model(server, id, "llamacpp", { family: "gemma4-26b-a4b", lifecycle: "user-managed" }),
		);
		strictEqual(request.cache_prompt, true);
		strictEqual(request.reasoning_effort, undefined);
		strictEqual((request.chat_template_kwargs as Record<string, unknown>)?.enable_thinking, false);
	});
});
