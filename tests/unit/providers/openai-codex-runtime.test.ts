import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import openaiCodexRuntime from "../../../src/domains/providers/runtimes/cloud/openai-codex.js";

describe("providers/runtimes/openai-codex", () => {
	it("registers the expected runtime shape", () => {
		strictEqual(openaiCodexRuntime.id, "openai-codex");
		strictEqual(openaiCodexRuntime.apiFamily, "openai-codex-responses");
		strictEqual(openaiCodexRuntime.auth, "oauth");
	});

	it("synthesizes gpt-5.4 models against the ChatGPT backend-api base url", async () => {
		const endpoint = {
			id: "codex-pro",
			runtime: "openai-codex",
			defaultModel: "gpt-5.4",
		};
		const model = openaiCodexRuntime.synthesizeModel(endpoint, "gpt-5.4", null);
		strictEqual(model.provider, "openai-codex");
		strictEqual(model.api, "openai-codex-responses");
		strictEqual(model.baseUrl, "https://chatgpt.com/backend-api");
		strictEqual(model.reasoning, true);
		const discovered = await openaiCodexRuntime.probeModels?.(endpoint, {
			credentialsPresent: new Set<string>(),
			httpTimeoutMs: 1_000,
		});
		ok(discovered?.includes("gpt-5.4"));
		ok(discovered?.includes("gpt-5.4-mini"));
	});
});
