/** Real Pi loop contracts for optional continuity boundaries; no production checkpoint tool. */
import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	createEngineAgent,
	type EngineAgentOptions,
	type EnginePrepareNextTurnContext,
	type EnginePrepareNextTurnUpdate,
	type EngineStreamRequest,
	type EngineToolBatchContext,
} from "../../src/engine/agent.js";
import type { AgentEvent, AgentMessage, AgentTool, EngineModel } from "../../src/engine/types.js";

const MODEL: EngineModel = {
	id: "continuity-fixture",
	name: "continuity fixture",
	api: "openai-completions",
	provider: "fixture",
	baseUrl: "https://fixture.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 8192,
	maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		stopReason,
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}
function call(
	id: string,
	name = "self_compact",
	args: Extract<AssistantMessage["content"][number], { type: "toolCall" }>["arguments"] = { note: "exact note" },
): AssistantMessage["content"][number] {
	return { type: "toolCall", id, name, arguments: args };
}
const schema = Type.Object({ note: Type.String() });
function checkpointBatch({ assistantMessage }: EngineToolBatchContext) {
	const calls = assistantMessage.content.filter((block) => block.type === "toolCall");
	return calls.some((block) => block.name === "self_compact") && calls.length !== 1
		? { reason: "Checkpoint must be the only call in its assistant message" }
		: undefined;
}
function fixture(script: AssistantMessage[], options: Partial<EngineAgentOptions> = {}) {
	const calls: EngineStreamRequest[] = [];
	const events: AgentEvent[] = [];
	const executions: string[] = [];
	let invocations = 0;
	const tool = (name: string): AgentTool<typeof schema> => ({
		name,
		label: name,
		description: "private fixture only",
		parameters: schema,
		async execute(id) {
			executions.push(id);
			return { content: [{ type: "text", text: `pending:${id}` }], details: undefined };
		},
	});
	const handle = createEngineAgent({
		initialState: {
			model: MODEL,
			thinkingLevel: "off",
			systemPrompt: "operator authority stays with original turn",
			tools: [tool("self_compact"), tool("sibling")],
		},
		transcriptStreamFn(model, context, streamOptions) {
			calls.push({ model, context: { ...context, messages: [...context.messages] }, options: streamOptions });
			const message = script.shift();
			ok(message, "scripted provider has a response");
			const stream = createAssistantMessageEventStream();
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				stream.push({ type: "error", reason: message.stopReason, error: message });
			} else {
				ok(message.stopReason !== "pending");
				stream.push({ type: "done", reason: message.stopReason, message });
			}
			return stream;
		},
		onStreamInvocation() {
			invocations++;
		},
		...options,
	});
	handle.agent.subscribe((event) => {
		events.push(event);
	});
	return { ...handle, calls, events, executions, invocations: () => invocations };
}
const done = () => assistant([{ type: "text", text: "done" }]);

