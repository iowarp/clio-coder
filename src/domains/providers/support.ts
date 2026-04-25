import type { ClioSettings } from "../../core/config.js";
import { type AuthTarget, resolveAuthTarget, resolveRuntimeAuthTarget } from "./auth/index.js";
import { catalogProviderForRuntime, listCatalogModelsForRuntime } from "./catalog.js";
import { getRuntimeRegistry } from "./registry.js";
import type { EndpointDescriptor } from "./types/endpoint-descriptor.js";
import type { RuntimeDescriptor } from "./types/runtime-descriptor.js";

export type ProviderSupportGroup = "featured" | "cloud-api" | "subscription" | "local-http" | "cli-runtime";

export interface ProviderSupportEntry {
	runtimeId: string;
	label: string;
	group: ProviderSupportGroup;
	summary: string;
	defaultModel?: string;
	modelHints: string[];
	featured: boolean;
	connectable: boolean;
	supportsCustomUrl: boolean;
}

export interface ResolvedProviderReference {
	input: string;
	endpoint: EndpointDescriptor | null;
	runtime: RuntimeDescriptor;
	authTarget: AuthTarget;
}

const SUMMARY_BY_RUNTIME_ID: Readonly<Record<string, string>> = {
	anthropic: "Anthropic API",
	bedrock: "Amazon Bedrock",
	deepseek: "DeepSeek API",
	google: "Google Gemini API",
	groq: "Groq API",
	mistral: "Mistral API",
	openai: "OpenAI Platform API",
	"openai-codex": "ChatGPT Plus/Pro via Codex OAuth",
	openrouter: "OpenRouter API",
	"claude-code-sdk": "Claude Code Agent SDK",
	"claude-code-cli": "Claude Code CLI",
	"codex-cli": "Codex CLI",
	"gemini-cli": "Gemini CLI",
	"copilot-cli": "GitHub Copilot CLI",
	"opencode-cli": "OpenCode CLI",
	"ollama-native": "Ollama native API",
	"lmstudio-native": "LM Studio native API",
};

function groupPriority(group: ProviderSupportGroup): number {
	switch (group) {
		case "featured":
			return 0;
		case "subscription":
			return 1;
		case "cloud-api":
			return 2;
		case "local-http":
			return 3;
		case "cli-runtime":
			return 4;
	}
}

export function supportGroupLabel(group: ProviderSupportGroup): string {
	switch (group) {
		case "featured":
			return "Featured";
		case "subscription":
			return "Subscriptions";
		case "cloud-api":
			return "Cloud APIs";
		case "local-http":
			return "Local HTTP";
		case "cli-runtime":
			return "CLI runtimes";
	}
}

function classifyGroup(runtime: RuntimeDescriptor): ProviderSupportGroup {
	if (runtime.id === "openai-codex") return "featured";
	if (runtime.auth === "oauth") return "subscription";
	if (runtime.kind === "subprocess" || runtime.kind === "sdk") return "cli-runtime";
	if (catalogProviderForRuntime(runtime.id) || (runtime.auth === "api-key" && !runtime.probe)) {
		return "cloud-api";
	}
	return "local-http";
}

export function listKnownModelsForRuntime(runtimeId: string): string[] {
	const catalogModels = listCatalogModelsForRuntime(runtimeId);
	if (catalogModels.length === 0) {
		const runtime = getRuntimeIfRegistered(runtimeId);
		return runtime?.knownModels ? [...runtime.knownModels] : [];
	}
	return catalogModels.map((model) => model.id);
}

function getRuntimeIfRegistered(runtimeId: string): RuntimeDescriptor | null {
	try {
		return getRuntimeRegistry().get(runtimeId);
	} catch {
		return null;
	}
}

export function defaultModelForRuntime(runtimeId: string): string | undefined {
	return listKnownModelsForRuntime(runtimeId)[0];
}

export function buildProviderSupportEntry(runtime: RuntimeDescriptor): ProviderSupportEntry {
	const modelHints = listKnownModelsForRuntime(runtime.id);
	const defaultModel = defaultModelForRuntime(runtime.id);
	return {
		runtimeId: runtime.id,
		label: runtime.displayName,
		group: classifyGroup(runtime),
		summary: SUMMARY_BY_RUNTIME_ID[runtime.id] ?? runtime.displayName,
		...(defaultModel ? { defaultModel } : {}),
		modelHints,
		featured: runtime.id === "openai-codex",
		connectable: runtime.auth === "oauth" || runtime.auth === "api-key" || runtime.auth === "cli",
		supportsCustomUrl:
			runtime.kind === "http" && (classifyGroup(runtime) === "local-http" || runtime.id === "openai-compat"),
	};
}

export function compareProviderSupportEntries(a: ProviderSupportEntry, b: ProviderSupportEntry): number {
	return (
		groupPriority(a.group) - groupPriority(b.group) ||
		(a.featured === b.featured ? 0 : a.featured ? -1 : 1) ||
		a.label.localeCompare(b.label) ||
		a.runtimeId.localeCompare(b.runtimeId)
	);
}

export function listProviderSupportEntries(runtimes: ReadonlyArray<RuntimeDescriptor>): ProviderSupportEntry[] {
	return runtimes.map((runtime) => buildProviderSupportEntry(runtime)).sort(compareProviderSupportEntries);
}

export function configuredEndpointsForRuntime(
	settings: Readonly<ClioSettings>,
	runtimeId: string,
): ReadonlyArray<EndpointDescriptor> {
	return settings.endpoints.filter((endpoint) => endpoint.runtime === runtimeId);
}

export function resolveProviderReference(
	input: string,
	settings: Readonly<ClioSettings>,
	getRuntime: (runtimeId: string) => RuntimeDescriptor | null,
): ResolvedProviderReference | null {
	const trimmed = input.trim();
	if (trimmed.length === 0) return null;
	const endpoint = settings.endpoints.find((entry) => entry.id === trimmed) ?? null;
	if (endpoint) {
		const runtime = getRuntime(endpoint.runtime);
		if (!runtime) return null;
		return {
			input: trimmed,
			endpoint,
			runtime,
			authTarget: resolveAuthTarget(endpoint, runtime),
		};
	}
	const runtime = getRuntime(trimmed);
	if (!runtime) return null;
	return {
		input: trimmed,
		endpoint: null,
		runtime,
		authTarget: resolveRuntimeAuthTarget(runtime),
	};
}
