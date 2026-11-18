import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
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
import { createProductionAutoCompact } from "../../src/entry/orchestrator.js";
import { type ChatLoopEvent, createChatLoop } from "../../src/session-control/chat-loop.js";
import { createObservationAging, OBSERVATION_AGING_BATCH_BYTES } from "../../src/session-control/observation-aging.js";
import { replayCurrentSession } from "../../src/session-control/session-restore.js";
import { createRegistry } from "../../src/tools/registry.js";
import { syntheticCompactionSummary } from "../harness/compaction-summary.js";
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
const SMALL = `small body\n${"s".repeat(2_000)}`;
const declared = () => undefined;
/** Small enough that the post-tool guard compacts after each further record read. */
const WINDOW = 40_000;

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
	const route = { promptCaching: false };
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

/** One read per scripted path, then an answer for every later request; every request the provider would receive is kept. */
function transport(paths: ReadonlyArray<string> = ["record.md", "record.md"]) {
	const requests: AgentMessage[][] = [];
	/** The message array each request put on the wire, as the provider received it. */
	const bodies: unknown[][] = [];
	const fetch: typeof globalThis.fetch = async (_url, init) => {
		bodies.push((JSON.parse(String(init?.body)) as { messages: unknown[] }).messages);
		const call = requests.length;
		const encoder = new TextEncoder();
		const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) =>
			encoder.encode(
				`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: model.id, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
			);
		const tool = call <= paths.length;
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
											function: { name: "read", arguments: JSON.stringify({ path: paths[call - 1] }) },
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
	return { fetch, requests, bodies };
}

const toolResults = (messages: AgentMessage[] | undefined): string[] =>
	(messages ?? []).filter((message) => message.role === "toolResult").map(text);

/**
 * A chat loop over its own session bundle, as one process holds it; every loop shares `wire`. A `window` declares that
 * context window on the target and wires production compaction with a scripted summarizer.
 */
function harness(wire: ReturnType<typeof transport>, window?: number) {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = false;
	settings.chat.target = targetA.id;
	settings.chat.model = model.id;
	settings.chat.thinkingLevel = "off";
	const contextWindow = window ?? 131072;
	settings.targets = [
		{ ...targetA, defaultModel: model.id, ...(window ? { capabilities: { contextWindow } } : {}) },
		{ ...targetB, defaultModel: model.id },
	] as typeof settings.targets;
	const runtime: RuntimeDescriptor = {
		...litellm,
		auth: "none",
		defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true, tools: true, contextWindow, maxTokens: 4096 },
		synthesizeModel: () => ({ ...model, input: ["text"], contextWindow, maxTokens: 4096 }),
	};
	const context = dispatchStubContext({ settings, runtime });
	const session = createSessionBundle(context).contract;
	const safety = context.getContract("safety");
	ok(safety);
	const registry = createRegistry({ safety, autonomy: () => "yolo" });
	registry.register({
		name: ToolNames.Read,
		description: "Returns the same body for a path every time",
		parameters: Type.Object({ path: Type.String() }),
		baseActionClass: "read",
		run: async (args) => ({ kind: "ok", output: args.path === "small.md" ? SMALL : RECORD }),
	});
	const events: ChatLoopEvent[] = [];
	const counter = { agents: 0, summaries: 0 };
	const providers = context.getContract("providers") as ProvidersContract;
	const loop = createChatLoop({
		getSettings: () => settings,
		providers,
		knownTargets: () => new Set([targetA.id, targetB.id]),
		session,
		readSessionEntries: () => (session.current() ? session.readEntries() : []),
		toolRegistry: registry,
		bus: context.bus,
		...(window
			? {
					autoCompact: createProductionAutoCompact(
						session,
						() => settings,
						providers,
						undefined,
						async () => ({
							text: syntheticCompactionSummary(`checkpoint ${++counter.summaries}`),
						}),
					),
				}
			: {}),
		createAgent: (options) => {
			counter.agents += 1;
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
	const close = async () => {
		loop.dispose();
		await loop.whenSettled();
		await session.close();
	};
	return { settings, session, loop, counter, batches, close };
}

it("a model switch that rebuilds the agent keeps every stub and announces no second batch (WTF-P 0.8.3 C3)", {
	timeout: 20_000,
}, async () => {
	const wire = transport();
	const { settings, loop, counter, batches, close } = harness(wire);
	try {
		await loop.submit("Read the record twice.");
		await loop.whenSettled();
		strictEqual(wire.requests.length, 3);
		const [stub, fresh] = toolResults(wire.requests[2]);
		ok(stub?.startsWith('[observation aged] read {"path":"record.md"}'), stub?.slice(0, 200));
		strictEqual(fresh, RECORD);
		strictEqual(batches(), 1);
		const built = counter.agents;

		// Another target with the same model rebuilds the agent rather than hot-swapping it.
		settings.chat.target = targetB.id;
		await loop.submit("Now answer.");
		await loop.whenSettled();
		strictEqual(counter.agents, built + 1, "the switch built a new agent");
		strictEqual(wire.requests.length, 4);
		const [kept, still] = toolResults(wire.requests[3]);
		strictEqual(kept, stub, "the stub reaches the rebuilt agent's request byte for byte");
		strictEqual(still, RECORD);
		strictEqual(batches(), 1, "no second batch notice after the rebuild");
	} finally {
		await close();
	}
});

it("a resumed session in a new process sends the request the stub set had reached (D1-6)", {
	timeout: 20_000,
}, async () => {
	// The record read is superseded past the threshold and stubbed; the small read is superseded below it and is not.
	const wire = transport(["record.md", "record.md", "small.md", "small.md"]);
	const first = harness(wire);
	let id: string | undefined;
	try {
		await first.loop.submit("Read the record twice, then the small file twice.");
		await first.loop.whenSettled();
		id = first.session.current()?.id;
		strictEqual(first.batches(), 1);
	} finally {
		await first.close();
	}
	ok(id);
	const before = toolResults(wire.requests.at(-1));
	ok(before[0]?.startsWith("[observation aged]"), before[0]?.slice(0, 200));
	strictEqual(before[2], SMALL, "below the threshold the small read waits");

	const second = harness(wire);
	try {
		second.session.resume(id);
		replayCurrentSession(
			{ session: second.session, chat: second.loop, readEntries: () => second.session.readEntries() },
			id,
		);
		await second.loop.submit("Now answer.");
		await second.loop.whenSettled();
		deepStrictEqual(toolResults(wire.requests.at(-1)), before, "the resumed request carries the same stub set");
		strictEqual(second.batches(), 0, "the seeded set forms no fresh batch");
	} finally {
		await second.close();
	}
});

for (const [compactions, paths] of [
	[1, ["a.md", "b.md", "c.md"]],
	[2, ["a.md", "b.md", "c.md", "d.md", "e.md"]],
] as const) {
	it(`a resumed session extends the request the live turn sent after ${compactions} in-turn compaction(s) (bt-40)`, {
		timeout: 20_000,
	}, async () => {
		const wire = transport(paths);
		const first = harness(wire, WINDOW);
		let id: string | undefined;
		try {
			await first.loop.submit("Read the files one by one.");
			await first.loop.whenSettled();
			id = first.session.current()?.id;
			strictEqual(first.counter.summaries, compactions, "each compaction cut inside the running turn");
		} finally {
			await first.close();
		}
		ok(id);
		const live = wire.bodies.at(-1) ?? [];
		ok(JSON.stringify(live).includes("Active user instructions (verbatim)"), "the checkpoint carried the request");

		const second = harness(wire, WINDOW);
		try {
			second.session.resume(id);
			replayCurrentSession(
				{ session: second.session, chat: second.loop, readEntries: () => second.session.readEntries() },
				id,
			);
			await second.loop.submit("Now answer.");
			await second.loop.whenSettled();
		} finally {
			await second.close();
		}
		const resumed = wire.bodies.at(-1) ?? [];
		deepStrictEqual(resumed.slice(0, live.length), live, "the resumed request repeats every byte the live turn sent");
		deepStrictEqual(
			resumed.slice(live.length).map((message) => (message as { role: string }).role),
			["assistant", "user"],
		);
	});
}
