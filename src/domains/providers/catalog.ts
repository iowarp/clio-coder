/**
 * Static catalog of providers Clio ships with. Consulted by the runtime layer
 * (P4S2) and the TUI (P4S8). Pure data + pure lookup helpers; no I/O.
 */

export type ProviderTier = "native" | "sdk" | "cli";

export type ProviderId =
	| "anthropic"
	| "openai"
	| "google"
	| "groq"
	| "mistral"
	| "openrouter"
	| "amazon-bedrock"
	| "llamacpp"
	| "lmstudio"
	| "ollama"
	| "openai-compat"
	| "local";

/**
 * IDs of inference engines that run locally. Every entry is also a ProviderId.
 * Endpoints for these providers are configured per-user in settings.yaml rather
 * than baked into the catalog.
 */
export const LOCAL_ENGINE_IDS = ["llamacpp", "lmstudio", "ollama", "openai-compat"] as const;
export type LocalEngineId = (typeof LOCAL_ENGINE_IDS)[number];

export function isLocalEngineId(id: string): id is LocalEngineId {
	return (LOCAL_ENGINE_IDS as ReadonlyArray<string>).includes(id);
}

export interface ModelSpec {
	id: string;
	contextWindow: number;
	thinkingCapable: boolean;
	pricePer1MInput?: number;
	pricePer1MOutput?: number;
}

export interface ProviderSpec {
	id: ProviderId;
	displayName: string;
	tier: ProviderTier;
	models: ReadonlyArray<ModelSpec>;
	credentialsEnvVar?: string;
}

export const PROVIDER_CATALOG: ReadonlyArray<ProviderSpec> = [
	{
		id: "anthropic",
		displayName: "Anthropic",
		tier: "sdk",
		credentialsEnvVar: "ANTHROPIC_API_KEY",
		models: [
			{
				id: "claude-sonnet-4-6",
				contextWindow: 200_000,
				thinkingCapable: true,
				pricePer1MInput: 3,
				pricePer1MOutput: 15,
			},
			{
				id: "claude-opus-4-7",
				contextWindow: 200_000,
				thinkingCapable: true,
				pricePer1MInput: 15,
				pricePer1MOutput: 75,
			},
			{
				id: "claude-haiku-4-5",
				contextWindow: 200_000,
				thinkingCapable: true,
				pricePer1MInput: 1,
				pricePer1MOutput: 5,
			},
		],
	},
	{
		id: "openai",
		displayName: "OpenAI",
		tier: "sdk",
		credentialsEnvVar: "OPENAI_API_KEY",
		models: [
			{ id: "gpt-5", contextWindow: 272_000, thinkingCapable: true, pricePer1MInput: 5, pricePer1MOutput: 20 },
			{ id: "gpt-4o", contextWindow: 128_000, thinkingCapable: false, pricePer1MInput: 2.5, pricePer1MOutput: 10 },
		],
	},
	{
		id: "google",
		displayName: "Google",
		tier: "sdk",
		credentialsEnvVar: "GOOGLE_API_KEY",
		models: [
			{
				id: "gemini-2.5-pro",
				contextWindow: 2_000_000,
				thinkingCapable: true,
				pricePer1MInput: 1.25,
				pricePer1MOutput: 10,
			},
			{
				id: "gemini-2.5-flash",
				contextWindow: 1_000_000,
				thinkingCapable: false,
				pricePer1MInput: 0.3,
				pricePer1MOutput: 2.5,
			},
		],
	},
	{
		id: "groq",
		displayName: "Groq",
		tier: "sdk",
		credentialsEnvVar: "GROQ_API_KEY",
		models: [
			{ id: "llama-4-scout", contextWindow: 64_000, thinkingCapable: false },
			{ id: "llama-4-maverick", contextWindow: 256_000, thinkingCapable: false },
		],
	},
	{
		id: "mistral",
		displayName: "Mistral",
		tier: "sdk",
		credentialsEnvVar: "MISTRAL_API_KEY",
		models: [
			{ id: "mistral-large-2", contextWindow: 128_000, thinkingCapable: false },
			{ id: "codestral-25.01", contextWindow: 256_000, thinkingCapable: false },
		],
	},
	{
		id: "openrouter",
		displayName: "OpenRouter",
		tier: "sdk",
		credentialsEnvVar: "OPENROUTER_API_KEY",
		models: [],
	},
	{
		id: "amazon-bedrock",
		displayName: "AWS Bedrock",
		tier: "sdk",
		models: [
			{ id: "anthropic.claude-sonnet-4-6", contextWindow: 200_000, thinkingCapable: true },
			{ id: "meta.llama-4-maverick", contextWindow: 256_000, thinkingCapable: false },
		],
	},
	{
		id: "llamacpp",
		displayName: "llama.cpp",
		tier: "native",
		models: [],
	},
	{
		id: "lmstudio",
		displayName: "LM Studio",
		tier: "native",
		models: [],
	},
	{
		id: "ollama",
		displayName: "Ollama",
		tier: "native",
		models: [],
	},
	{
		id: "openai-compat",
		displayName: "OpenAI-compatible",
		tier: "native",
		models: [],
	},
	{
		id: "local",
		displayName: "Local (deprecated alias)",
		tier: "native",
		models: [],
	},
];

export function getProviderSpec(id: ProviderId): ProviderSpec {
	const spec = PROVIDER_CATALOG.find((p) => p.id === id);
	if (!spec) throw new Error(`unknown provider id: ${id}`);
	return spec;
}

export function getModelSpec(providerId: ProviderId, modelId: string): ModelSpec | null {
	const spec = PROVIDER_CATALOG.find((p) => p.id === providerId);
	if (!spec) return null;
	return spec.models.find((m) => m.id === modelId) ?? null;
}
