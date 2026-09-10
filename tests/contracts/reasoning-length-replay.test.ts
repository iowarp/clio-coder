import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import { openAICompletionsApiProvider } from "../../src/engine/apis/openai-completions.js";
import { setGlobalDefaultMaxOutputTokens } from "../../src/engine/apis/output-budget.js";
import type { Model } from "../../src/engine/types.js";
import { startWorkerRun, type WorkerRunHandle } from "../../src/engine/worker-runtime.js";
import { closeServer, readRequestBody } from "../harness/openai-compat-fixture.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const modelId = "dynamo/qwen3.8-27b";
const reasoning = "Private intermediate fixture result: coefficient = 0.002.";
const usage = {
	input: 12,
	output: 32,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 44,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function fixtureModel(): Model<"openai-completions"> {
	const model = litellm.synthesizeModel(
		{ id: "fixture", runtime: "litellm", url: "http://fixture.invalid" },
		modelId,
		null,
	) as Model<"openai-completions">;
	model.reasoning = true;
	return model;
}

function interrupted(model: Model<"openai-completions">, signature = "reasoning_content"): AssistantMessage {
	return {
		role: "assistant",
		api: model.api,
		provider: model.provider,
		model: model.id,
		content: [{ type: "thinking", thinking: reasoning, thinkingSignature: signature }],
		stopReason: "length",
		timestamp: 1,
		usage,
	};
}

function response(delta: Record<string, unknown>, finish = "stop"): string {
	return `data: ${JSON.stringify({ model: modelId, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`;
}

interface WireMessage {
	role: string;
	content?: unknown;
	reasoning_content?: string;
	reasoning?: string;
	reasoning_text?: string;
}
interface Request {
	messages: WireMessage[];
	max_tokens: number;
}

async function capture(model: Model<"openai-completions">, message: AssistantMessage, bare = false, off = false) {
	const context: Context = {
		messages: [
			{ role: "user", content: "Compute the coefficient.", timestamp: 0 },
			message,
			{ role: "user", content: "Continue from the interrupted computation.", timestamp: 2 },
		],
	};
	const before = structuredClone(context);
	let request: Request | undefined;
	const options = {
		apiKey: "fixture",
		maxTokens: 128,
		...(off ? {} : { reasoning: "xhigh" as const }),
		fetch: async (_url: unknown, init?: RequestInit) => {
			request = JSON.parse(String(init?.body)) as Request;
			return new Response(response({ content: "Complete." }), { headers: { "content-type": "text/event-stream" } });
		},
	};
	const stream = bare
		? openAICompletionsApiProvider.stream(model, context, options)
		: openAICompletionsApiProvider.streamSimple(model, context, options);
	const result = await stream.result();
	strictEqual(result.stopReason, "stop");
	deepStrictEqual(context, before, "request repair must not mutate transcript, usage, signatures or stop reason");
	deepStrictEqual(result.content, [{ type: "text", text: "Complete." }]);
	ok(request);
	strictEqual(request.max_tokens, 128);
	return request;
}

for (const signature of ["reasoning_content", "reasoning", "reasoning_text"] as const) {
	for (const bare of [false, true]) {
		test(`${bare ? "stream" : "streamSimple"} retains truncated ${signature} in the next real request`, async () => {
			const model = fixtureModel();
			const request = await capture(model, interrupted(model, signature), bare);
			const assistant = request.messages.find((m) => m.role === "assistant");
			ok(assistant, "reasoning-only length message disappeared from the next request");
			strictEqual(assistant[signature], reasoning);
			strictEqual(JSON.stringify(assistant.content).includes(reasoning), false, "private reasoning is never answer text");
			deepStrictEqual(
				request.messages.map((m) => m.role),
				["user", "assistant", "user"],
			);
		});
	}
}

for (const variant of [
	"model-switch",
	"provider-switch",
	"api-switch",
	"off",
	"unsigned",
	"encrypted",
	"stop",
	"error",
	"aborted",
	"text",
] as const) {
	test(`replay repair preserves existing semantics for ${variant}`, async () => {
		const model = fixtureModel();
		const message = interrupted(model);
		switch (variant) {
			case "model-switch":
				message.model = "different-model";
				break;
			case "provider-switch":
				message.provider = "different-provider";
				break;
			case "api-switch":
				message.api = "anthropic-messages";
				break;
			case "unsigned":
				message.content = [{ type: "thinking", thinking: reasoning }];
				break;
			case "encrypted":
				message.content = [{ type: "thinking", thinking: reasoning, thinkingSignature: "opaque-signature" }];
				break;
			case "stop":
			case "error":
			case "aborted":
				message.stopReason = variant;
				break;
			case "text":
				message.content.push({ type: "text", text: "Already answered." });
				break;
		}
		const request = await capture(model, message, false, variant === "off");
		const assistant = request.messages.find((m) => m.role === "assistant");
		if (variant === "text") {
			strictEqual(assistant?.content, "Already answered.");
			strictEqual(assistant.reasoning_content, reasoning);
		} else {
			// Pi can translate cross-model thought into ordinary context. This
			// repair must neither add an interruption notice nor restore raw fields.
			strictEqual(assistant?.reasoning_content, undefined);
			ok(!JSON.stringify(request).includes("interrupted before"));
		}
	});
}

test("real worker preserves the length-limited thought through contract repair and finishes", {
	timeout: 10000,
}, async () => {
	const env = await isolateClioEnv("clio-coder-reasoning-replay-");
	const requests: Request[] = [];
	let worker: WorkerRunHandle | undefined;
	const server = createServer(async (req, res) => {
		const request = JSON.parse(await readRequestBody(req)) as Request;
		requests.push(request);
		res.setHeader("content-type", "text/event-stream");
		if (requests.length === 1) res.end(response({ reasoning_content: reasoning }, "length"));
		else {
			const retained = request.messages.some((m) => m.reasoning_content === reasoning);
			res.end(response({ content: retained ? "The coefficient is 0.002." : "" }));
		}
	});
	try {
		mkdirSync(join(env.dir, "config"), { recursive: true });
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.chat.maxOutputTokens = 16384;
		writeFileSync(join(env.dir, "config/settings.yaml"), JSON.stringify(settings));
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		worker = startWorkerRun(
			{
				agentId: "replay-fixture",
				systemPrompt: "Compute the requested value.",
				task: "Finish the computation.",
				target: { id: "fixture", runtime: "litellm", url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` },
				runtime: litellm,
				wireModelId: modelId,
				apiKey: "fixture",
				thinkingLevel: "xhigh",
				modelCapabilities: { contextWindow: 131072, maxTokens: 131072, tools: true, reasoning: true },
				allowedTools: [],
				budget: { mode: "advisory", toolCalls: 40, readReserve: 0, synthesis: true, hardCap: 60 },
				resultContract: { kind: "artifact-report" },
				product: "orientation",
				noSkills: true,
				cwd: env.dir,
				autonomy: "full-auto",
			},
			() => {},
		);
		const result = await worker.promise;
		strictEqual(result.exitCode, 0);
		strictEqual(requests.length, 2, "one bounded repair, not repeated empty-context attempts");
		for (const request of requests) strictEqual(request.max_tokens, 16384);
		const original = result.messages.find((m) => m.role === "assistant" && m.stopReason === "length");
		ok(original?.role === "assistant");
		ok(
			original.content.every((part) => part.type === "thinking"),
			"no synthetic answer persisted",
		);
	} finally {
		worker?.abort();
		await worker?.promise;
		await closeServer(server);
		setGlobalDefaultMaxOutputTokens(DEFAULT_SETTINGS.chat.maxOutputTokens);
		env.restore();
	}
});
