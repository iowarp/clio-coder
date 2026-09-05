import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createEngineAgent, type EngineAgentOptions } from "../../src/engine/agent.js";
import type { AgentEvent, EngineModel } from "../../src/engine/types.js";

const MODEL: EngineModel = {
	id: "timing-a",
	name: "Timing fixture",
	api: "openai-completions",
	provider: "timing-fixture",
	baseUrl: "https://timing.invalid/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32768,
	maxTokens: 4096,
};

function assistant(model: EngineModel, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 5,
			output: text ? 2 : 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: text ? 7 : 5,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function initialState(model = MODEL) {
	return { systemPrompt: "Timing fixture", model, thinkingLevel: "off" as const, tools: [], messages: [] };
}

test("native invocation hook preserves custom delegates across calls, model swap and replacement agent", async () => {
	const timeline: string[] = [];
	const calls: Array<{ model: string; messages: number }> = [];
	let emptyResponse = false;
	const streamFn: NonNullable<EngineAgentOptions["streamFn"]> = (model, context) => {
		timeline.push(`delegate:${model.id}`);
		calls.push({ model: model.id, messages: context.messages.length });
		const message = assistant(model, emptyResponse ? "" : "custom delegate reply");
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: message });
			if (!emptyResponse) {
				stream.push({ type: "text_delta", contentIndex: 0, delta: "custom delegate reply", partial: message });
			}
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	};
	const hook = () => timeline.push("invocation");
	const first = createEngineAgent({ initialState: initialState(), streamFn, onStreamInvocation: hook });
	deepStrictEqual(timeline, [], "constructing an agent must not invoke the stream or timing hook");
	await first.agent.prompt("first");
	await first.agent.prompt("second");
	first.agent.state.model = { ...MODEL, id: "timing-b" };
	await first.agent.prompt("changed model");
	const replacement = createEngineAgent({
		initialState: { ...initialState(first.agent.state.model), messages: [...first.agent.state.messages] },
		streamFn,
		onStreamInvocation: hook,
	});
	strictEqual(calls.length, 3, "constructing a replacement must not start a call");
	await replacement.agent.prompt("replacement agent");
	emptyResponse = true;
	await replacement.agent.prompt("empty response");
	deepStrictEqual(timeline, [
		"invocation",
		"delegate:timing-a",
		"invocation",
		"delegate:timing-a",
		"invocation",
		"delegate:timing-b",
		"invocation",
		"delegate:timing-b",
		"invocation",
		"delegate:timing-b",
	]);
	deepStrictEqual(
		calls.map((call) => call.model),
		["timing-a", "timing-a", "timing-b", "timing-b", "timing-b"],
	);
	ok(
		(calls[3]?.messages ?? 0) > (calls[2]?.messages ?? 0),
		"delegate receives preserved conversation after replacement",
	);
	const last = replacement.agent.state.messages.at(-1) as AssistantMessage;
	deepStrictEqual(last.content, [], "an empty response still invokes the delegate and closes its call");
	strictEqual(last.stopReason, "stop");
	strictEqual(replacement.agent.state.isStreaming, false);
});

test("custom stream delegate remains usable without an invocation hook", async () => {
	let calls = 0;
	const handle = createEngineAgent({
		initialState: initialState(),
		streamFn: (model) => {
			calls += 1;
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: assistant(model, "unwrapped") }));
			return stream;
		},
	});
	strictEqual(calls, 0);
	await handle.agent.prompt("no timing observer");
	strictEqual(calls, 1);
	deepStrictEqual((handle.agent.state.messages.at(-1) as AssistantMessage).content, [
		{ type: "text", text: "unwrapped" },
	]);
});

for (const mode of ["error", "cancel"] as const) {
	test(`native invocation hook keeps custom delegate ${mode} settlement`, async () => {
		const timeline: string[] = [];
		const events: AgentEvent[] = [];
		let called!: () => void;
		const entered = new Promise<void>((resolve) => {
			called = resolve;
		});
		const handle = createEngineAgent({
			initialState: initialState(),
			onStreamInvocation: () => timeline.push("invocation"),
			streamFn: async (_model, _context, options) => {
				timeline.push("delegate");
				called();
				if (mode === "error") throw new Error("controlled delegate failure");
				const signal = options?.signal;
				ok(signal, "wrapper must preserve the agent's cancellation signal");
				return new Promise<never>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("controlled delegate cancellation")), { once: true });
				});
			},
		});
		handle.agent.subscribe((event) => {
			events.push(event);
		});
		const pending = handle.agent.prompt(mode);
		await entered;
		if (mode === "cancel") handle.agent.abort();
		await pending;
		deepStrictEqual(timeline, ["invocation", "delegate"]);
		strictEqual(events.filter((event) => event.type === "agent_end").length, 1);
		strictEqual(handle.agent.state.isStreaming, false);
		const message = handle.agent.state.messages.at(-1) as AssistantMessage;
		strictEqual(message.stopReason, mode === "cancel" ? "aborted" : "error");
		ok(message.errorMessage?.includes("controlled delegate"));
	});
}
