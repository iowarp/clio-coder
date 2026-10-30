import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model, StreamOptions } from "@earendil-works/pi-ai";
import { withCodexPromptItems } from "../../src/engine/apis/codex-prompt-items.js";

const codex = { api: "openai-codex-responses", id: "gpt-6-luna" } as Model<Api>;
const tool = { type: "function", name: "read", parameters: {} };
const user = { role: "user", content: [{ type: "input_text", text: "task" }] };

function body(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { model: "gpt-6-luna", instructions: "system", tools: [tool], input: [user], ...extra };
}

async function finish(model: Model<Api>, payload: Record<string, unknown>, transport?: "sse" | "auto") {
	const options = withCodexPromptItems<StreamOptions>(model, transport ? { transport } : {});
	return (await options?.onPayload?.(payload, model)) ?? payload;
}

// DF-0: top-level instructions and tools do not chain across previous_response_id.
test("a continuable Codex body carries its prompt and tools as leading input items", async () => {
	const out = (await finish(codex, body({ prompt_cache_key: "s1" }))) as Record<string, unknown>;
	strictEqual("instructions" in out, false);
	strictEqual("tools" in out, false);
	deepStrictEqual(out.input, [
		{
			type: "additional_tools",
			role: "developer",
			tools: [{ type: "namespace", name: "functions", description: "", tools: [tool] }],
		},
		{ type: "message", role: "developer", content: [{ type: "input_text", text: "system" }] },
		user,
	]);
});

// Pi 1.4 (#10940) declares the initial tools in a head additional_tools item; the continuation prefix must not move.
test("a Pi 1.4 Codex body with head-declared tools keeps the tools item ahead of the instructions", async () => {
	const head = { type: "additional_tools", role: "developer", tools: [tool] };
	const piBody = { model: "gpt-6-luna", instructions: "system", input: [head, user], prompt_cache_key: "s1" };
	deepStrictEqual(await finish(codex, piBody), await finish(codex, body({ prompt_cache_key: "s1" })));
});

test("a Codex body that cannot continue keeps its stock shape", async () => {
	deepStrictEqual(await finish(codex, body()), body());
	deepStrictEqual(await finish(codex, body({ prompt_cache_key: "s1" }), "sse"), body({ prompt_cache_key: "s1" }));
	const responses = { api: "openai-responses", id: "gpt-6-luna" } as Model<Api>;
	deepStrictEqual(await finish(responses, body({ prompt_cache_key: "s1" })), body({ prompt_cache_key: "s1" }));
});
