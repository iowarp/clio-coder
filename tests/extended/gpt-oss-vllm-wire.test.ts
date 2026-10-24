import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";

import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import { classifyRecoveryFailure, isRetryableErrorMessage } from "../../src/domains/session/retry.js";
import { openAICompletionsApiProvider } from "../../src/engine/apis/openai-completions.js";
import { harmonyServerParsing } from "../../src/engine/harmony-failure.js";
import type { Model } from "../../src/engine/types.js";

/**
 * #435: gpt-oss on vLLM. The frames below are synthetic. No vLLM capture exists
 * yet (capturing needs a GPU model swap the maintainer holds), so each frame is
 * built from the Harmony response grammar
 * (https://cookbook.openai.com/articles/openai-harmony) and the upstream issue
 * bodies it cites: vllm#51977 (HarmonyError 500), vllm#45736 (content null with
 * finish_reason stop), vllm#58825 (a `commentary to=assistant` header returned
 * as a tool named `assistant<|channel|>analysis`). Server configurations:
 *   A: --reasoning-parser openai_gptoss --tool-call-parser openai (structured)
 *   B: --reasoning-parser openai_gptoss only (reasoning_content, raw tool call)
 *   C: no parsers (raw analysis and raw tool call in content)
 */

const MODEL_ID = "openai/gpt-oss-20b";
const TOOLS = [
	{
		name: "bash",
		description: "Run a shell command",
		parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
	},
];
const RAW_TOOL_CALL =
	'<|channel|>commentary to=functions.bash <|constrain|>json<|message|>{"command":"ls /tmp"}<|call|>';
const RAW_ANALYSIS = "<|channel|>analysis<|message|>User wants the listing. Call bash.<|end|><|start|>assistant";
const USAGE_FIRST = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
const USAGE_SECOND = { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 };

function vllmModel(): Model<"openai-completions"> {
	return {
		id: MODEL_ID,
		name: MODEL_ID,
		api: "openai-completions",
		provider: "vllm",
		baseUrl: "http://127.0.0.1:1/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 32768,
		compat: { thinkingFormat: "harmony" },
		clioCoder: { targetId: "mini-vllm", runtimeId: "vllm", family: "openai-gpt-oss" },
	} as unknown as Model<"openai-completions">;
}

function chunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): unknown {
	return {
		id: "chatcmpl-vllm",
		object: "chat.completion.chunk",
		created: 1,
		model: MODEL_ID,
		choices: [{ index: 0, delta, ...extra }],
	};
}

function stop(finish: "stop" | "tool_calls", usage = USAGE_FIRST): unknown {
	return {
		id: "chatcmpl-vllm",
		object: "chat.completion.chunk",
		created: 1,
		model: MODEL_ID,
		choices: [{ index: 0, delta: {}, finish_reason: finish }],
		usage,
	};
}

