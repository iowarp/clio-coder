import { strictEqual } from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Model } from "@earendil-works/pi-ai";

import { openAICompletionsApiProvider } from "../../src/engine/apis/openai-completions.js";
import {
	closeServer,
	type OpenAICompatFixture,
	type OpenAICompatFixtureOptions,
	startOpenAICompatFixture,
} from "../harness/openai-compat-fixture.js";

/**
 * Issue #269: LM Studio streams gpt-oss's Harmony analysis channel as
 * `delta.reasoning`, not `delta.reasoning_content` (measured 2026-09-02 on
 * dynamo, `scratchpad/catalog/conformance/dynamo/openai/gpt-oss-20b`). Both
 * spellings have to land in thinking content and stay out of the answer.
 */

const fixtures: OpenAICompatFixture[] = [];

afterEach(async () => {
	await Promise.all(fixtures.splice(0).map((fixture) => closeServer(fixture.server)));
});

const MODEL_ID = "openai/gpt-oss-20b";

async function fixture(field: NonNullable<OpenAICompatFixtureOptions["reasoningField"]>): Promise<OpenAICompatFixture> {
	const started = await startOpenAICompatFixture("ready", {
		models: [{ id: MODEL_ID, object: "model" }],
		reasoningChunks: ["User wants ", '"ready".'],
		reasoningField: field,
	});
	fixtures.push(started);
	return started;
}

function model(server: OpenAICompatFixture): Model<"openai-completions"> {
	return {
		id: MODEL_ID,
		name: MODEL_ID,
		api: "openai-completions",
		provider: "lmstudio",
		baseUrl: `${server.url}/v1`,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 32768,
		compat: { thinkingFormat: "harmony" },
		clioCoder: {
			targetId: "dynamo",
			runtimeId: "lmstudio",
			family: "openai-gpt-oss",
			chatTemplateKwargsUnsupported: true,
		},
	} as unknown as Model<"openai-completions">;
}

async function streamed(
	server: OpenAICompatFixture,
): Promise<{ text: string; thinking: string; doneThinking: string }> {
	const text: string[] = [];
	const thinking: string[] = [];
	let doneThinking = "";
	const stream = openAICompletionsApiProvider.streamSimple(
		model(server),
		{ messages: [{ role: "user", content: "Reply with the single word ready.", timestamp: 0 }] },
		{ apiKey: "fixture", reasoning: "low" },
	);
	for await (const event of stream) {
		if (event.type === "text_delta") text.push(event.delta);
		if (event.type === "thinking_delta") thinking.push(event.delta);
		if (event.type === "error") throw new Error(event.error.errorMessage ?? "stream error");
		if (event.type === "done") {
			doneThinking = event.message.content
				.filter((block) => block.type === "thinking")
				.map((block) => (block as { thinking: string }).thinking)
				.join("");
		}
	}
	return { text: text.join(""), thinking: thinking.join(""), doneThinking };
}

describe("contracts/LM Studio reasoning field aliases", () => {
	for (const field of ["reasoning", "reasoning_content", "reasoning_text"] as const) {
		it(`captures delta.${field} as thinking content and keeps it out of the answer`, async () => {
			const server = await fixture(field);
			const result = await streamed(server);
			strictEqual(result.text, "ready");
			strictEqual(result.thinking, 'User wants "ready".');
			strictEqual(result.doneThinking, 'User wants "ready".');
		});
	}

	it("sends the Harmony effort as reasoning_effort and nothing under chat_template_kwargs to LM Studio", async () => {
		const server = await fixture("reasoning");
		await streamed(server);
		const request = server.requests.at(-1) as Record<string, unknown>;
		strictEqual(request.reasoning_effort, "low");
		strictEqual(request.chat_template_kwargs, undefined);
	});
});
