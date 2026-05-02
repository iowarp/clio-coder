import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { LMStudioClient } from "@lmstudio/sdk";

import { mergeCapabilities } from "../../../src/domains/providers/capabilities.js";
import { BUILTIN_RUNTIMES } from "../../../src/domains/providers/runtimes/builtins.js";
import { buildProviderSupportEntry } from "../../../src/domains/providers/support.js";
import type { RuntimeDescriptor } from "../../../src/domains/providers/types/runtime-descriptor.js";

const VALID_API_FAMILIES = new Set<string>([
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"azure-openai-responses",
	"anthropic-messages",
	"bedrock-converse-stream",
	"google-generative-ai",
	"google-gemini-cli",
	"google-vertex",
	"lmstudio-native",
	"mistral-conversations",
	"ollama-native",
	"rerank-http",
	"embeddings-http",
	"claude-agent-sdk",
	"subprocess-claude-code",
	"subprocess-codex",
	"subprocess-gemini",
	"subprocess-copilot",
	"subprocess-opencode",
]);

const VALID_AUTH = new Set<string>(["api-key", "oauth", "aws-sdk", "vertex-adc", "cli", "none"]);
const VALID_KINDS = new Set<string>(["http", "subprocess", "sdk"]);
const VALID_TIERS = new Set<string>([
	"protocol",
	"cloud",
	"local-native",
	"sdk",
	"cli",
	"cli-gold",
	"cli-silver",
	"cli-bronze",
]);

function describeDescriptor(desc: RuntimeDescriptor): string {
	return `${desc.id} (${desc.kind}/${desc.apiFamily})`;
}

