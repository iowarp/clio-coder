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
import { type ChatLoopEvent, createChatLoop } from "../../src/session-control/chat-loop.js";
import {
	ageObservations,
	createObservationAging,
	OBSERVATION_AGING_BATCH_BYTES,
	observationAgingApplies,
} from "../../src/session-control/observation-aging.js";
import { createRegistry } from "../../src/tools/registry.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

let env: IsolatedClioEnv;
let previousCwd: string;
beforeEach(async () => {
	env = await isolateClioEnv("observation-aging-");
	previousCwd = process.cwd();
	const project = path.join(env.dir, "project");
	mkdirSync(project);
	process.chdir(project);
});
afterEach(() => {
	process.chdir(previousCwd);
	env.restore();
});

const call = (id: string, name: string, args: Record<string, unknown>): AgentMessage =>
	({
		role: "assistant",
		content: [{ type: "toolCall", id, name, arguments: args }],
		stopReason: "toolUse",
		timestamp: 0,
	}) as unknown as AgentMessage;
const result = (id: string, name: string, text: string, isError = false): AgentMessage =>
	({
		role: "toolResult",
		toolCallId: id,
		toolName: name,
		content: [{ type: "text", text }],
		isError,
		timestamp: 0,
	}) as unknown as AgentMessage;
const text = (message: AgentMessage | undefined): string =>
	((message as { content?: Array<{ text?: string }> } | undefined)?.content ?? []).map((block) => block.text).join("");
const body = (bytes: number, tag: string): string => `${tag}\n${"r".repeat(bytes - tag.length - 1)}`;
/** A desk read declared read-only, so a later identical call supersedes it (A1). */
const RECORD_TOOL = "extension_wtfp__read_record";
const declared = (tool: string) => (tool === RECORD_TOOL ? { readOnly: true } : undefined);

it("superseded results wait below the threshold, stub in one batch past it, stay stubbed, and never reach a fresh result (WTF-P 0.8.3 C3)", () => {
	const record = { path: "sections/intro.md" };
	const small = 12_000;
	const messages: AgentMessage[] = [
		call("a", RECORD_TOOL, record),
		result("a", RECORD_TOOL, body(small, "first")),
		call("b", RECORD_TOOL, record),
		result("b", RECORD_TOOL, body(small, "second")),
		call("other", RECORD_TOOL, { path: "sections/methods.md" }),
		result("other", RECORD_TOOL, body(small, "other")),
		// A failed repeat supersedes nothing.
		call("c", RECORD_TOOL, { path: "sections/methods.md" }),
		result("c", RECORD_TOOL, "no such record", true),
	];
	// One superseded copy, 12 KB, waits: below the batch the request is the ledger's bytes.
	const below = ageObservations(messages, new Set(), declared);
	strictEqual(below.batch, null);
	deepStrictEqual(below.messages, messages);
	strictEqual(below.stubbed.size, 0);

	// A gateway call unwraps to the capability it runs, so it supersedes both direct reads; 24 KB waiting still
	// crosses nothing, and the next copy of the same record brings it to 36 KB, past 32 KiB.
	messages.push(
		call("d", "gateway", { op: "call", capability: RECORD_TOOL, args: record }),
		result("d", "gateway", body(small, "third")),
	);
	strictEqual(ageObservations(messages, new Set(), declared).batch, null);
	messages.push(call("e", RECORD_TOOL, record), result("e", RECORD_TOOL, body(small, "fourth")));
	const crossed = ageObservations(messages, new Set(), declared);
	ok(crossed.batch, "three superseded copies reach the batch");
	strictEqual(crossed.batch.results, 3);
	ok(OBSERVATION_AGING_BATCH_BYTES <= 3 * small);
	ok(crossed.batch.bytesSaved > 3 * small - 3 * 512, JSON.stringify(crossed.batch));
	for (const index of [1, 3, 9]) {
		const stub = text(crossed.messages[index]);
		ok(stub.startsWith(`[observation aged] ${RECORD_TOOL} `), stub);
		ok(stub.includes('{"path":"sections/intro.md"}') && stub.includes("already in context"), stub);
	}
	// The newest copy, the unrelated record and the failed call are never stubbed, and the input is untouched.
	strictEqual(text(crossed.messages[11]), body(small, "fourth"));
	strictEqual(text(crossed.messages[5]), body(small, "other"));
	strictEqual(text(crossed.messages[7]), "no such record");
	strictEqual(text(messages[1]), body(small, "first"));

	// A later request with a little more superseded keeps the batch stubbed byte for byte and forms no new batch.
	messages.push(call("f", RECORD_TOOL, record), result("f", RECORD_TOOL, body(small, "fifth")));
	const later = ageObservations(messages, crossed.stubbed, declared);
	strictEqual(later.batch, null);
	for (const index of [1, 3, 9]) strictEqual(text(later.messages[index]), text(crossed.messages[index]));
	strictEqual(text(later.messages[11]), body(small, "fourth"), "a newly superseded copy waits for its own batch");
	strictEqual(text(later.messages[13]), body(small, "fifth"));
});