for (const toolExecution of ["sequential", "parallel"] as const) {
	describe(`whole-message checkpoint preflight (${toolExecution})`, () => {
		const batches = {
			"checkpoint first": [call("checkpoint"), call("sibling", "sibling")],
			"checkpoint last": [call("sibling", "sibling"), call("checkpoint")],
			"duplicate checkpoints": [call("checkpoint-1"), call("checkpoint-2")],
			"malformed checkpoint first": [call("bad", "self_compact", { note: 5 }), call("sibling", "sibling")],
			"malformed checkpoint last": [call("sibling", "sibling"), call("bad", "self_compact", { note: 5 })],
			"unknown sibling first": [call("unknown", "missing"), call("checkpoint")],
			"unknown sibling last": [call("checkpoint"), call("unknown", "missing")],
		};
		for (const [label, batch] of Object.entries(batches)) {
			it(`${label}: executes no siblings and returns every provider-visible result pair`, async () => {
				let decisions = 0;
				let perCall = 0;
				const run = fixture([assistant(batch, "toolUse"), done()], {
					toolExecution,
					async beforeToolBatch(context) {
						decisions++;
						await Promise.resolve();
						return checkpointBatch(context);
					},
					async beforeToolCall() {
						perCall++;
						return undefined;
					},
				});
				await run.agent.prompt("original operator request");
				deepStrictEqual(run.executions, []);
				strictEqual(decisions, 1);
				strictEqual(perCall, 0);
				strictEqual(run.calls.length, 2);
				const continuation = run.calls[1];
				ok(continuation);
				const results = continuation.context.messages.filter((message) => message.role === "toolResult");
				deepStrictEqual(
					results.map((message) => message.toolCallId),
					batch.map((block) => (block.type === "toolCall" ? block.id : "")),
				);
				ok(results.every((message) => message.isError));
				strictEqual(run.events.filter((event) => event.type === "tool_execution_end").length, batch.length);
			});
		}
		it("a throwing batch predicate fails closed once and produces all pairs", async () => {
			let decisions = 0;
			const run = fixture([assistant([call("one", "sibling"), call("two", "sibling")], "toolUse"), done()], {
				toolExecution,
				async beforeToolBatch() {
					decisions++;
					await Promise.resolve();
					throw new Error("private failure");
				},
			});
			await run.agent.prompt("work");
			strictEqual(decisions, 1);
			deepStrictEqual(run.executions, []);
			const continuation = run.calls[1];
			ok(continuation);
			const results = continuation.context.messages.filter((message) => message.role === "toolResult");
			strictEqual(results.length, 2);
			for (const result of results)
				deepStrictEqual(result.content, [{ type: "text", text: "Tool batch admission failed" }]);
		});
		it("admitted batches retain the existing per-call refusal", async () => {
			const run = fixture([assistant([call("allowed", "sibling"), call("blocked", "sibling")], "toolUse"), done()], {
				toolExecution,
				beforeToolBatch: checkpointBatch,
				async beforeToolCall(context) {
					return context.toolCall.id === "blocked" ? { block: true, reason: "old guard" } : undefined;
				},
			});
			await run.agent.prompt("work");
			deepStrictEqual(run.executions, ["allowed"]);
		});
	});
}

