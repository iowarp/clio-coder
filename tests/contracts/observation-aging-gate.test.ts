import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { Type } from "typebox";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { ToolName } from "../../src/core/tool-names.js";
import {
	EMPTY_CAPABILITIES,
	type ProvidersContract,
	type RuntimeDescriptor,
} from "../../src/domains/providers/index.js";
import litellm from "../../src/domains/providers/runtimes/protocol/litellm.js";
import { createSessionBundle } from "../../src/domains/session/extension.js";
import { createEngineAgent } from "../../src/engine/agent.js";
import { openAICompletionsApiProvider } from "../../src/engine/apis/openai-completions.js";
import type { DeclaredToolEffect } from "../../src/engine/loop-guard.js";
import type { AgentMessage, Model } from "../../src/engine/types.js";
import { createChatLoop } from "../../src/session-control/chat-loop.js";
import { ageObservations, OBSERVATION_AGING_BATCH_BYTES } from "../../src/session-control/observation-aging.js";
import { createGatewayTool } from "../../src/tools/gateway/index.js";
import { createRegistry } from "../../src/tools/registry.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

let env: IsolatedClioEnv;
let previousCwd: string;
beforeEach(async () => {
	env = await isolateClioEnv("observation-aging-gate-");
	previousCwd = process.cwd();
	const project = path.join(env.dir, "project");
	mkdirSync(project);
	process.chdir(project);
});
afterEach(() => {
	process.chdir(previousCwd);
	env.restore();
});

const BIG = `big\n${"r".repeat(OBSERVATION_AGING_BATCH_BYTES + 1024)}`;
const text = (message: AgentMessage | undefined): string =>
	((message as { content?: Array<{ text?: string }> } | undefined)?.content ?? []).map((block) => block.text).join("");

/** The same call twice with a result past the batch threshold each time. */
function repeated(name: string, args: Record<string, unknown>): AgentMessage[] {
	return ["a", "b"].flatMap((id) => [
		{
			role: "assistant",
			content: [{ type: "toolCall", id, name, arguments: args }],
			stopReason: "toolUse",
			timestamp: 0,
		},
		{ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: BIG }], timestamp: 0 },
	]) as unknown as AgentMessage[];
}

const STEP = "extension_wtfp__next_step";
const READER = "extension_wtfp__read_record";
const RECORDER = "extension_wtfp__put_record";
const EFFECTS: Record<string, DeclaredToolEffect> = {
	[STEP]: { readOnly: false, idempotent: false },
	[READER]: { readOnly: true, idempotent: false },
	[RECORDER]: { readOnly: false, idempotent: true },
};
const declared = (tool: string): DeclaredToolEffect | undefined => EFFECTS[tool];

function aged(name: string, args: Record<string, unknown>): boolean {
	const messages = repeated(name, args);
	const out = ageObservations(messages, new Set(), declared);
	return out.batch !== null && text(out.messages[1]).startsWith("[observation aged]");
}

it("only a call A1 reads as making no change is stubbed past the threshold; a step tool never is (WTF-P 0.8.3 C3)", () => {
	// Extension tools: no annotations, or declared neither, answer the same arguments with a new state.
	strictEqual(aged("extension_wtfp__unannotated", {}), false, "an extension tool with no annotations");
	strictEqual(aged(STEP, {}), false, "a step tool declared neither read-only nor idempotent");
	strictEqual(aged(READER, { path: "intro.md" }), true, "a read-only extension tool");
	strictEqual(aged(RECORDER, { path: "intro.md" }), true, "an idempotent extension tool");
	// A gateway call is judged as the capability it runs.
	strictEqual(aged("gateway", { op: "call", capability: STEP, args: {} }), false);
	strictEqual(aged("gateway", { op: "call", capability: READER, args: { path: "intro.md" } }), true);
	// Builtins: read-class tools and plain-read bash age; a bash command that writes or runs a program does not.
	strictEqual(aged("read", { path: "intro.md" }), true);
	strictEqual(aged("grep", { pattern: "x" }), true);
	strictEqual(aged("bash", { command: "cat intro.md | wc -l" }), true);
	strictEqual(aged("bash", { command: "make build" }), false);
	strictEqual(aged("bash", { command: "cat intro.md > copy.md" }), false);
	// Typed git: an inspection ages, a commit does not.
	strictEqual(aged("git", { op: "status" }), true);
	strictEqual(aged("git", { op: "commit", message: "x" }), false);
	// Any other builtin may return a new state for the same arguments.
	strictEqual(aged("monitor", { mode: "collect" }), false);

	// A refused step result keeps every byte, so the request is the ledger's.
	const messages = repeated(STEP, {});
	deepStrictEqual(ageObservations(messages, new Set(), declared).messages, messages);
});

