import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import { openAICompletionsApiProvider } from "../../src/engine/apis/openai-completions.js";
import type { Model } from "../../src/engine/types.js";

const reasoning = "Need to run with PYTHONPATH.";
const narration = "The clone succeeded; rerunning with PYTHONPATH set.";
const usage = {
	input: 12,
	output: 32,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 44,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function fixtureModel(modelId: string): Model<"openai-completions"> {
	const model = litellm.synthesizeModel(
		{ id: "fixture", runtime: "litellm", url: "http://fixture.invalid" },
		modelId,
		null,
	) as Model<"openai-completions">;
	model.reasoning = true;
	return model;
}

function toolTurn(model: Model<"openai-completions">, text: string): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [
			{ type: "thinking", thinking: reasoning, thinkingSignature: "reasoning" },
			...(text ? [{ type: "text" as const, text }] : []),
			{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "true" } },
		],
		stopReason: "toolUse",
		timestamp: 1,
		usage,
	};
}

interface WireMessage {
	role: string;
	content?: unknown;
	reasoning?: string;
	tool_calls?: unknown[];
}

async function capture(model: Model<"openai-completions">, message: AssistantMessage) {
	const context: Context = {
		messages: [
			{ role: "user", content: "Run the test.", timestamp: 0 },
			message,
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "bash",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: 2,
			},
			{ role: "user", content: "what is 3+3?", timestamp: 3 },
		],
	};
	const before = structuredClone(context);
	let request: { messages: WireMessage[] } | undefined;
	const stream = openAICompletionsApiProvider.streamSimple(model, context, {
		apiKey: "fixture",
		maxTokens: 128,
		reasoning: "low",
		fetch: async (_url: unknown, init?: RequestInit) => {
			request = JSON.parse(String(init?.body)) as { messages: WireMessage[] };
			const frame = { model: model.id, choices: [{ index: 0, delta: { content: "6" }, finish_reason: "stop" }] };
			return new Response(`data: ${JSON.stringify(frame)}\n\ndata: [DONE]\n\n`, {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	strictEqual((await stream.result()).stopReason, "stop");
	deepStrictEqual(context, before, "request repair must not mutate the transcript");
	ok(request);
	const assistant = request.messages.find((m) => m.role === "assistant");
	ok(assistant);
	return assistant;
}

test("gpt-oss replay never sends content, reasoning and tool_calls in one assistant turn", async () => {
	const model = fixtureModel("openai/gpt-oss-120b");
	const assistant = await capture(model, toolTurn(model, narration));
	strictEqual(assistant.reasoning, undefined);
	ok(JSON.stringify(assistant.content).includes(narration));
	strictEqual(assistant.tool_calls?.length, 1);
});

test("gpt-oss replay keeps reasoning on a tool turn without text", async () => {
	const model = fixtureModel("openai/gpt-oss-120b");
	const assistant = await capture(model, toolTurn(model, ""));
	strictEqual(assistant.reasoning, reasoning);
	strictEqual(assistant.tool_calls?.length, 1);
});

test("non-harmony replay keeps reasoning beside text and tool calls", async () => {
	const model = fixtureModel("dynamo/qwen3.8-27b");
	const assistant = await capture(model, toolTurn(model, narration));
	strictEqual(assistant.reasoning, reasoning);
});