it("a repeat that delivered less than the earlier read supersedes nothing (Astra r1-3)", () => {
	const read = (id: string, output: string, shownCount: number, truncated: boolean): AgentMessage =>
		({
			...(result(id, "read", output) as object),
			details: { observation: { tool: "read", unit: "lines", shownCount, shownBytes: output.length, truncated } },
		}) as unknown as AgentMessage;
	const args = { path: "big.ts" };
	const whole = body(40_000, "whole");
	const messages: AgentMessage[] = [
		call("a", "read", args),
		read("a", whole, 800, false),
		// The pool is exhausted: an ok notice that shows nothing.
		call("b", "read", args),
		read("b", "[observation budget exhausted for this turn before read reading big.ts]", 0, true),
		// A budget-clipped repeat shows fewer bytes than the first read did.
		call("c", "read", args),
		read("c", body(10_000, "clipped"), 200, true),
	];
	const kept = ageObservations(messages, new Set(), declared, 1);
	strictEqual(kept.batch, null);
	deepStrictEqual(kept.messages, messages);
	// A complete repeat supersedes all three; the notice is shorter than a stub and stays.
	messages.push(call("d", "read", args), read("d", whole, 800, false));
	const aged = ageObservations(messages, new Set(), declared, 1);
	strictEqual(aged.batch?.results, 2);
	ok(text(aged.messages[1]).startsWith("[observation aged] read "));
	ok(text(aged.messages[5]).startsWith("[observation aged] read "));
	strictEqual(text(aged.messages[7]), whole);
});

it("the gate admits small or uncached routes only; a cached frontier route is untouched", () => {
	ok(observationAgingApplies({ modelTier: "small", promptCaching: true }));
	ok(observationAgingApplies({ modelTier: "frontier", promptCaching: false }));
	ok(!observationAgingApplies({ modelTier: "frontier", promptCaching: true }));
	ok(!observationAgingApplies({ modelTier: "standard" }));
	const big = body(OBSERVATION_AGING_BATCH_BYTES + 1024, "big");
	const messages = [
		call("a", RECORD_TOOL, { id: 1 }),
		result("a", RECORD_TOOL, big),
		call("b", RECORD_TOOL, { id: 1 }),
		result("b", RECORD_TOOL, big),
	];
	const aging = createObservationAging(declared);
	const cached = aging.project(messages, { modelTier: "frontier", promptCaching: true }, "s");
	strictEqual(cached.batch, null);
	deepStrictEqual(cached.messages, messages);
	const small = aging.project(messages, { modelTier: "small", promptCaching: true }, "s");
	strictEqual(small.batch?.results, 1);
	ok(text(small.messages[1]).startsWith("[observation aged]"));
});

const target = { id: "aging-fixture", runtime: "litellm", url: "http://fixture.invalid:4000" };
const model = litellm.synthesizeModel(target, "aging-model", null) as Model<"openai-completions">;
const RECORD = body(40_000, "record body");

