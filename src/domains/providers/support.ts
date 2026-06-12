import type { ClioSettings } from "../../core/config.js";
import { type AuthTarget, resolveAuthTarget, resolveRuntimeAuthTarget } from "./auth/index.js";
import { catalogProviderForRuntime, listCatalogModelsForRuntime } from "./catalog.js";
import { getRuntimeRegistry } from "./registry.js";
import type { RuntimeDescriptor } from "./types/runtime-descriptor.js";
import type { TargetDescriptor } from "./types/target-descriptor.js";

export type ProviderSupportGroup = "featured" | "cloud-api" | "subscription" | "local-http";

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
	target: TargetDescriptor | null;
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
	"ollama-native": "Ollama native API",
	"lmstudio-native": "LM Studio SDK + native model management",
	llamacpp: "llama.cpp server (auto-detect surface)",
	"anthropic-compat": "Generic Anthropic-compatible REST",
	"openai-compat": "Generic OpenAI-compatible REST",
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
	}
}

function classifyGroup(runtime: RuntimeDescriptor): ProviderSupportGroup {
	if (runtime.id === "openai-codex") return "featured";
	if (runtime.auth === "oauth") return "subscription";
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
		connectable: runtime.auth === "oauth" || runtime.auth === "api-key",
		supportsCustomUrl:
			runtime.kind === "http" &&
			(classifyGroup(runtime) === "local-http" || runtime.id === "openai-compat" || runtime.id === "anthropic-compat"),
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

export interface ListProviderSupportOptions {
	includeHidden?: boolean;
}

export function listProviderSupportEntries(
	runtimes: ReadonlyArray<RuntimeDescriptor>,
	options: ListProviderSupportOptions = {},
): ProviderSupportEntry[] {
	const filtered = options.includeHidden ? runtimes : runtimes.filter((runtime) => runtime.hidden !== true);
	return filtered.map((runtime) => buildProviderSupportEntry(runtime)).sort(compareProviderSupportEntries);
}

export function configuredTargetsForRuntime(
	settings: Readonly<ClioSettings>,
	runtimeId: string,
): ReadonlyArray<TargetDescriptor> {
	return settings.targets.filter((target) => target.runtime === runtimeId);
}

export function resolveProviderReference(
	input: string,
	settings: Readonly<ClioSettings>,
	getRuntime: (runtimeId: string) => RuntimeDescriptor | null,
): ResolvedProviderReference | null {
	const trimmed = input.trim();
	if (trimmed.length === 0) return null;
	const target = settings.targets.find((entry) => entry.id === trimmed) ?? null;
	if (target) {
		const runtime = getRuntime(target.runtime);
		if (!runtime) return null;
		return {
			input: trimmed,
			target,
			runtime,
			authTarget: resolveAuthTarget(target, runtime),
		};
	}
	const runtime = getRuntime(trimmed);
	if (!runtime) return null;
	return {
		input: trimmed,
		target: null,
		runtime,
		authTarget: resolveRuntimeAuthTarget(runtime),
	};
}