function sse(frames: unknown[]): Response {
	const body = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

/** Split raw content into 7-byte deltas so markers straddle frames. */
function contentChunks(content: string): unknown[] {
	const out: unknown[] = [];
	for (let i = 0; i < content.length; i += 7) out.push(chunk({ content: content.slice(i, i + 7) }));
	return out;
}

const ANSWER_FRAMES = [chunk({ role: "assistant", content: "6" }), stop("stop", USAGE_SECOND)];

interface Streamed {
	events: string[];
	thinkingDeltas: string;
	textDeltas: string;
	result: AssistantMessage;
	requests: string[];
}

async function run(responses: Array<() => Response>, context?: Context): Promise<Streamed> {
	const requests: string[] = [];
	const events: string[] = [];
	let thinkingDeltas = "";
	let textDeltas = "";
	const stream = openAICompletionsApiProvider.streamSimple(
		vllmModel(),
		context ?? { messages: [{ role: "user", content: "List /tmp.", timestamp: 0 }], tools: TOOLS },
		{
			apiKey: "fixture",
			reasoning: "low",
			fetch: async (_url: unknown, init?: RequestInit) => {
				requests.push(String(init?.body));
				const next = responses[requests.length - 1] ?? responses[responses.length - 1];
				ok(next, "fixture response");
				return next();
			},
		},
	);
	for await (const event of stream) {
		events.push(event.type);
		if (event.type === "thinking_delta") thinkingDeltas += event.delta;
		if (event.type === "text_delta") textDeltas += event.delta;
	}
	return { events, thinkingDeltas, textDeltas, result: await stream.result(), requests };
}

function blocks(message: AssistantMessage, type: AssistantMessage["content"][number]["type"]) {
	return message.content.filter((block) => block.type === type);
}

describe("extended/gpt-oss on vLLM: server configurations", () => {
	it("A: structured reasoning_content and tool_calls are used; no recovered raw call duplicates them", async () => {
		const frames = [
			chunk({ role: "assistant", reasoning_content: "User wants the listing. " }),
			chunk({ reasoning_content: "Call bash." }),
			chunk({
				tool_calls: [
					{ index: 0, id: "chatcmpl-tool-1", type: "function", function: { name: "bash", arguments: '{"command":' } },
				],
			}),
			chunk({ tool_calls: [{ index: 0, function: { arguments: '"ls /tmp"}' } }] }),
			stop("tool_calls"),
		];
		const { result, requests, thinkingDeltas } = await run([() => sse(frames)]);
		strictEqual(requests.length, 1);
		strictEqual(result.stopReason, "toolUse");
		const calls = blocks(result, "toolCall");
		strictEqual(calls.length, 1);
		deepStrictEqual(calls[0], {
			type: "toolCall",
			id: "chatcmpl-tool-1",
			name: "bash",
			arguments: { command: "ls /tmp" },
		});
		const thinking = blocks(result, "thinking");
		strictEqual(thinking.length, 1);
		strictEqual(thinking[0]?.type === "thinking" ? thinking[0].thinkingSignature : "", "reasoning_content");
		strictEqual(thinkingDeltas, "User wants the listing. Call bash.");
		strictEqual(result.harmonyRecovery?.synthesizedToolCalls, 0);
		strictEqual(result.harmonyRecovery?.structuredToolCalls, 1);
		strictEqual(harmonyServerParsing(result.harmonyRecovery), "full");
	});

	it("A: a structured tool name under the functions namespace is stripped to the tool", async () => {
		const frames = [
			chunk({
				role: "assistant",
				tool_calls: [
					{
						index: 0,
						id: "chatcmpl-tool-2",
						type: "function",
						function: { name: "functions.bash", arguments: '{"command":"true"}' },
					},
				],
			}),
			stop("tool_calls"),
		];
		const { result } = await run([() => sse(frames)]);
		const call = blocks(result, "toolCall")[0];
		strictEqual(call?.type === "toolCall" ? call.name : "", "bash");
		strictEqual(result.stopReason, "toolUse");
	});

	it("B: reasoning_content plus a raw commentary tool call becomes thinking and a synthesized tool call", async () => {
		const frames = [
			chunk({ role: "assistant", reasoning_content: "Need the listing." }),
			...contentChunks(RAW_TOOL_CALL),
			stop("stop"),
		];
		const { result, requests, events, textDeltas } = await run([() => sse(frames)]);
		strictEqual(requests.length, 1);
		strictEqual(result.stopReason, "toolUse");
		strictEqual(textDeltas, "");
		const calls = blocks(result, "toolCall");
		strictEqual(calls.length, 1);
		ok(calls[0]?.type === "toolCall" && calls[0].id.startsWith("harmony_"), "synthesized id");
		deepStrictEqual(calls[0]?.type === "toolCall" ? calls[0].arguments : null, { command: "ls /tmp" });
		strictEqual(blocks(result, "text").length, 0, "the raw frame leaves no text block behind");
		const thinking = blocks(result, "thinking");
		strictEqual(thinking.length, 1);
		strictEqual(thinking[0]?.type === "thinking" ? thinking[0].thinkingSignature : "", "reasoning_content");
		ok(events.includes("toolcall_start") && events.includes("toolcall_end"), "tool call events were streamed");
		strictEqual(harmonyServerParsing(result.harmonyRecovery), "reasoning-only");
	});

	it("C: raw analysis streams as thinking and the raw tool call executes with stopReason toolUse", async () => {
		const frames = [...contentChunks(`${RAW_ANALYSIS}${RAW_TOOL_CALL}`), stop("stop")];
		const { result, events, thinkingDeltas, textDeltas } = await run([() => sse(frames)]);
		strictEqual(result.stopReason, "toolUse");
		strictEqual(thinkingDeltas, "User wants the listing. Call bash.");
		strictEqual(textDeltas, "");
		ok(events.indexOf("thinking_start") < events.indexOf("thinking_end"), "thinking opened before it closed");
		ok(events.indexOf("thinking_end") < events.indexOf("toolcall_start"), "thinking closed before the tool call");
		const thinking = blocks(result, "thinking");
		strictEqual(thinking.length, 1);
		strictEqual(thinking[0]?.type === "thinking" ? thinking[0].thinking : "", "User wants the listing. Call bash.");
		strictEqual(thinking[0]?.type === "thinking" ? thinking[0].thinkingSignature : "", "reasoning_content");
		const calls = blocks(result, "toolCall");
		strictEqual(calls.length, 1);
		deepStrictEqual(calls[0]?.type === "toolCall" ? calls[0].arguments : null, { command: "ls /tmp" });
		strictEqual(result.harmonyRecovery?.recoveredThinking, true);
		strictEqual(harmonyServerParsing(result.harmonyRecovery), "none");
		ok(!JSON.stringify(result.content).includes("<|"), "no marker reaches the message");
	});

	it("C: a text answer stores recovered thinking ahead of the answer and reads as no server parsing", async () => {
		const raw =
			"<|channel|>analysis<|message|>Think.<|end|><|start|>assistant<|channel|>final<|message|>Hello.<|return|>";
		const { result, events } = await run([() => sse([...contentChunks(raw), stop("stop")])]);
		strictEqual(result.stopReason, "stop");
		deepStrictEqual(
			result.content.map((block) => block.type),
			["thinking", "text"],
			"thinking precedes the text block it was streamed before",
		);
		ok(events.indexOf("thinking_end") < events.indexOf("text_start"), "the text block opens after the thinking closed");
		strictEqual(harmonyServerParsing(result.harmonyRecovery), "none");
	});

	it("B: a recipient-less commentary preamble is thinking and still reads as reasoning-only", async () => {
		const raw = `<|channel|>commentary<|message|>I will list the files.<|end|><|start|>assistant${RAW_TOOL_CALL}`;
		const frames = [
			chunk({ role: "assistant", reasoning_content: "Need the listing." }),
			...contentChunks(raw),
			stop("stop"),
		];
		const { result } = await run([() => sse(frames)]);
		strictEqual(result.stopReason, "toolUse");
		strictEqual(blocks(result, "thinking").length, 2, "the server's reasoning and the recovered preamble");
		strictEqual(harmonyServerParsing(result.harmonyRecovery), "reasoning-only");
	});

	it("A: a structured tool call whose name arrives in a later delta is kept", async () => {
		const frames = [
			chunk({
				role: "assistant",
				tool_calls: [{ index: 0, id: "chatcmpl-late", type: "function", function: { arguments: '{"command":' } }],
			}),
			chunk({ tool_calls: [{ index: 0, function: { name: "functions.bash", arguments: '"true"}' } }] }),
			stop("tool_calls"),
		];
		const { result, requests, events } = await run([() => sse(frames)]);
		strictEqual(requests.length, 1, "no incomplete retry");
		strictEqual(result.stopReason, "toolUse");
		const call = blocks(result, "toolCall")[0];
		ok(call?.type === "toolCall");
		strictEqual(call.name, "bash");
		deepStrictEqual(call.arguments, { command: "true" });
		deepStrictEqual(
			events.filter((type) => type.startsWith("toolcall_")),
			["toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end"],
			"held start and delta events are released at the end, in order",
		);
		deepStrictEqual(result.harmonyRecovery?.droppedToolCalls, []);
	});

	it("A: a structured tool call streams live, before pi's final pass closes the other blocks", async () => {
		const frames = [
			chunk({ role: "assistant", reasoning_content: "Need the listing. " }),
			chunk({
				tool_calls: [
					{ index: 0, id: "chatcmpl-live", type: "function", function: { name: "bash", arguments: '{"command":' } },
				],
			}),
			chunk({ tool_calls: [{ index: 0, function: { arguments: '"ls /tmp"}' } }] }),
			chunk({ reasoning_content: "Then report." }),
			stop("tool_calls"),
		];
		const { result, events } = await run([() => sse(frames)]);
		strictEqual(result.stopReason, "toolUse");
		const start = events.indexOf("toolcall_start");
		const argDelta = events.indexOf("toolcall_delta");
		ok(start !== -1 && argDelta !== -1);
		ok(start < events.lastIndexOf("thinking_delta"), "the tool block opened while reasoning was still streaming");
		ok(argDelta < events.indexOf("thinking_end"), "arguments streamed before pi's final pass");
		deepStrictEqual(result.harmonyRecovery?.droppedToolCalls, []);
	});

	it("C: the live partial never shows a marker split across deltas", async () => {
		const deltas = ["<|channel|>final<|message|>Hello<|", "return|>"];
		const frames = [...deltas.map((content) => chunk({ content })), stop("stop")];
		const partials: string[] = [];
		const stream = openAICompletionsApiProvider.streamSimple(
			vllmModel(),
			{ messages: [{ role: "user", content: "Say hello.", timestamp: 0 }] },
			{ apiKey: "fixture", reasoning: "low", fetch: async () => sse(frames) },
		);
		let final = "";
		for await (const event of stream) {
			if (event.type === "text_delta" || event.type === "text_end") {
				const block = event.partial.content[event.contentIndex];
				partials.push(block?.type === "text" ? block.text : "<missing>");
			}
			if (event.type === "done") final = event.message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
		}
		strictEqual(final, "Hello");
		ok(partials.length > 0);
		for (const text of partials) ok(!text.includes("<|") && !text.includes("return|>"), `partial text '${text}'`);
	});

	it("C: the recovered thinking signature comes from the catalog harmony quirk", async () => {
		const model = vllmModel() as Model<"openai-completions"> & { clioCoder: Record<string, unknown> };
		model.clioCoder = { ...model.clioCoder, quirks: { harmony: { recoveredReasoningField: { default: "reasoning" } } } };
		let signature = "";
		const stream = openAICompletionsApiProvider.streamSimple(
			model,
			{ messages: [{ role: "user", content: "List /tmp.", timestamp: 0 }], tools: TOOLS },
			{
				apiKey: "fixture",
				reasoning: "low",
				fetch: async () => sse([...contentChunks(`${RAW_ANALYSIS}${RAW_TOOL_CALL}`), stop("stop")]),
			},
		);
		for await (const event of stream) {
			if (event.type === "done") {
				const thinking = event.message.content.find((block) => block.type === "thinking");
				signature = thinking?.type === "thinking" ? (thinking.thinkingSignature ?? "") : "";
			}
		}
		strictEqual(signature, "reasoning");
	});

	it("C: a recovered tool turn replays as one analysis message with tool_calls and no content", async () => {
		const first = await run([() => sse([...contentChunks(`${RAW_ANALYSIS}${RAW_TOOL_CALL}`), stop("stop")])]);
		const call = blocks(first.result, "toolCall")[0];
		ok(call?.type === "toolCall");
		const context: Context = {
			messages: [
				{ role: "user", content: "List /tmp.", timestamp: 0 },
				first.result,
				{
					role: "toolResult",
					toolCallId: call.id,
					toolName: "bash",
					content: [{ type: "text", text: "a b" }],
					isError: false,
					timestamp: 2,
				},
			],
			tools: TOOLS,
		};
		const before = structuredClone(context);
		const second = await run([() => sse(ANSWER_FRAMES)], context);
		deepStrictEqual(context, before, "the saved transcript is never rewritten");
		const body = JSON.parse(second.requests[0] ?? "{}") as { messages: Array<Record<string, unknown>> };
		const assistant = body.messages.find((m) => m.role === "assistant");
		ok(assistant);
		strictEqual(assistant.reasoning_content, "User wants the listing. Call bash.");
		strictEqual(assistant.content, null);
		strictEqual((assistant.tool_calls as unknown[]).length, 1);
		strictEqual(second.result.stopReason, "stop");
	});

	it("C: a raw tool call without <|call|> whose arguments parse is still executed", async () => {
		const raw = '<|channel|>commentary to=functions.bash <|constrain|>json<|message|>{"command":"ls /tmp"}';
		const { result } = await run([() => sse([...contentChunks(raw), stop("stop")])]);
		strictEqual(result.stopReason, "toolUse");
		strictEqual(blocks(result, "toolCall").length, 1);
	});

	it("a browser recipient is kept as thinking and never executed", async () => {
		const raw =
			'<|channel|>commentary to=browser.search <|constrain|>json<|message|>{"q":"vllm"}<|call|><|start|>assistant<|channel|>final<|message|>Done.';
		const { result } = await run([() => sse([...contentChunks(raw), stop("stop")])]);
		strictEqual(result.stopReason, "stop");
		strictEqual(blocks(result, "toolCall").length, 0);
		strictEqual(
			blocks(result, "text")
				.map((b) => (b.type === "text" ? b.text : ""))
				.join(""),
			"Done.",
		);
		ok(result.harmonyRecovery?.notes.includes("recipient browser.search is not a function"));
	});
});

describe("extended/gpt-oss on vLLM: error bodies", () => {
	const harmonyError = () =>
		new Response(
			JSON.stringify({
				error: {
					message: "HarmonyError: unexpected tokens remaining in message header",
					type: "InternalServerError",
					code: 500,
				},
			}),
			{ status: 500, headers: { "content-type": "application/json" } },
		);

	it("a HarmonyError 500 is retried once, then ends with a terminal cause naming the server-side parser", async () => {
		const { result, requests, events } = await run([harmonyError, harmonyError]);
		strictEqual(requests.length, 2, "exactly one retry");
		strictEqual(result.stopReason, "error");
		ok(result.errorMessage?.startsWith("provider_harmony_error:"), result.errorMessage);
		ok(result.errorMessage?.includes("--reasoning-parser openai_gptoss"), "names the server-side Harmony parser");
		ok(!/\b500\b/.test(result.errorMessage ?? ""), "the terminal text is not retry bait");
		ok(result.errorMessage?.includes("reasoning_effort low"), "the request ran at low, so the known defect is named");
		// pi emits `start` only once response headers arrive, so two 500s emit none.
		strictEqual(events.filter((type) => type === "start").length, 0, "no message opened for a rejected request");
		strictEqual(isRetryableErrorMessage(result.errorMessage), false);
		strictEqual(
			classifyRecoveryFailure({ message: result.errorMessage ?? "", runtimeId: "vllm" }).kind,
			"terminal-provider",
		);
		strictEqual(result.harmonyRecovery?.retry?.reason, "server-error");
	});

	it("a HarmonyError 500 at medium effort does not blame the low-effort defect", async () => {
		let message = "";
		const stream = openAICompletionsApiProvider.streamSimple(
			vllmModel(),
			{ messages: [{ role: "user", content: "List /tmp.", timestamp: 0 }], tools: TOOLS },
			{ apiKey: "fixture", reasoning: "medium", fetch: async () => harmonyError() },
		);
		for await (const event of stream) if (event.type === "error") message = event.error.errorMessage ?? "";
		ok(message.startsWith("provider_harmony_error:"), message);
		ok(!message.includes("reasoning_effort low"), message);
	});

	it("a HarmonyError 500 followed by a good answer records one message with both calls' usage", async () => {
		const { result, requests } = await run([harmonyError, () => sse(ANSWER_FRAMES)]);
		strictEqual(requests.length, 2);
		strictEqual(result.stopReason, "stop");
		strictEqual(
			blocks(result, "text")
				.map((b) => (b.type === "text" ? b.text : ""))
				.join(""),
			"6",
		);
		strictEqual(result.usage.input, USAGE_SECOND.prompt_tokens);
		strictEqual(result.harmonyRecovery?.retry?.reason, "server-error");
	});

	it("content null with finish_reason stop is retried once and never recorded as an empty success", async () => {
		const incomplete = () => sse([chunk({ role: "assistant", content: null }), stop("stop")]);
		const { result, requests, events } = await run([incomplete, incomplete]);
		strictEqual(requests.length, 2);
		strictEqual(result.stopReason, "error");
		ok(result.errorMessage?.startsWith("provider_harmony_incomplete:"), result.errorMessage);
		strictEqual(events.filter((type) => type === "start").length, 1);
		strictEqual(isRetryableErrorMessage(result.errorMessage), false);
		strictEqual(
			classifyRecoveryFailure({ message: result.errorMessage ?? "", runtimeId: "vllm" }).kind,
			"terminal-provider",
		);
	});

	it("an incomplete stop after streamed thinking retries once; the retry's content persists and usage sums both calls", async () => {
		const incompleteWithThinking = () =>
			sse([
				chunk({ role: "assistant", reasoning_content: "First attempt thinking." }),
				chunk({ content: null }),
				stop("stop"),
			]);
		const { result, requests, events, thinkingDeltas } = await run([incompleteWithThinking, () => sse(ANSWER_FRAMES)]);
		strictEqual(requests.length, 2);
		strictEqual(result.stopReason, "stop");
		strictEqual(
			blocks(result, "text")
				.map((b) => (b.type === "text" ? b.text : ""))
				.join(""),
			"6",
		);
		strictEqual(blocks(result, "thinking").length, 0, "the first attempt's thinking is not persisted");
		strictEqual(thinkingDeltas, "First attempt thinking.", "the first attempt's thinking streamed exactly once");
		strictEqual(events.filter((type) => type === "start").length, 1, "one message in flight across the retry");
		strictEqual(result.usage.input, USAGE_FIRST.prompt_tokens + USAGE_SECOND.prompt_tokens);
		strictEqual(result.usage.output, USAGE_FIRST.completion_tokens + USAGE_SECOND.completion_tokens);
		strictEqual(result.harmonyRecovery?.retry?.reason, "incomplete");
		strictEqual(result.harmonyRecovery?.retry?.firstAttemptUsage?.input, USAGE_FIRST.prompt_tokens);
	});

	it("a junk tool name (vllm#58825) is dropped into thinking, never executed, and the turn is retried once", async () => {
		const junk = () =>
			sse([
				chunk({
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: "chatcmpl-junk",
							type: "function",
							function: { name: "assistant<|channel|>analysis", arguments: '{"text":"stray analysis"}' },
						},
					],
				}),
				stop("tool_calls"),
			]);
		const { result, requests, events } = await run([junk, () => sse(ANSWER_FRAMES)]);
		strictEqual(requests.length, 2, "the junk-only turn counts as incomplete and is retried once");
		ok(!events.includes("toolcall_start"), "no tool call event reached the agent");
		strictEqual(result.stopReason, "stop");
		strictEqual(blocks(result, "toolCall").length, 0);
		strictEqual(
			blocks(result, "text")
				.map((b) => (b.type === "text" ? b.text : ""))
				.join(""),
			"6",
		);
		const second = JSON.parse(requests[1] ?? "{}") as { messages: Array<Record<string, unknown>> };
		ok(
			!JSON.stringify(second.messages).includes("assistant<|channel|>analysis"),
			"the junk name is never fed back to the model",
		);
	});

	it("a junk tool name beside a real answer keeps the answer and the dropped call's text as thinking", async () => {
		const frames = [
			chunk({ role: "assistant", content: "Listing follows." }),
			chunk({
				tool_calls: [
					{
						index: 0,
						id: "chatcmpl-junk",
						type: "function",
						function: { name: "assistant<|channel|>analysis", arguments: '{"text":"stray analysis"}' },
					},
				],
			}),
			stop("tool_calls"),
		];
		const { result, requests } = await run([() => sse(frames)]);
		strictEqual(requests.length, 1);
		strictEqual(result.stopReason, "stop", "toolUse without a surviving call becomes stop");
		strictEqual(blocks(result, "toolCall").length, 0);
		const thinking = blocks(result, "thinking");
		strictEqual(thinking.length, 1);
		ok(thinking[0]?.type === "thinking" && thinking[0].thinking.includes("stray analysis"));
		deepStrictEqual(result.harmonyRecovery?.droppedToolCalls, [
			{ name: "assistant<|channel|>analysis", reason: "artifact" },
		]);
	});
});

