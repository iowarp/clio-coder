import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type Api, fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import { createEngineAi } from "../../src/engine/ai.js";
import { engineStreamSimple, getEngineApiProvider, registerEngineFauxProvider } from "../../src/engine/api-registry.js";
import { findEngineEnvKeys, getEngineEnvApiKey } from "../../src/engine/env-api-keys.js";

const KEY_CASES = [
	["github-copilot", "COPILOT_GITHUB_TOKEN"],
	["ant-ling", "ANT_LING_API_KEY"],
	["qwen-token-plan", "QWEN_TOKEN_PLAN_API_KEY"],
	["qwen-token-plan-cn", "QWEN_TOKEN_PLAN_CN_API_KEY"],
	["openai", "OPENAI_API_KEY"],
	["azure-openai-responses", "AZURE_OPENAI_API_KEY"],
	["nvidia", "NVIDIA_API_KEY"],
	["deepseek", "DEEPSEEK_API_KEY"],
	["google", "GEMINI_API_KEY"],
	["google-vertex", "GOOGLE_CLOUD_API_KEY"],
	["groq", "GROQ_API_KEY"],
	["cerebras", "CEREBRAS_API_KEY"],
	["xai", "XAI_API_KEY"],
	["radius", "RADIUS_API_KEY"],
	["openrouter", "OPENROUTER_API_KEY"],
	["vercel-ai-gateway", "AI_GATEWAY_API_KEY"],
	["zai", "ZAI_API_KEY"],
	["zai-coding-cn", "ZAI_CODING_CN_API_KEY"],
	["mistral", "MISTRAL_API_KEY"],
	["minimax", "MINIMAX_API_KEY"],
	["minimax-cn", "MINIMAX_CN_API_KEY"],
	["moonshotai", "MOONSHOT_API_KEY"],
	["moonshotai-cn", "MOONSHOT_API_KEY"],
	["huggingface", "HF_TOKEN"],
	["fireworks", "FIREWORKS_API_KEY"],
	["together", "TOGETHER_API_KEY"],
	["baseten", "BASETEN_API_KEY"],
	["opencode", "OPENCODE_API_KEY"],
	["opencode-go", "OPENCODE_API_KEY"],
	["kimi-coding", "KIMI_API_KEY"],
	["cloudflare-workers-ai", "CLOUDFLARE_API_KEY"],
	["cloudflare-ai-gateway", "CLOUDFLARE_API_KEY"],
	["xiaomi", "XIAOMI_API_KEY"],
	["xiaomi-token-plan-cn", "XIAOMI_TOKEN_PLAN_CN_API_KEY"],
	["xiaomi-token-plan-ams", "XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
	["xiaomi-token-plan-sgp", "XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
] as const;

const ALL_ENV_NAMES = new Set([
	...KEY_CASES.map((entry) => entry[1]),
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_OAUTH_TOKEN",
	"ANTHROPIC_API_KEY",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_PROJECT",
	"GCLOUD_PROJECT",
	"GOOGLE_CLOUD_LOCATION",
	"AWS_PROFILE",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
]);

describe("contracts/engine API registry", { concurrency: false }, () => {
	it("constructs only the provider families backed by Clio runtimes", () => {
		deepStrictEqual(createEngineAi().listProviders(), [
			"amazon-bedrock",
			"anthropic",
			"deepseek",
			"google",
			"groq",
			"mistral",
			"openai",
			"openai-codex",
			"openrouter",
		]);
	});

	it("preserves faux registration, streaming, and unregister semantics", async () => {
		const faux = registerEngineFauxProvider({
			api: "clio-contract-faux",
			provider: "clio-contract-faux",
			models: [{ id: "model" }],
		});
		faux.setResponses([fauxAssistantMessage("registry-ok")]);
		const response = await engineStreamSimple(faux.getModel(), { systemPrompt: "", messages: [] }).result();
		strictEqual(response.content[0]?.type, "text");
		if (response.content[0]?.type === "text") strictEqual(response.content[0].text, "registry-ok");
		faux.unregister();
		throws(
			() => engineStreamSimple(faux.getModel(), { systemPrompt: "", messages: [] }),
			/No API provider registered for api: clio-contract-faux/,
		);
	});

	it("keeps API mismatch validation synchronous", () => {
		const faux = registerEngineFauxProvider({ api: "clio-contract-match", provider: "match" });
		const provider = getEngineApiProvider("clio-contract-match");
		ok(provider);
		const wrong = { ...faux.getModel(), api: "different-api" } as Model<Api>;
		throws(() => provider.stream(wrong, { systemPrompt: "", messages: [] }), /Mismatched api/);
		faux.unregister();
	});

	it("matches pi-ai 0.84 environment-key discovery across every mapped provider", async () => {
		const saved = new Map<string, string | undefined>();
		for (const name of ALL_ENV_NAMES) {
			saved.set(name, process.env[name]);
			delete process.env[name];
		}
		const credentialsDir = mkdtempSync(join(tmpdir(), "clio-vertex-adc-"));
		const credentialsFile = join(credentialsDir, "adc.json");
		writeFileSync(credentialsFile, "{}\n", "utf8");
		try {
			const compat = await import("@earendil-works/pi-ai/compat");
			for (const [provider, name] of KEY_CASES) {
				const env = { [name]: `${provider}-secret` };
				deepStrictEqual(findEngineEnvKeys(provider, env), compat.findEnvKeys(provider, env), provider);
				strictEqual(getEngineEnvApiKey(provider, env), compat.getEnvApiKey(provider, env), provider);
			}
			for (const env of [
				{ ANTHROPIC_AUTH_TOKEN: "bearer-only" },
				{ ANTHROPIC_AUTH_TOKEN: "bearer", ANTHROPIC_OAUTH_TOKEN: "oauth" },
				{ ANTHROPIC_API_KEY: "api" },
			]) {
				deepStrictEqual(findEngineEnvKeys("anthropic", env), compat.findEnvKeys("anthropic", env));
				strictEqual(getEngineEnvApiKey("anthropic", env), compat.getEnvApiKey("anthropic", env));
			}
			const vertexEnv = {
				GOOGLE_APPLICATION_CREDENTIALS: credentialsFile,
				GOOGLE_CLOUD_PROJECT: "project",
				GOOGLE_CLOUD_LOCATION: "us-central1",
			};
			strictEqual(getEngineEnvApiKey("google-vertex", vertexEnv), compat.getEnvApiKey("google-vertex", vertexEnv));
			for (const env of [
				{ AWS_PROFILE: "science" },
				{ AWS_ACCESS_KEY_ID: "id", AWS_SECRET_ACCESS_KEY: "secret" },
				{ AWS_WEB_IDENTITY_TOKEN_FILE: "/does/not/need/to/exist" },
			]) {
				strictEqual(getEngineEnvApiKey("amazon-bedrock", env), compat.getEnvApiKey("amazon-bedrock", env));
			}
			strictEqual(getEngineEnvApiKey("unknown-provider", {}), compat.getEnvApiKey("unknown-provider", {}));
		} finally {
			rmSync(credentialsDir, { recursive: true, force: true });
			for (const [name, value] of saved) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});
});
