import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { test } from "node:test";
import {
	patchTerminalToolPayload,
	patchWorkerRequestPayload,
	supportsNamedToolChoice,
} from "../../src/engine/provider-payload.js";
import type { EngineModel } from "../../src/engine/types.js";

const name = "clio_submit_result";
const model = (api: string) => ({ id: "fixture", provider: "fixture", api }) as EngineModel;
const tools = [
	{ type: "function", function: { name: "write" } },
	{ type: "function", function: { name } },
];
test("terminal handoff overrides work-tool lock with one required tool", () => {
	deepStrictEqual(
		patchWorkerRequestPayload({ tools }, model("openai-completions"), {
			runtimeId: "litellm",
			toolSurfaceLocked: true,
			terminalToolName: name,
		}),
		{ tools: [tools[1]], tool_choice: "required", parallel_tool_calls: false },
	);
});
test("Anthropic terminal handoff disables thinking and parallel calls", () => {
	deepStrictEqual(
		patchTerminalToolPayload(
			{ tools: [{ name: "write" }, { name }], thinking: { type: "adaptive" }, output_config: { effort: "high" } },
			model("anthropic-messages"),
			name,
		),
		{ tools: [{ name }], tool_choice: { type: "tool", name, disable_parallel_tool_use: true } },
	);
});
test("Responses terminal handoff uses native function choice", () => {
	deepStrictEqual(
		patchTerminalToolPayload(
			{
				tools: [
					{ type: "function", name: "write" },
					{ type: "function", name },
				],
			},
			model("openai-responses"),
			name,
		),
		{ tools: [{ type: "function", name }], tool_choice: { type: "function", name }, parallel_tool_calls: false },
	);
});
test("Google terminal handoff narrows nested declarations", () => {
	deepStrictEqual(
		patchTerminalToolPayload(
			{ config: { tools: [{ functionDeclarations: [{ name: "write" }, { name }] }] } },
			model("google-generative-ai"),
			name,
		),
		{
			config: {
				tools: [{ functionDeclarations: [{ name }] }],
				toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [name] } },
			},
		},
	);
});
test("Bedrock terminal handoff narrows tool specs", () => {
	deepStrictEqual(
		patchTerminalToolPayload(
			{ toolConfig: { tools: [{ toolSpec: { name: "write" } }, { toolSpec: { name } }] } },
			model("bedrock-converse-stream"),
			name,
		),
		{ toolConfig: { tools: [{ toolSpec: { name } }], toolChoice: { tool: { name } } } },
	);
});
test("unknown API does not claim forced-tool support", () => {
	strictEqual(supportsNamedToolChoice("unknown-api"), false);
	strictEqual(patchTerminalToolPayload({ tools }, model("unknown-api"), name), undefined);
});
test("admitted LiteLLM response schema uses gateway dialect while llama retains native dialect", () => {
	const schema = { type: "object", properties: {} };
	deepStrictEqual(
		patchWorkerRequestPayload({}, model("openai-completions"), { runtimeId: "litellm", responseSchema: schema }),
		{ response_format: { type: "json_schema", json_schema: { name: "clio_result", strict: true, schema } } },
	);
	deepStrictEqual(
		patchWorkerRequestPayload({}, model("openai-completions"), { runtimeId: "llamacpp", responseSchema: schema }),
		{ response_format: { type: "json_object", schema } },
	);
	throws(() =>
		patchWorkerRequestPayload({}, model("openai-completions"), { runtimeId: "ollama", responseSchema: schema }),
	);
});