const target = { id: "aging-gate-fixture", runtime: "litellm", url: "http://fixture.invalid:4000" };
const model = litellm.synthesizeModel(target, "aging-model", null) as Model<"openai-completions">;

/** Calls `tool` through the gateway with no arguments twice, then answers; every request sent is kept. */
function transport(tool: string) {
	const args = JSON.stringify({ op: "call", capability: tool, args: {} });
	const requests: AgentMessage[][] = [];
	const fetch: typeof globalThis.fetch = async () => {
		const call = requests.length;
		const encoder = new TextEncoder();
		const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) =>
			encoder.encode(
				`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: model.id, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
			);
		const toolRound = call <= 2;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					chunk(
						toolRound
							? {
									role: "assistant",
									tool_calls: [
										{ index: 0, id: `call-${call}`, type: "function", function: { name: "gateway", arguments: args } },
									],
								}
							: { role: "assistant", content: "done" },
					),
				);
				controller.enqueue(chunk({}, toolRound ? "tool_calls" : "stop"));
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
			},
		});
		return new Response(stream, { headers: { "content-type": "text/event-stream" } });
	};
	return { fetch, requests };
}

/** One uncached-route turn that calls the extension tool twice, with the registry's declared effect. */
async function drive(effect: DeclaredToolEffect): Promise<AgentMessage[][]> {
	const settings = structuredClone(DEFAULT_SETTINGS);
	settings.chat.prewarm = false;
	settings.chat.target = target.id;
	settings.chat.model = model.id;
	settings.chat.thinkingLevel = "off";
	settings.targets = [{ ...target, defaultModel: model.id, cache: { retention: "none" } }];
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
	registry.register(createGatewayTool({ registry }));
	let step = 0;
	registry.register({
		name: STEP as ToolName,
		placement: "gateway",
		description: "Advances the desk one step",
		parameters: Type.Object({}),
		baseActionClass: "read",
		metadata: {
			objective: "advance the desk",
			uiLabel: "wtfp/next_step",
			retrySafety: "not_retry_safe",
			...effect,
			resultSizePolicy: { kind: "bounded", maxBytes: 256 * 1024 },
			costLatency: "local_slow",
		},
		run: async () => {
			step += 1;
			return { kind: "ok", output: `step ${step}\n${BIG}` };
		},
	});
	const wire = transport(STEP);
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
					return openAICompletionsApiProvider.streamSimple(requestModel as Model<"openai-completions">, requestContext, {
						...requestOptions,
						apiKey: "fixture",
						fetch: (...args) => wire.fetch(...args),
					});
				},
			}),
	});
	try {
		await loop.submit("Advance twice.");
		await loop.whenSettled();
		return wire.requests;
	} finally {
		loop.dispose();
		await loop.whenSettled();
		await session.close();
	}
}

const toolResults = (messages: AgentMessage[] | undefined): string[] =>
	(messages ?? []).filter((message) => message.role === "toolResult").map(text);

it("the session reads a registered tool's declared effect: a step tool's earlier result reaches the model whole", {
	timeout: 20_000,
}, async () => {
	const stepped = await drive({ readOnly: false, idempotent: false });
	strictEqual(stepped.length, 3);
	const [first, second] = toolResults(stepped[2]);
	ok(first?.startsWith("step 1\n"), first?.slice(0, 200));
	ok(second?.startsWith("step 2\n"));

	const reader = await drive({ readOnly: true, idempotent: false });
	strictEqual(reader.length, 3);
	const [stub, fresh] = toolResults(reader[2]);
	ok(stub?.startsWith(`[observation aged] ${STEP} {} returned`), stub?.slice(0, 200));
	ok(fresh?.startsWith("step 2\n"));
});