describe("providers/runtimes built-in descriptors", () => {
	it("there is at least one descriptor", () => {
		ok(BUILTIN_RUNTIMES.length > 0, "BUILTIN_RUNTIMES must not be empty");
	});

	it("every descriptor has unique id + required shape", () => {
		const seen = new Set<string>();
		for (const desc of BUILTIN_RUNTIMES) {
			const label = describeDescriptor(desc);
			strictEqual(typeof desc.id, "string", `${label}: id must be a string`);
			ok(desc.id.length > 0, `${label}: id must be non-empty`);
			ok(!seen.has(desc.id), `${label}: duplicate id`);
			seen.add(desc.id);

			strictEqual(typeof desc.displayName, "string", `${label}: displayName must be a string`);
			ok(desc.displayName.length > 0, `${label}: displayName must be non-empty`);

			ok(VALID_KINDS.has(desc.kind), `${label}: invalid kind '${desc.kind}'`);
			ok(desc.tier !== undefined && VALID_TIERS.has(desc.tier), `${label}: invalid tier '${String(desc.tier)}'`);
			ok(VALID_API_FAMILIES.has(desc.apiFamily), `${label}: invalid apiFamily '${desc.apiFamily}'`);
			ok(VALID_AUTH.has(desc.auth), `${label}: invalid auth '${desc.auth}'`);

			ok(
				desc.defaultCapabilities !== null && typeof desc.defaultCapabilities === "object",
				`${label}: defaultCapabilities must be an object`,
			);
			const caps = desc.defaultCapabilities;
			strictEqual(typeof caps.chat, "boolean", `${label}: defaultCapabilities.chat must be boolean`);
			strictEqual(typeof caps.tools, "boolean", `${label}: defaultCapabilities.tools must be boolean`);
			strictEqual(typeof caps.contextWindow, "number", `${label}: defaultCapabilities.contextWindow must be a number`);
			strictEqual(typeof caps.maxTokens, "number", `${label}: defaultCapabilities.maxTokens must be a number`);

			strictEqual(typeof desc.synthesizeModel, "function", `${label}: synthesizeModel must be a function`);
			if (desc.probe !== undefined) {
				strictEqual(typeof desc.probe, "function", `${label}: probe must be a function when set`);
			}
			if (desc.probeModels !== undefined) {
				strictEqual(typeof desc.probeModels, "function", `${label}: probeModels must be a function when set`);
			}
		}
	});

	it("subprocess descriptors live under the subprocess-* apiFamily namespace", () => {
		for (const desc of BUILTIN_RUNTIMES) {
			if (desc.kind !== "subprocess") continue;
			ok(
				desc.apiFamily.startsWith("subprocess-"),
				`${describeDescriptor(desc)}: subprocess kind requires subprocess-* apiFamily`,
			);
		}
	});

	it("registers local CLI-backed targets with native CLI auth semantics", () => {
		const byId = new Map(BUILTIN_RUNTIMES.map((desc) => [desc.id, desc]));
		for (const id of ["claude-code-sdk", "claude-code-cli", "codex-cli", "gemini-cli", "copilot-cli", "opencode-cli"]) {
			const desc = byId.get(id);
			ok(desc, `missing runtime ${id}`);
			strictEqual(desc.auth, "cli", `${id}: expected native CLI auth`);
			ok(desc.knownModels && desc.knownModels.length > 0, `${id}: expected static model hints`);
		}
		strictEqual(byId.get("claude-code-sdk")?.tier, "sdk");
		strictEqual(byId.get("claude-code-cli")?.tier, "cli-gold");
		strictEqual(byId.get("codex-cli")?.tier, "cli-gold");
		strictEqual(byId.get("copilot-cli")?.tier, "cli-silver");
		strictEqual(byId.get("opencode-cli")?.tier, "cli-bronze");
		ok(byId.get("claude-code-sdk")?.knownModels?.includes("claude-opus-4-7"));
		ok(byId.get("copilot-cli")?.knownModels?.includes("claude-sonnet-4.6"));
		ok(!byId.get("copilot-cli")?.knownModels?.includes("claude-sonnet-4-6"));
		ok(byId.get("gemini-cli")?.knownModels?.includes("gemini-3-flash-preview"));
		ok(!byId.get("gemini-cli")?.knownModels?.includes("gemini-3.0-flash"));
	});

	it("openai-codex exposes gpt-5.4-mini through the engine model list", async () => {
		const { createEngineAi } = await import("../../../src/engine/ai.js");
		const engineAi = createEngineAi();
		const ids = engineAi.listModels("openai-codex").map((m) => m.id);
		ok(ids.includes("gpt-5.4-mini"), `expected gpt-5.4-mini in openai-codex models, got: ${ids.join(",")}`);
		ok(ids.includes("gpt-5.4"), `expected gpt-5.4 in openai-codex models, got: ${ids.join(",")}`);
		ok(ids.includes("gpt-5.5"), `expected gpt-5.5 in openai-codex models, got: ${ids.join(",")}`);
	});

	it("deepseek follows the pi-ai provider catalog", async () => {
		const byId = new Map(BUILTIN_RUNTIMES.map((desc) => [desc.id, desc]));
		const desc = byId.get("deepseek");
		ok(desc, "missing deepseek runtime");
		strictEqual(desc.auth, "api-key");
		strictEqual(desc.credentialsEnvVar, "DEEPSEEK_API_KEY");
		strictEqual(desc.apiFamily, "openai-completions");

		const { createEngineAi } = await import("../../../src/engine/ai.js");
		const engineAi = createEngineAi();
		const ids = engineAi.listModels("deepseek").map((m) => m.id);
		ok(ids.includes("deepseek-v4-flash"), `expected deepseek-v4-flash in deepseek models, got: ${ids.join(",")}`);
		ok(ids.includes("deepseek-v4-pro"), `expected deepseek-v4-pro in deepseek models, got: ${ids.join(",")}`);

		const model = desc.synthesizeModel({ id: "ds", runtime: "deepseek" }, "deepseek-v4-pro", null);
		strictEqual(model.provider, "deepseek");
		strictEqual(model.api, "openai-completions");
		strictEqual(model.baseUrl, "https://api.deepseek.com");
		strictEqual(model.reasoning, true);
		strictEqual(model.contextWindow, 1000000);
		strictEqual(model.maxTokens, 384000);
		strictEqual(model.cost.input, 1.74);
		strictEqual((model.compat as { thinkingFormat?: string } | undefined)?.thinkingFormat, "deepseek");

		const support = buildProviderSupportEntry(desc);
		strictEqual(support.group, "cloud-api");
		ok(support.modelHints.includes("deepseek-v4-pro"));
	});

	it("cloud runtime synthesis starts from pi-ai catalog metadata", () => {
		const byId = new Map(BUILTIN_RUNTIMES.map((desc) => [desc.id, desc]));

		const openai = byId.get("openai");
		ok(openai, "missing openai runtime");
		const gpt55 = openai.synthesizeModel({ id: "oa", runtime: "openai" }, "gpt-5.5", null);
		strictEqual(gpt55.baseUrl, "https://api.openai.com/v1");
		strictEqual(gpt55.reasoning, true);
		strictEqual(gpt55.maxTokens, 128000);
		strictEqual(gpt55.cost.output, 30);

		const groq = byId.get("groq");
		ok(groq, "missing groq runtime");
		const gptOss = groq.synthesizeModel({ id: "gq", runtime: "groq" }, "openai/gpt-oss-120b", null);
		strictEqual(gptOss.reasoning, true);
		strictEqual(gptOss.contextWindow, 131072);
		strictEqual(gptOss.maxTokens, 65536);
		strictEqual(gptOss.cost.input, 0.15);

		const mistral = byId.get("mistral");
		ok(mistral, "missing mistral runtime");
		const mistralLarge = mistral.synthesizeModel({ id: "mi", runtime: "mistral" }, "mistral-large-latest", null);
		strictEqual(mistralLarge.contextWindow, 262144);
		strictEqual(mistralLarge.maxTokens, 262144);
		ok(mistralLarge.input.includes("image"));
	});

	it("cloud runtime defaultBaseUrl falls back with the catalog path component", () => {
		const byId = new Map(BUILTIN_RUNTIMES.map((desc) => [desc.id, desc]));

		const openai = byId.get("openai");
		ok(openai, "missing openai runtime");
		const customOpenai = openai.synthesizeModel({ id: "oa-custom", runtime: "openai" }, "ft:gpt-x-custom", null);
		strictEqual(customOpenai.baseUrl, "https://api.openai.com/v1");

		const google = byId.get("google");
		ok(google, "missing google runtime");
		const customGoogle = google.synthesizeModel({ id: "g-custom", runtime: "google" }, "gemini-custom", null);
		strictEqual(customGoogle.baseUrl, "https://generativelanguage.googleapis.com/v1beta");
	});

	it("endpoint overrides still win over catalog-backed cloud synthesis", () => {
		const byId = new Map(BUILTIN_RUNTIMES.map((desc) => [desc.id, desc]));
		const openrouter = byId.get("openrouter");
		ok(openrouter, "missing openrouter runtime");

		const model = openrouter.synthesizeModel(
			{
				id: "or",
				runtime: "openrouter",
				url: "https://proxy.example.test/v1",
				auth: { headers: { "x-clio-test": "1" } },
				pricing: { input: 9, output: 8, cacheRead: 7, cacheWrite: 6 },
				capabilities: { vision: false, contextWindow: 123456, maxTokens: 789 },
			},
			"openai/gpt-5.4",
			null,
		);

		strictEqual(model.baseUrl, "https://proxy.example.test/v1");
		strictEqual(model.headers?.["x-clio-test"], "1");
		strictEqual(model.cost.input, 9);
		strictEqual(model.cost.output, 8);
		strictEqual(model.cost.cacheRead, 7);
		strictEqual(model.cost.cacheWrite, 6);
		strictEqual(model.contextWindow, 123456);
		strictEqual(model.maxTokens, 789);
		strictEqual(model.input.includes("image"), false);
	});

	it("openrouter synthesizes attribution headers and probes live model ids", async () => {
		const byId = new Map(BUILTIN_RUNTIMES.map((desc) => [desc.id, desc]));
		const openrouter = byId.get("openrouter");
		ok(openrouter, "missing openrouter runtime");
		strictEqual(openrouter.defaultCapabilities.thinkingFormat, "openrouter");

		const model = openrouter.synthesizeModel({ id: "or", runtime: "openrouter" }, "tencent/hy3-preview:free", null);
		strictEqual(model.headers?.["HTTP-Referer"], "https://github.com/iowarp/clio-coder");
		strictEqual(model.headers?.["X-OpenRouter-Title"], "Clio Coder");
		strictEqual(model.reasoning, true);
		strictEqual(model.contextWindow, 262144);
		strictEqual(model.maxTokens, 262144);

		const originalFetch = globalThis.fetch;
		const originalKey = process.env.OPENROUTER_API_KEY;
		let capturedUrl = "";
		let capturedAuthorization = "";
		globalThis.fetch = (async (input, init) => {
			capturedUrl = String(input);
			const headers = init?.headers as Record<string, string> | undefined;
			capturedAuthorization = headers?.authorization ?? "";
			return new Response(JSON.stringify({ data: [{ id: "tencent/hy3-preview:free" }] }), { status: 200 });
		}) as typeof fetch;
		process.env.OPENROUTER_API_KEY = "sk-or";
		try {
			const result = await openrouter.probe?.(
				{ id: "or", runtime: "openrouter", defaultModel: "tencent/hy3-preview:free" },
				{ credentialsPresent: new Set(["OPENROUTER_API_KEY"]), httpTimeoutMs: 1000 },
			);
			strictEqual(result?.ok, true);
			deepStrictEqual(result?.models, ["tencent/hy3-preview:free"]);
			strictEqual(capturedUrl, "https://openrouter.ai/api/v1/models");
			strictEqual(capturedAuthorization, "Bearer sk-or");
		} finally {
			globalThis.fetch = originalFetch;
			if (originalKey === undefined) Reflect.deleteProperty(process.env, "OPENROUTER_API_KEY");
			else process.env.OPENROUTER_API_KEY = originalKey;
		}
	});

	it("lmstudio-native discovers loaded model capabilities from /api/v0/models", async () => {
		const byId = new Map(BUILTIN_RUNTIMES.map((desc) => [desc.id, desc]));
		const runtime = byId.get("lmstudio-native");
		ok(runtime, "missing lmstudio-native runtime");

		type CreatePort = (namespace: string, name: string, backendInterface: unknown) => unknown;
		const proto = LMStudioClient.prototype as unknown as { createPort: CreatePort };
		const originalCreatePort = proto.createPort;
		const originalFetch = globalThis.fetch;
		let capturedUrl = "";
		proto.createPort = (namespace: string) => ({
			callRpc: async (method: string) => {
				if (namespace === "system" && method === "version") return { version: "0.3.30" };
				return undefined;
			},
		});
		globalThis.fetch = (async (input) => {
			capturedUrl = String(input);
			return new Response(
				JSON.stringify({
					data: [
						{
							id: "other-model",
							loaded_context_length: 8192,
							max_context_length: 131072,
							type: "llm",
							capabilities: [],
						},
						{
							id: "nemotron-omni",
							loaded_context_length: 262144,
							max_context_length: 1048576,
							type: "vlm",
							capabilities: ["tool_use"],
						},
					],
				}),
				{ status: 200 },
			);
		}) as typeof fetch;
		try {
			const endpoint = {
				id: "lm",
				runtime: "lmstudio-native",
				url: "http://127.0.0.1:1234",
				defaultModel: "nemotron-omni",
			};
			const result = await runtime.probe?.(endpoint, {
				credentialsPresent: new Set<string>(),
				httpTimeoutMs: 1000,
			});
			strictEqual(result?.ok, true);
			strictEqual(capturedUrl, "http://127.0.0.1:1234/api/v0/models");
			deepStrictEqual(result?.models, ["other-model", "nemotron-omni"]);
			deepStrictEqual(result?.discoveredCapabilities, {
				vision: true,
				tools: true,
				contextWindow: 262144,
			});

			const merged = mergeCapabilities(runtime.defaultCapabilities, null, result?.discoveredCapabilities ?? null, null);
			const model = runtime.synthesizeModel({ ...endpoint, capabilities: merged }, "nemotron-omni", null);
			strictEqual(model.contextWindow, 262144);
		} finally {
			proto.createPort = originalCreatePort;
			globalThis.fetch = originalFetch;
		}
	});
});