/**
 * Request bodies captured at b5d3ad7e7 (before #435) for the same inputs; the
 * assertion is byte equality, as the #414 non-Harmony check did. A non-Harmony
 * model sends nothing new, and a Harmony model whose reasoning came back in LM
 * Studio's structured `reasoning` field replays it under that same field.
 */
const NON_HARMONY_BODY_AT_BASE =
	'{"model":"dynamo/qwen3.8-27b","messages":[{"role":"user","content":"Run the test."},{"role":"assistant","content":"Running.","reasoning":"Need to run.","tool_calls":[{"id":"call_1","type":"function","function":{"name":"bash","arguments":"{\\"command\\":\\"true\\"}"}}]},{"role":"tool","content":"ok","tool_call_id":"call_1"},{"role":"user","content":"what is 3+3?"}],"stream":true,"stream_options":{"include_usage":true},"max_tokens":128,"tools":[{"type":"function","function":{"name":"bash","description":"Run a shell command","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}}],"chat_template_kwargs":{"enable_thinking":true}}';
const LMSTUDIO_HARMONY_BODY_AT_BASE =
	'{"model":"openai/gpt-oss-20b","messages":[{"role":"user","content":"Run the test."},{"role":"assistant","content":null,"reasoning":"Need to run.","tool_calls":[{"id":"call_1","type":"function","function":{"name":"bash","arguments":"{\\"command\\":\\"true\\"}"}}]},{"role":"tool","content":"ok","tool_call_id":"call_1"},{"role":"user","content":"what is 3+3?"}],"stream":true,"stream_options":{"include_usage":true},"store":false,"max_completion_tokens":128,"tools":[{"type":"function","function":{"name":"bash","description":"Run a shell command","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}}],"reasoning_effort":"low"}';