describe("settled continuation and actual request admission", () => {
	it("does not suspend between final lease approval and delegate invocation", async () => {
		let lease = "approved";
		let invoked = false;
		const run = fixture([], {
			beforeStreamRequest() {
				strictEqual(lease, "approved");
				queueMicrotask(() => {
					lease = "navigated";
				});
				return { block: false };
			},
			transcriptStreamFn() {
				strictEqual(lease, "approved", "the final admission boundary must not yield to navigation");
				invoked = true;
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "stop", message: done() });
				return stream;
			},
		});
		await run.agent.prompt("work");
		strictEqual(invoked, true);
		strictEqual(lease, "navigated");
		strictEqual(run.invocations(), 1);
	});

	it("awaits both receipt listeners, replaces context without operator events, and sees steering added during prepare", async () => {
		const timeline: string[] = [];
		let prepared: EnginePrepareNextTurnContext | undefined;
		const run = fixture([assistant([call("checkpoint")], "toolUse"), done()], {
			beforeToolBatch: checkpointBatch,
			beforeStreamRequest(request) {
				timeline.push(`guard:${run.calls.length}`);
				if (run.calls.length === 1) {
					ok(request.context.messages.some((message) => message.role === "user" && message.content === "operator steering"));
					ok(
						request.context.messages.some((message) => message.role === "system" && message.content === "replacement replay"),
					);
				}
				return run.calls.length === 1 ? { block: false, correlationId: "delivery-1" } : { block: false };
			},
		});
		run.agent.subscribe(async (event) => {
			if (event.type === "tool_execution_end" || (event.type === "message_end" && event.message.role === "toolResult")) {
				await Promise.resolve();
				timeline.push(`receipt:${event.type}`);
			}
		});
		run.agent.prepareNextTurnWithContext = async (context): Promise<EnginePrepareNextTurnUpdate> => {
			prepared = context;
			deepStrictEqual(timeline, ["guard:0", "receipt:tool_execution_end", "receipt:message_end"]);
			strictEqual(context.toolResults[0]?.toolCallId, "checkpoint");
			strictEqual(context.message.content[0]?.type, "toolCall");
			timeline.push("prepare");
			await Promise.resolve();
			run.agent.steer({ role: "user", content: "operator steering", timestamp: Date.now() });
			const messages: AgentMessage[] = [
				{ role: "system", content: "replacement replay", timestamp: Date.now() },
				...context.context.messages.filter((message) => message.role !== "system"),
			];
			// Host replay replacement must update both Agent state and returned native context.
			run.agent.state.messages = messages;
			return { context: { ...context.context, messages: [...messages] } };
		};
		let emittedCorrelation: string | undefined;
		run.agent.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "stop") {
				emittedCorrelation = run.requestCorrelationId(event.message);
				strictEqual(run.requestCorrelationId({ ...event.message }), undefined);
			}
		});
		await run.agent.prompt("original operator request");
		ok(prepared);
		strictEqual(emittedCorrelation, "delivery-1");
		strictEqual(run.invocations(), 2);
		deepStrictEqual(timeline, ["guard:0", "receipt:tool_execution_end", "receipt:message_end", "prepare", "guard:1"]);
		const userEvents = run.events.filter((event) => event.type === "message_end" && event.message.role === "user");
		strictEqual(userEvents.length, 2, "only the original operator input and actual steering emit user events");
		ok(
			!run.events.some(
				(event) =>
					event.type === "message_end" && event.message.role === "system" && event.message.content === "replacement replay",
			),
		);
	});

	for (const cause of ["refusal", "throw", "abort"] as const) {
		it(`${cause} after prepare produces a normal failure lifecycle without invoking the delegate or observer`, async () => {
			const run = fixture([assistant([call("checkpoint")], "toolUse")], {
				beforeStreamRequest(request) {
					if (run.calls.length === 0) return { block: false, correlationId: "initial" };
					ok(request.context.messages.some((message) => message.role === "user" && message.content === "changed authority"));
					if (cause === "throw") throw new Error("sensitive guard details");
					if (cause === "abort") {
						run.agent.abort();
						return { block: false, correlationId: "must not attach" };
					}
					return { block: true, reason: "Authority changed" };
				},
			});
			run.agent.prepareNextTurnWithContext = async () => {
				await Promise.resolve();
				run.agent.steer({ role: "user", content: "changed authority", timestamp: Date.now() });
				return undefined;
			};
			await run.agent.prompt("work");
			strictEqual(run.calls.length, 1);
			strictEqual(run.invocations(), 1);
			strictEqual(run.events.at(-1)?.type, "agent_end");
			const last = run.agent.state.messages.at(-1);
			ok(last?.role === "assistant");
			strictEqual(last.stopReason, cause === "abort" ? "aborted" : "error");
			strictEqual(run.requestCorrelationId(last), undefined);
			strictEqual(last.usage.totalTokens, 0);
			ok(last.errorMessage);
			if (cause === "throw") strictEqual(last.errorMessage, "Request admission failed");
		});
	}

	it("correlates admitted provider errors without claiming success, then clears attribution on the next run", async () => {
		const failure = assistant([], "error");
		failure.errorMessage = "provider failed";
		let request = 0;
		const run = fixture([failure, done()], {
			beforeStreamRequest() {
				return request++ === 0 ? { block: false, correlationId: "delivery-error" } : { block: false };
			},
		});
		await run.agent.prompt("first");
		strictEqual(run.requestCorrelationId(failure), "delivery-error");
		strictEqual(failure.stopReason, "error");
		await run.agent.prompt("next operator request");
		const last = run.agent.state.messages.at(-1);
		ok(last);
		strictEqual(run.requestCorrelationId(last), undefined);
		strictEqual(run.requestCorrelationId(failure), "delivery-error");
		strictEqual(run.invocations(), 2);
	});

	it("checks the converted transcript even for a legacy resolved delegate and bounds refusal text", async () => {
		let delegated = 0;
		const run = fixture([], {
			convertToLlm: () => [{ role: "user", content: "converted", timestamp: Date.now() }],
			beforeStreamRequest(request) {
				strictEqual(request.context.messages[0]?.role, "user");
				strictEqual(request.context.messages[0]?.content, "converted");
				return { block: true, reason: "x".repeat(2048) };
			},
			streamFn() {
				delegated++;
				throw new Error("must never run");
			},
		});
		await run.agent.prompt("unconverted");
		strictEqual(delegated, 0);
		strictEqual(run.invocations(), 0);
		const last = run.agent.state.messages.at(-1);
		ok(last?.role === "assistant");
		strictEqual(last.errorMessage?.length, 1024);
		match(last.errorMessage ?? "", /^x+$/);
	});
});
