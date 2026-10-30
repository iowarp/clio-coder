import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { createAssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { responseFormatFor, responseSchemaDialectFor } from "../../src/core/response-schema.js";
import ollamaRuntime from "../../src/domains/providers/runtimes/local-native/ollama.js";
import litellmRuntime from "../../src/domains/providers/runtimes/protocol/litellm.js";
import { engineStreamSimple } from "../../src/engine/api-registry.js";
import { ollamaNativeApiProvider } from "../../src/engine/apis/ollama-native.js";
import { engineModels } from "../../src/engine/models.js";
import {
	applyToolRounds,
	deterministicSampling,
	supportsNamedToolChoice,
	type ToolRound,
} from "../../src/engine/provider-payload.js";
import type { EngineModel, ToolRoundRecord } from "../../src/engine/types.js";

const name = "clio_submit_result";
const tool = (toolName: string) => ({
	name: toolName,
	description: toolName,
	parameters: Type.Object({ path: Type.String() }),
});
const handoff: ToolRound = { kind: "required", toolName: name, handoff: true };
const lock: ToolRound = { kind: "tools-removed" };

/** The wire body Pi's own serializer builds for one controlled round; no network is reached. */
async function wire(
	model: EngineModel,
	rounds: readonly (ToolRound | undefined)[],
	reasoning = true,
	extra: NonNullable<Parameters<typeof applyToolRounds>[2]> = {},
) {
	const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 };
	const context = {
		systemPrompt: "Terminal protocol.",
		tools: [tool("write"), tool(name)],
		messages: [
			{ role: "user" as const, content: "inspect", timestamp: 1 },
			{
				role: "assistant" as const,
				api: model.api,
				provider: model.provider,
				model: model.id,
				stopReason: "toolUse" as const,
				timestamp: 2,
				usage: { ...usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				content: [{ type: "toolCall" as const, id: "call_1", name: "write", arguments: { path: "a" } }],
			},
			{
				role: "toolResult" as const,
				toolCallId: "call_1",
				toolName: "write",
				content: [{ type: "text" as const, text: "ok" }],
				isError: false,
				timestamp: 3,
			},
			{ role: "user" as const, content: "continue", timestamp: 4 },
		],
	};
	const controlled = applyToolRounds(
		model,
		context,
		{ apiKey: "fixture", ...(reasoning ? { reasoning: "high" as const } : {}), ...extra },
		rounds,
	);
	let body: Record<string, unknown> = {};
	await engineStreamSimple(model, controlled.context, {
		...controlled.options,
		onPayload: async (payload, current) => {
			const next = (await controlled.options?.onPayload?.(payload, current)) ?? payload;
			body = structuredClone(next) as Record<string, unknown>;
			throw new Error("captured before network I/O");
		},
	}).result();
	return body;
}
const catalog = (provider: string, id: string): EngineModel => {
	const model = engineModels.getModel(provider as never, id) as EngineModel | undefined;
	ok(model, `${provider}/${id} must exist in the Pi catalog`);
	return model;
};
// Pi 1.0 appends a reserved deferred placeholder to managed-tool Claude requests.
const names = (tools: unknown) =>
	(tools as Array<{ name?: string; function?: { name: string }; type?: string }>)
		.map((entry) => entry.function?.name ?? entry.name)
		.filter((entry) => entry !== "__pi_deferred_placeholder__");
// Pi 1.4 (#10940) declares Responses and Codex tools in a head additional_tools item instead of top-level tools.
const declared = (body: Record<string, unknown>) => {
	if (body.tools !== undefined) return names(body.tools);
	const head = (body.input as Array<{ type?: string; tools?: Array<{ type?: string; tools?: unknown[] }> }>)?.[0];
	if (head?.type !== "additional_tools" || head.tools === undefined) return undefined;
	return names(head.tools.flatMap((entry) => (entry.type === "namespace" ? (entry.tools ?? []) : [entry])));
};

test("terminal handoff overrides work-tool lock with one required tool", async () => {
	const model = catalog("openrouter", "google/gemini-2.5-flash");
	const body = await wire(model, [handoff, lock]);
	deepStrictEqual(names(body.tools), [name]);
	strictEqual(body.tool_choice, "required");
	strictEqual(body.parallel_tool_calls, false);
});
test("Anthropic terminal handoff disables thinking and parallel calls", async () => {
	for (const id of ["claude-opus-4-8", "claude-opus-5"]) {
		const body = await wire(catalog("anthropic", id), [handoff]);
		deepStrictEqual(names(body.tools), ["write", name]);
		deepStrictEqual(body.tool_choice, { type: "tool", name, disable_parallel_tool_use: true });
		strictEqual(body.thinking, undefined);
		strictEqual((body.output_config as { effort?: string } | undefined)?.effort, undefined);
	}
});
for (const id of ["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1", "claude-mythos-5-1"]) {
	test(`${id} terminal handoff uses auto and preserves Anthropic thinking`, async () => {
		// Mythos has no catalog row; its forced-choice rule rides the id, so a sibling row stands in for the wire shape.
		const anthropic = id.startsWith("claude-mythos")
			? { ...catalog("anthropic", "claude-fable-5-1"), id }
			: catalog("anthropic", id);
		const body = await wire(anthropic, [handoff]);
		deepStrictEqual(names(body.tools), ["write", name]);
		deepStrictEqual(body.tool_choice, { type: "auto", disable_parallel_tool_use: true });
		strictEqual((body.thinking as { type: string }).type, "adaptive");
		deepStrictEqual(body.output_config, { effort: "high" });
		const sibling = id.startsWith("claude-mythos") ? "anthropic.claude-fable-5-1" : `anthropic.${id}`;
		const bedrock = await wire({ ...catalog("amazon-bedrock", sibling), id: `anthropic.${id}` }, [handoff]);
		const config = bedrock.toolConfig as { tools: Array<{ toolSpec: { name: string } }>; toolChoice: unknown };
		deepStrictEqual(
			config.tools.map((entry) => entry.toolSpec.name),
			[name],
		);
		deepStrictEqual(config.toolChoice, { auto: {} });
	});
}
test("Responses terminal handoff uses native function choice", async () => {
	const body = await wire(catalog("openai", "gpt-5.6-luna"), [handoff]);
	deepStrictEqual(declared(body), [name]);
	deepStrictEqual(body.tool_choice, { type: "function", name });
	strictEqual(body.parallel_tool_calls, false);
});
test("Codex sends only accepted tool_choice shapes and retries one rejected choice without force", async () => {
	const codex = catalog("openai-codex", "gpt-6-luna");
	const account = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } }));
	const apiKey = `e30.${account.toString("base64url")}.sig`;
	// gpt-6-luna takes native tool changes, so the worker's handoff round keeps the work phase's parallel setting (#423).
	const codexHandoff: ToolRound = { kind: "required", toolName: name, handoff: false };
	const rounds: Array<[string, ToolRound[], string[] | undefined, unknown]> = [
		["ordinary", [], ["write", name], "auto"],
		// The tester call that died in #426: the worker sends its terminal handoff ahead of the synthesis lock.
		["handoff", [codexHandoff, lock], [name], "auto"],
		// The worker synthesis lock strips the surface, so Codex sees no tools and no tool_choice.
		["synthesis", [lock], undefined, undefined],
		// Codex rejects a forced choice once Pi's WS delta omits tools; auto over the one narrowed tool is safe.
		["required", [{ kind: "required", toolName: "write" }], ["write"], "auto"],
		["middleware text-only", [{ kind: "text-only" }], ["write", name], "none"],
	];
	const bodies = new Map<string, Record<string, unknown>>();
	for (const [label, round, tools, choice] of rounds) {
		const body = await wire(codex, round, true, { apiKey });
		bodies.set(label, body);
		deepStrictEqual(declared(body), tools, label);
		// Pi's own default may be omitted on an ordinary round; any forced round must spell its choice.
		if (label === "ordinary") ok(body.tool_choice === undefined || body.tool_choice === "auto", label);
		else strictEqual(body.tool_choice, choice, label);
	}
	strictEqual(bodies.get("handoff")?.parallel_tool_calls, bodies.get("ordinary")?.parallel_tool_calls);
	for (const [label, round, , choice] of rounds) {
		// The record names the wire choice of each forced round; tools-removed sends none, recorded as null.
		const records = applyToolRounds(
			codex,
			{ messages: [], tools: [tool("write"), tool(name)] },
			undefined,
			round,
		).toolRounds;
		deepStrictEqual(
			records?.map((entry) => entry.choice),
			round.length === 0 ? undefined : [choice ?? null],
			label,
		);
	}
	// Loaded on demand so the round table above still reports its own failure on a build without the retry seam.
	const { streamToolRound } = await import("../../src/engine/provider-payload.js");
	const reply = (stopReason: "stop" | "error", errorMessage?: string) => ({
		role: "assistant" as const,
		content: [],
		api: codex.api,
		provider: codex.provider,
		model: codex.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		...(errorMessage === undefined ? {} : { errorMessage }),
		timestamp: 5,
	});
	const attempt = async (fault: string, targetId: string, afterOutput = false) => {
		const sent: unknown[] = [];
		const controlled = applyToolRounds(codex, { messages: [], tools: [tool("write")] }, undefined, [
			{ kind: "text-only" },
		]);
		const result = await streamToolRound(
			codex,
			controlled,
			(request) => {
				sent.push(request.options?.toolChoice);
				const events = createAssistantMessageEventStream();
				const message = sent.length === 1 ? reply("error", fault) : reply("stop");
				if (afterOutput && sent.length === 1) {
					events.push({ type: "start", partial: reply("stop") });
					events.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial: reply("stop") });
				}
				events.push(
					message.stopReason === "error"
						? { type: "error", reason: "error", error: message }
						: { type: "done", reason: "stop", message },
				);
				events.end(message);
				return events;
			},
			targetId,
		).result();
		return { sent, result };
	};
	const rejection = "400 Unsupported parameter: 'tool_choice' is not supported by rustponsesapi";
	const rejected = await attempt(rejection, "t426");
	deepStrictEqual(rejected.sent, ["none", "auto"]);
	strictEqual(rejected.result.stopReason, "stop");
	deepStrictEqual(
		(rejected.result as typeof rejected.result & { toolRounds?: ToolRoundRecord[] }).toolRounds?.map((entry) => [
			entry.attempt,
			entry.choice,
		]),
		[
			[0, "none"],
			[1, "auto"],
		],
	);
	// The rejection is remembered for the target, so its next text-only round starts on auto.
	const remembered = applyToolRounds(
		codex,
		{ messages: [], tools: [tool("write")] },
		undefined,
		[{ kind: "text-only" }],
		"t426",
	).toolRounds?.[0];
	deepStrictEqual([remembered?.choice, remembered?.downgradeReason], ["auto", rejection]);
	// Each fault names tool_choice, so only its status keeps it from being read as a choice rejection; a 400
	// about anything else is not one either.
	for (const fault of [
		"401 Unauthorized tool_choice",
		"429 Rate limit tool_choice",
		"500 Server error tool_choice",
		"400 Invalid request: input[0] malformed",
	]) {
		const failed = await attempt(fault, `t426-${fault.slice(0, 3)}`);
		deepStrictEqual(failed.sent, ["none"], fault);
		strictEqual(failed.result.stopReason, "error", fault);
	}
	// Output already streamed, so a rejection then cannot be replayed without force.
	const late = await attempt(rejection, "t426-late", true);
	deepStrictEqual(late.sent, ["none"]);
	strictEqual(late.result.stopReason, "error");
});
test("Google terminal handoff narrows nested declarations", async () => {
	const body = await wire(catalog("google", "gemini-3.1-pro-preview"), [handoff]);
	const config = body.config as {
		tools: Array<{ functionDeclarations: Array<{ name: string }> }>;
		toolConfig: { functionCallingConfig: { mode: string } };
	};
	deepStrictEqual(
		config.tools.flatMap((entry) => entry.functionDeclarations.map((declaration) => declaration.name)),
		[name],
	);
	// One declared function under ANY is the forced call; Pi has no allowed-names option.
	strictEqual(config.toolConfig.functionCallingConfig.mode, "ANY");
});
test("Bedrock terminal handoff narrows tool specs", async () => {
	const body = await wire(catalog("amazon-bedrock", "anthropic.claude-sonnet-4-5-20250929-v1:0"), [handoff]);
	const config = body.toolConfig as { tools: Array<{ toolSpec: { name: string } }>; toolChoice: unknown };
	deepStrictEqual(
		config.tools.map((entry) => entry.toolSpec.name),
		[name],
	);
	deepStrictEqual(config.toolChoice, { tool: { name } });
	// A forced choice and thinking are exclusive on Claude: the round leaves reasoning unset.
	strictEqual(body.additionalModelRequestFields, undefined);
});
test("unknown API does not claim forced-tool support", () => {
	strictEqual(supportsNamedToolChoice("unknown-api"), false);
	const model = { id: "fixture", provider: "fixture", api: "unknown-api" } as EngineModel;
	const request = { messages: [], tools: [tool(name)] };
	const controlled = applyToolRounds(model, request, undefined, [handoff]);
	strictEqual(controlled.context, request);
	strictEqual(controlled.options, undefined);
});
test("deterministic sampling is limited to compatible self-hosted APIs", async () => {
	// The worker merges deterministicSampling over its stream options; the body below is what each API then serializes.
	const sampled = (model: EngineModel, runtimeId: string) =>
		wire(model, [], false, { ...deterministicSampling(model, runtimeId) });
	const gateway = (id: string) =>
		litellmRuntime.synthesizeModel({ id: "gateway", runtime: "litellm", url: "http://gateway.invalid:4000" }, id, null);
	const local = await sampled(gateway("dynamo/qwen3.8-27b") as EngineModel, "litellm");
	strictEqual(local.temperature, 0);
	strictEqual(local.seed, 42);
	// Anthropic proxies reject non-default sampling even behind a self-hosted gateway.
	const claude = await sampled(gateway("claude-sonnet-4") as EngineModel, "litellm");
	strictEqual(claude.temperature, undefined);
	strictEqual(claude.seed, undefined);
	// Hosted dialects may reject a seed or a zero temperature, so a runtime outside the self-hosted list sends neither.
	const hosted = await sampled(catalog("openrouter", "google/gemini-2.5-flash"), "openrouter");
	strictEqual(hosted.temperature, undefined);
	strictEqual(hosted.seed, undefined);
	// Ollama has no Pi serializer; its adapter carries the seed as a nested option.
	const ollama = ollamaRuntime.synthesizeModel?.(
		{ id: "o", runtime: "ollama", url: "http://127.0.0.1:9", lifecycle: "user-managed" },
		"qwen3:30b-a3b-instruct",
		null,
	) as Model<"ollama-native">;
	let request: { options?: { temperature?: number; seed?: number } } = {};
	await ollamaNativeApiProvider
		.streamSimple(
			ollama,
			{ messages: [{ role: "user", content: "inspect", timestamp: 1 }] },
			{
				apiKey: "fixture",
				...deterministicSampling(ollama, "ollama"),
				onPayload: (payload) => {
					request = structuredClone(payload) as typeof request;
					throw new Error("captured before network I/O");
				},
			},
		)
		.result();
	strictEqual(request.options?.temperature, 0);
	strictEqual(request.options?.seed, 42);
});
test("admitted LiteLLM response schema uses gateway dialect while llama retains native dialect", () => {
	const schema = { type: "object", properties: {} };
	const litellm = responseSchemaDialectFor("litellm");
	const llamacpp = responseSchemaDialectFor("llamacpp");
	ok(litellm !== null && llamacpp !== null);
	deepStrictEqual(responseFormatFor(litellm, schema, "clio_result"), {
		type: "json_schema",
		json_schema: { name: "clio_result", strict: true, schema },
	});
	deepStrictEqual(responseFormatFor(llamacpp, schema, "clio_result"), { type: "json_object", schema });
});
