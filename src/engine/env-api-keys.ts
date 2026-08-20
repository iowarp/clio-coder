import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ProviderEnv } from "@earendil-works/pi-ai";

export const ANTHROPIC_AUTH_TOKEN_ENV = "ANTHROPIC_AUTH_TOKEN";
export const ANTHROPIC_OAUTH_TOKEN_ENV = "ANTHROPIC_OAUTH_TOKEN";
export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";

const ENV_KEYS: Readonly<Record<string, string>> = {
	"ant-ling": "ANT_LING_API_KEY",
	"qwen-token-plan": "QWEN_TOKEN_PLAN_API_KEY",
	"qwen-token-plan-cn": "QWEN_TOKEN_PLAN_CN_API_KEY",
	openai: "OPENAI_API_KEY",
	"azure-openai-responses": "AZURE_OPENAI_API_KEY",
	nvidia: "NVIDIA_API_KEY",
	deepseek: "DEEPSEEK_API_KEY",
	google: "GEMINI_API_KEY",
	"google-vertex": "GOOGLE_CLOUD_API_KEY",
	groq: "GROQ_API_KEY",
	cerebras: "CEREBRAS_API_KEY",
	xai: "XAI_API_KEY",
	radius: "RADIUS_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	"vercel-ai-gateway": "AI_GATEWAY_API_KEY",
	zai: "ZAI_API_KEY",
	"zai-coding-cn": "ZAI_CODING_CN_API_KEY",
	mistral: "MISTRAL_API_KEY",
	minimax: "MINIMAX_API_KEY",
	"minimax-cn": "MINIMAX_CN_API_KEY",
	moonshotai: "MOONSHOT_API_KEY",
	"moonshotai-cn": "MOONSHOT_API_KEY",
	huggingface: "HF_TOKEN",
	fireworks: "FIREWORKS_API_KEY",
	together: "TOGETHER_API_KEY",
	baseten: "BASETEN_API_KEY",
	opencode: "OPENCODE_API_KEY",
	"opencode-go": "OPENCODE_API_KEY",
	"kimi-coding": "KIMI_API_KEY",
	"cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
	"cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
	xiaomi: "XIAOMI_API_KEY",
	"xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
	"xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
	"xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
};

function envValue(name: string, env?: ProviderEnv): string | undefined {
	return env?.[name] || process.env[name] || undefined;
}

function apiKeyEnvVars(provider: string): readonly string[] | undefined {
	if (provider === "github-copilot") return ["COPILOT_GITHUB_TOKEN"];
	if (provider === "anthropic") {
		return [ANTHROPIC_AUTH_TOKEN_ENV, ANTHROPIC_OAUTH_TOKEN_ENV, ANTHROPIC_API_KEY_ENV];
	}
	const name = ENV_KEYS[provider];
	return name ? [name] : undefined;
}

/** Synchronous provider-key discovery pinned to pi-ai 0.84's public behavior. */
export function findEngineEnvKeys(provider: string, env?: ProviderEnv): string[] | undefined {
	const names = apiKeyEnvVars(provider);
	if (!names) return undefined;
	const found = names.filter((name) => !!envValue(name, env));
	return found.length > 0 ? found : undefined;
}

/** Resolve API-key and ambient-auth markers without importing pi-ai/compat. */
export function getEngineEnvApiKey(provider: string, env?: ProviderEnv): string | undefined {
	const keys = findEngineEnvKeys(provider, env);
	if (keys?.[0]) {
		const name = provider === "anthropic" ? keys.find((key) => key !== ANTHROPIC_AUTH_TOKEN_ENV) : keys[0];
		if (name) return envValue(name, env);
	}
	if (provider === "google-vertex") {
		const credentialsPath = envValue("GOOGLE_APPLICATION_CREDENTIALS", env);
		const hasCredentials = credentialsPath
			? existsSync(credentialsPath)
			: existsSync(join(homedir(), ".config", "gcloud", "application_default_credentials.json"));
		const hasProject = !!(envValue("GOOGLE_CLOUD_PROJECT", env) || envValue("GCLOUD_PROJECT", env));
		const hasLocation = !!envValue("GOOGLE_CLOUD_LOCATION", env);
		if (hasCredentials && hasProject && hasLocation) return "<authenticated>";
	}
	if (
		provider === "amazon-bedrock" &&
		(envValue("AWS_PROFILE", env) ||
			(envValue("AWS_ACCESS_KEY_ID", env) && envValue("AWS_SECRET_ACCESS_KEY", env)) ||
			envValue("AWS_BEARER_TOKEN_BEDROCK", env) ||
			envValue("AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", env) ||
			envValue("AWS_CONTAINER_CREDENTIALS_FULL_URI", env) ||
			envValue("AWS_WEB_IDENTITY_TOKEN_FILE", env))
	) {
		return "<authenticated>";
	}
	return undefined;
}
