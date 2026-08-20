/**
 * Boot-only runtime metadata used before the providers domain is hydrated.
 *
 * Keep this module data-only. Importing full runtime descriptors here pulls
 * every probe, provider adapter, and completion implementation in front of the
 * first interactive frame. `builtin-runtime-boot-manifest.test.ts` compares
 * this projection with the canonical descriptors so the cheap copy cannot
 * silently drift.
 */

import type { RuntimeAuth, RuntimeKind, RuntimeTier } from "../types/runtime-descriptor.js";

export interface RuntimeBootMetadata {
	id: string;
	aliases?: ReadonlyArray<string>;
	kind: RuntimeKind;
	tier?: RuntimeTier;
	auth: RuntimeAuth;
	credentialsEnvVar?: string;
	oauthProviderId?: string;
}

export const BUILTIN_RUNTIME_BOOT_MANIFEST: ReadonlyArray<RuntimeBootMetadata> = [
	{ id: "alcf", kind: "http", tier: "cloud", auth: "oauth" },
	{ id: "anthropic", kind: "http", tier: "cloud", auth: "api-key", credentialsEnvVar: "ANTHROPIC_API_KEY" },
	{ id: "anthropic-max", kind: "http", tier: "cloud", auth: "oauth", oauthProviderId: "anthropic" },
	{ id: "bedrock", kind: "http", tier: "cloud", auth: "aws-sdk" },
	{ id: "deepseek", kind: "http", tier: "cloud", auth: "api-key", credentialsEnvVar: "DEEPSEEK_API_KEY" },
	{ id: "google", kind: "http", tier: "cloud", auth: "api-key", credentialsEnvVar: "GOOGLE_API_KEY" },
	{ id: "groq", kind: "http", tier: "cloud", auth: "api-key", credentialsEnvVar: "GROQ_API_KEY" },
	{ id: "mistral", kind: "http", tier: "cloud", auth: "api-key", credentialsEnvVar: "MISTRAL_API_KEY" },
	{ id: "openai", kind: "http", tier: "cloud", auth: "api-key", credentialsEnvVar: "OPENAI_API_KEY" },
	{ id: "openai-codex", kind: "http", tier: "cloud", auth: "oauth" },
	{ id: "openrouter", kind: "http", tier: "cloud", auth: "api-key", credentialsEnvVar: "OPENROUTER_API_KEY" },
	{ id: "lemonade-anthropic", kind: "http", tier: "local-native", auth: "api-key" },
	{ id: "lemonade", kind: "http", tier: "local-native", auth: "api-key" },
	{ id: "llamacpp", kind: "http", tier: "local-native", auth: "api-key" },
	{ id: "llamacpp-anthropic", kind: "http", tier: "local-native", auth: "api-key" },
	{ id: "llamacpp-completion", kind: "http", tier: "local-native", auth: "api-key" },
	{ id: "llamacpp-embed", kind: "http", tier: "local-native", auth: "api-key" },
	{ id: "llamacpp-rerank", kind: "http", tier: "local-native", auth: "api-key" },
	{ id: "lmstudio", aliases: ["lmstudio-native"], kind: "http", tier: "local-native", auth: "api-key" },
	{ id: "ollama-native", kind: "http", tier: "local-native", auth: "none" },
	{ id: "anthropic-compat", kind: "http", tier: "protocol", auth: "api-key" },
	{ id: "openai-compat", kind: "http", tier: "protocol", auth: "api-key" },
	{ id: "sglang", kind: "http", tier: "local-native", auth: "api-key" },
	{ id: "vllm", kind: "http", tier: "local-native", auth: "api-key" },
	{ id: "claude-code", kind: "subprocess", tier: "subscription", auth: "claude-cli" },
	{ id: "claude-sdk", kind: "sdk", tier: "subscription", auth: "claude-cli" },
	{ id: "antigravity-code", kind: "subprocess", tier: "subscription", auth: "none" },
];

export function findBuiltinRuntimeBootMetadata(id: string): RuntimeBootMetadata | null {
	return BUILTIN_RUNTIME_BOOT_MANIFEST.find((runtime) => runtime.id === id || runtime.aliases?.includes(id)) ?? null;
}