function replayContext(model: Model<"openai-completions">, withText: boolean): Context {
	return {
		messages: [
			{ role: "user", content: "Run the test.", timestamp: 0 },
			{
				role: "assistant",
				api: model.api,
				provider: model.provider,
				model: model.id,
				content: [
					{ type: "thinking", thinking: "Need to run.", thinkingSignature: "reasoning" },
					...(withText ? [{ type: "text" as const, text: "Running." }] : []),
					{ type: "toolCall", id: "call_1", name: "bash", arguments: { command: "true" } },
				],
				stopReason: "toolUse",
				timestamp: 1,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
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
		tools: TOOLS,
	};
}

async function captureBody(model: Model<"openai-completions">, context: Context): Promise<string> {
	let body = "";
	const stream = openAICompletionsApiProvider.streamSimple(model, context, {
		apiKey: "fixture",
		maxTokens: 128,
		reasoning: "low",
		fetch: async (_url: unknown, init?: RequestInit) => {
			body = String(init?.body);
			return sse([{ model: model.id, choices: [{ index: 0, delta: { content: "6" }, finish_reason: "stop" }] }]);
		},
	});
	await stream.result();
	return body;
}

describe("extended/gpt-oss on vLLM: byte identity for untouched paths", () => {
	it("a non-Harmony model's request body is byte-identical to the pre-#435 capture", async () => {
		const model = litellm.synthesizeModel(
			{ id: "fixture", runtime: "litellm", url: "http://fixture.invalid" },
			"dynamo/qwen3.8-27b",
			null,
		) as Model<"openai-completions">;
		model.reasoning = true;
		strictEqual(await captureBody(model, replayContext(model, true)), NON_HARMONY_BODY_AT_BASE);
	});

	it("a Harmony model on LM Studio with structured reasoning replays byte-identically under `reasoning`", async () => {
		const model = {
			id: MODEL_ID,
			name: MODEL_ID,
			api: "openai-completions",
			provider: "lmstudio",
			baseUrl: "http://fixture.invalid/v1",
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
		strictEqual(await captureBody(model, replayContext(model, false)), LMSTUDIO_HARMONY_BODY_AT_BASE);
	});
});
