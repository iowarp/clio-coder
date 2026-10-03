import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { Type } from "typebox";
import { responseFormatFor, responseSchemaDialectFor } from "../../src/core/response-schema.js";
import { engineStreamSimple } from "../../src/engine/api-registry.js";
import { engineModels } from "../../src/engine/models.js";
import { applyToolRounds, supportsNamedToolChoice, type ToolRound } from "../../src/engine/provider-payload.js";
import type { EngineModel } from "../../src/engine/types.js";

const name = "clio_submit_result";
const tool = (toolName: string) => ({
	name: toolName,
	description: toolName,
	parameters: Type.Object({ path: Type.String() }),
});
const handoff: ToolRound = { kind: "required", toolName: name, handoff: true };
const lock: ToolRound = { kind: "tools-removed" };

/** The wire body Pi's own serializer builds for one controlled round; no network is reached. */
async function wire(model: EngineModel, rounds: readonly (ToolRound | undefined)[], reasoning = true) {
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
		{ apiKey: "fixture", ...(reasoning ? { reasoning: "high" as const } : {}) },
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

test("terminal handoff overrides work-tool lock with one required tool", async () => {
	const model = catalog("openrouter", "google/gemini-2.5-flash:batch");
	const body = await wire(model, [handoff, lock]);
	deepStrictEqual(names(body.tools), [name]);
	strictEqual(body.tool_choice, "required");
	strictEqual(body.parallel_tool_calls, false);
});
test("Anthropic terminal handoff disables thinking and parallel calls", async () => {
	for (const id of ["claude-opus-4-8", "claude-opus-5"]) {
		const body = await wire(catalog("anthropic", id), [handoff]);
		deepStrictEqual(names(body.tools), [name]);
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
		deepStrictEqual(names(body.tools), [name]);
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
	deepStrictEqual(names(body.tools), [name]);
	deepStrictEqual(body.tool_choice, { type: "function", name });
	strictEqual(body.parallel_tool_calls, false);
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
