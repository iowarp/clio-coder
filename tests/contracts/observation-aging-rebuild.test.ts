import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { Type } from "typebox";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { ToolNames } from "../../src/core/tool-names.js";
import {
	EMPTY_CAPABILITIES,
	type ProvidersContract,
	type RuntimeDescriptor,
} from "../../src/domains/providers/index.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { openAICompletionsApiProvider } from "../../src/engine/apis/openai-completions.js";
import type { AgentMessage, Model } from "../../src/engine/types.js";
import { type ChatLoopEvent, createChatLoop } from "../../src/session-control/chat-loop.js";
import { createObservationAging, OBSERVATION_AGING_BATCH_BYTES } from "../../src/session-control/observation-aging.js";
import { createRegistry } from "../../src/tools/registry.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

let env: IsolatedClioEnv;
let previousCwd: string;
beforeEach(async () => {
	env = await isolateClioEnv("observation-aging-rebuild-");
	previousCwd = process.cwd();
	const project = path.join(env.dir, "project");
	mkdirSync(project);
	process.chdir(project);
});
afterEach(() => {
	process.chdir(previousCwd);
	env.restore();
});

const text = (message: AgentMessage | undefined): string =>
	((message as { content?: Array<{ text?: string }> } | undefined)?.content ?? []).map((block) => block.text).join("");
const RECORD = `record body\n${"r".repeat(40_000 - 12)}`;
const declared = () => undefined;

it("a different session id starts the stubbed set over; the same one keeps it (WTF-P 0.8.3 C3)", () => {
	const big = `big\n${"r".repeat(OBSERVATION_AGING_BATCH_BYTES + 1024)}`;
	const messages = ["a", "b"].flatMap((id) => [
		{
			role: "assistant",
			content: [{ type: "toolCall", id, name: "read", arguments: { path: "x.md" } }],
			stopReason: "toolUse",
			timestamp: 0,
		},
		{ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: big }], timestamp: 0 },
	]) as unknown as AgentMessage[];
	const route = { modelTier: "small" as const };
	const aging = createObservationAging(declared);
	strictEqual(aging.project(messages, route, "s1").batch?.results, 1);
	const again = aging.project(messages, route, "s1");
	strictEqual(again.batch, null, "one batch per session");
	ok(text(again.messages[1]).startsWith("[observation aged]"), "and it stays stubbed");
	strictEqual(aging.project(messages, route, "s2").batch?.results, 1, "a switched, new or forked session starts over");
});

const targetA = {
	id: "aging-a",
	runtime: "litellm",
	url: "http://fixture.invalid:4000",
	cache: { retention: "none" as const },
};
const targetB = { ...targetA, id: "aging-b" };
const model = litellm.synthesizeModel(targetA, "aging-model", null) as Model<"openai-completions">;

/** Two identical reads, then an answer for every later request; every request the provider would receive is kept. */
function transport() {
	const requests: AgentMessage[][] = [];
	const fetch: typeof globalThis.fetch = async () => {
		const call = requests.length;
		const encoder = new TextEncoder();
		const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) =>
			encoder.encode(
				`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: model.id, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
			);
		const tool = call <= 2;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					chunk(
						tool
							? {
									role: "assistant",
									tool_calls: [
										{
											index: 0,
											id: `read-${call}`,
											type: "function",
											function: { name: "read", arguments: '{"path":"record.md"}' },
										},
									],
								}
							: { role: "assistant", content: "done" },
					),
				);
				controller.enqueue(chunk({}, tool ? "tool_calls" : "stop"));
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
			},
		});
		return new Response(stream, { headers: { "content-type": "text/event-stream" } });
	};
	return { fetch, requests };
}

const toolResults = (messages: AgentMessage[] | undefined): string[] =>
	(messages ?? []).filter((message) => message.role === "toolResult").map(text);

it("a model switch that rebuilds the agent keeps every stub and announces no second batch (WTF-P 0.8.3 C3)", {
	timeout: 20_000,
}, async () => {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = false;
	settings.chat.target = targetA.id;
	settings.chat.model = model.id;
	settings.chat.thinkingLevel = "off";
	settings.targets = [
		{ ...targetA, defaultModel: model.id },
		{ ...targetB, defaultModel: model.id },
	] as typeof settings.targets;
	const runtime: RuntimeDescriptor = {
		...litellm,
		auth: "none",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true, contextWindow: 131072, maxTokens: 4096 },
		synthesizeModel: () => ({ ...model, input: ["text"], contextWindow: 131072, maxTokens: 4096 }),
	};
	const context = dispatchStubContext({ settings, runtime });
	const session = createSessionBundle(context).contract;
	const safety = context.getContract("safety");
	ok(safety);
	const registry = createRegistry({ safety, autonomy: () => "yolo" });
	registry.register({
		name: ToolNames.Read,
		description: "Returns the same 40 KB record every time",
		parameters: Type.Object({ path: Type.String() }),
		baseActionClass: "read",
		run: async () => ({ kind: "ok", output: RECORD }),
	});
	const wire = transport();
	const events: ChatLoopEvent[] = [];
	let agents = 0;
	const loop = createChatLoop({
		getSettings: () => settings,
		providers: context.getContract("providers") as ProvidersContract,
		knownTargets: () => new Set([targetA.id, targetB.id]),
		session,
		toolRegistry: registry,
		bus: context.bus,
		createAgent: (options) => {
			agents += 1;
			return createEngineAgent({
				...options,
				streamFn: (requestModel, requestContext, requestOptions) => {
					wire.requests.push(structuredClone(requestContext.messages) as AgentMessage[]);
					return openAICompletionsApiProvider.streamSimple(requestModel as Model<"openai-completions">, requestContext, {
						...requestOptions,
						apiKey: "fixture",
						fetch: (...args) => wire.fetch(...args),
					});
				},
			});
		},
	});
	loop.onEvent((event) => {
		events.push(event);
	});
	const batches = () =>
		events.filter(
			(event) => event.type === "notice" && /observation aging: /u.test((event as { text?: string }).text ?? ""),
		).length;
	try {
		await loop.submit("Read the record twice.");
		await loop.whenSettled();
		strictEqual(wire.requests.length, 3);
		const [stub, fresh] = toolResults(wire.requests[2]);
		ok(stub?.startsWith('[observation aged] read {"path":"record.md"}'), stub?.slice(0, 200));
		strictEqual(fresh, RECORD);
		strictEqual(batches(), 1);
		const built = agents;

		// Another target with the same model rebuilds the agent rather than hot-swapping it.
		settings.chat.target = targetB.id;
		await loop.submit("Now answer.");
		await loop.whenSettled();
		strictEqual(agents, built + 1, "the switch built a new agent");
		strictEqual(wire.requests.length, 4);
		const [kept, still] = toolResults(wire.requests[3]);
		strictEqual(kept, stub, "the stub reaches the rebuilt agent's request byte for byte");
		strictEqual(still, RECORD);
		strictEqual(batches(), 1, "no second batch notice after the rebuild");
	} finally {
		loop.dispose();
		await loop.whenSettled();
		await session.close();
	}
});
