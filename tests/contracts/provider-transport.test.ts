import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import type { AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";

import { createRuntimeRegistry } from "../../src/domains/providers/registry.js";
import { registerBuiltinRuntimes } from "../../src/domains/providers/runtimes/builtins.js";
import {
	makeOpenAICompatRuntime,
	synthesizeOpenAICompatModel,
} from "../../src/domains/providers/runtimes/protocol/openai-compat.js";
import { EMPTY_CAPABILITIES } from "../../src/domains/providers/types/capability-flags.js";
import { openAICompletionsApiProvider } from "../../src/engine/apis/openai-completions.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function completionResponse(text: string): Response {
	const chunks = [
		{ model: "wire-model", choices: [{ index: 0, delta: { content: text } }] },
		{
			model: "wire-model",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		},
	];
	const body = [...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`), "data: [DONE]", ""].join("\n\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("provider transport boundary", () => {
	it("selects canonical built-in runtimes and aliases without duplicating them", () => {
		const registry = createRuntimeRegistry();
		registerBuiltinRuntimes(registry);
		const canonical = registry.get("lmstudio");
		ok(canonical !== null);
		strictEqual(registry.get("lmstudio-native"), canonical);
		strictEqual(registry.list().filter((runtime) => runtime.id === "lmstudio").length, 1);
		strictEqual(registry.get("not-installed"), null);
	});

	it("sends one normalized OpenAI-compatible request and returns the streamed answer", async () => {
		const model = synthesizeOpenAICompatModel({
			target: {
				id: "local",
				runtime: "openai-compat",
				url: "http://localhost:1234/v1/",
				auth: { headers: { "X-Contract": "provider-wire" } },
			},
			wireModelId: "wire-model",
			kb: null,
			defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true },
			provider: "openai-compat",
		}) as Model<"openai-completions">;
		strictEqual(model.baseUrl, "http://localhost:1234/v1");

		let requestUrl = "";
		let payload: Record<string, unknown> | undefined;
		const events: AssistantMessageEvent[] = [];
		const context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] } as unknown as Context;
		for await (const event of openAICompletionsApiProvider.streamSimple(model, context, {
			apiKey: "test-key",
			onPayload: (value) => {
				payload = value as Record<string, unknown>;
				return undefined;
			},
			fetch: async (input) => {
				requestUrl = String(input);
				return completionResponse("wire-ok");
			},
		})) {
			events.push(event);
		}
		strictEqual(requestUrl, "http://localhost:1234/v1/chat/completions");
		strictEqual(payload?.model, "wire-model");
		ok(Array.isArray(payload?.messages));
		const done = events.find((event) => event.type === "done");
		ok(done?.type === "done");
		deepStrictEqual(done.message.content, [{ type: "text", text: "wire-ok" }]);
	});

	it("reports an unavailable probe instead of inventing a healthy target", async () => {
		const runtime = makeOpenAICompatRuntime({
			id: "contract-runtime",
			displayName: "Contract Runtime",
			provider: "contract",
			auth: "none",
			tier: "protocol",
			defaultCapabilities: { ...EMPTY_CAPABILITIES, chat: true },
		});
		const result = await runtime.probe?.(
			{ id: "missing-url", runtime: runtime.id },
			{ credentialsPresent: new Set(), httpTimeoutMs: 100, authToken: null },
		);
		strictEqual(result?.ok, false);
		ok((result?.error?.length ?? 0) > 0);
		strictEqual(result?.models, undefined);
	});

	it("loads a valid runtime plugin from a directory", async () => {
		const directory = mkdtempSync(join(tmpdir(), "clio-runtime-plugin-"));
		temporaryDirectories.push(directory);
		writeFileSync(
			join(directory, "contract-plugin.js"),
			`export default {
				id: "contract-plugin", displayName: "Contract Plugin", kind: "http",
				apiFamily: "openai-completions", auth: "none",
				defaultCapabilities: { chat: true },
				synthesizeModel: (_target, wireModelId) => ({ id: wireModelId, provider: "contract-plugin" })
			};\n`,
			"utf8",
		);
		const registry = createRuntimeRegistry();
		deepStrictEqual(await registry.loadFromDir(directory), ["contract-plugin"]);
		const plugin = registry.get("contract-plugin");
		ok(plugin !== null);
		strictEqual(plugin.synthesizeModel({ id: "target", runtime: plugin.id }, "model", null).id, "model");
	});
});