/** Two identical tool calls, then an answer; every request the provider would receive is kept. */
function transport() {
	const requests: AgentMessage[][] = [];
	const fetch: typeof globalThis.fetch = async () => {
		const call = requests.length;
		const encoder = new TextEncoder();
		const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) =>
			encoder.encode(
				`data: ${JSON.stringify({
					id: "fixture",
					object: "chat.completion.chunk",
					model: model.id,
					choices: [{ index: 0, delta, finish_reason }],
					// A provider count anchors the live budget, as a real route's usage does.
					...(finish_reason ? { usage: { prompt_tokens: 3000 + 10_000 * call, completion_tokens: 20 } } : {}),
				})}\n\n`,
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

async function drive(retention: "none" | undefined): Promise<{
	requests: AgentMessage[][];
	events: ChatLoopEvent[];
	ledger: string;
	/** The published next-request input at each send, after the post-tool guard and admission. */
	published: Array<number | null>;
}> {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = false;
	settings.chat.target = target.id;
	settings.chat.model = model.id;
	settings.chat.thinkingLevel = "off";
	settings.targets = [{ ...target, defaultModel: model.id, ...(retention ? { cache: { retention } } : {}) }];
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
	const published: Array<number | null> = [];
	const loop = createChatLoop({
		getSettings: () => settings,
		providers: context.getContract("providers") as ProvidersContract,
		knownTargets: () => new Set([target.id]),
		session,
		toolRegistry: registry,
		bus: context.bus,
		createAgent: (options) =>
			createEngineAgent({
				...options,
				streamFn: (requestModel, requestContext, requestOptions) => {
					wire.requests.push(structuredClone(requestContext.messages) as AgentMessage[]);
					published.push(loop.contextUsage().tokens);
					return openAICompletionsApiProvider.streamSimple(requestModel as Model<"openai-completions">, requestContext, {
						...requestOptions,
						apiKey: "fixture",
						fetch: (...args) => wire.fetch(...args),
					});
				},
			}),
	});
	loop.onEvent((event) => {
		events.push(event);
	});
	try {
		await loop.submit("Read the record twice.");
		await loop.whenSettled();
		return { requests: wire.requests, events, ledger: JSON.stringify(session.readEntries()), published };
	} finally {
		loop.dispose();
		await loop.whenSettled();
		await session.close();
	}
}

const toolResults = (messages: AgentMessage[] | undefined): string[] =>
	(messages ?? []).filter((message) => message.role === "toolResult").map(text);

it("an uncached route's request stubs the superseded read while the ledger keeps it; a cached route sends it whole", {
	timeout: 20_000,
}, async () => {
	const uncached = await drive("none");
	strictEqual(uncached.requests.length, 3);
	const [first, second] = toolResults(uncached.requests[2]);
	ok(first?.startsWith('[observation aged] read {"path":"record.md"} returned 40000 bytes here'), first);
	strictEqual(second, RECORD, "the fresh copy reaches the model");
	deepStrictEqual(toolResults(uncached.requests[1]), [RECORD], "nothing is superseded before the repeat");
	ok(
		uncached.events.some(
			(event) =>
				event.type === "notice" &&
				/observation aging: 1 superseded tool result stubbed in the request, \d+ bytes saved/u.test(
					(event as { text?: string }).text ?? "",
				),
		),
		"the batch is announced with the bytes it saved",
	);
	// The ledger holds both reads in full: aging changed only the outgoing copy.
	strictEqual(uncached.ledger.split("record body").length - 1, 2);
	ok(!uncached.ledger.includes("[observation aged]"));
	ok(uncached.ledger.includes('"observation_aging"'), "the reply after the batch names its expected cold reason");

	const cached = await drive(undefined);
	strictEqual(cached.requests.length, 3);
	deepStrictEqual(toolResults(cached.requests[2]), [RECORD, RECORD]);
	// Astra r1-5: the window checks price the request the provider receives. The aged route's third request is
	// about one 40 KB read (10K tokens) smaller, and so is its published budget; the requests before it agree.
	deepStrictEqual(uncached.published.slice(0, 2), cached.published.slice(0, 2));
	const [agedTokens, wholeTokens] = [uncached.published[2] ?? 0, cached.published[2] ?? 0];
	ok(wholeTokens - agedTokens > 9_000 && wholeTokens - agedTokens < 10_500, `${agedTokens} vs ${wholeTokens}`);
});
