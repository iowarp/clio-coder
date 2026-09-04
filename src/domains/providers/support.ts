import type { ClioSettings } from "../../core/config.js";
import { type AuthTarget, resolveAuthTarget, resolveRuntimeAuthTarget } from "./auth/index.js";
import { catalogProviderForRuntime, listCatalogModelsForRuntime } from "./catalog.js";
import { getRuntimeRegistry } from "./registry.js";
import type { RuntimeDescriptor } from "./types/runtime-descriptor.js";
import type { TargetDescriptor } from "./types/target-descriptor.js";

export type ProviderSupportGroup = "featured" | "external-worker" | "cloud-api" | "subscription" | "local-http";

/**
 * Where a runtime's model ids come from, which decides whether their order
 * means anything.
 *
 * `catalog` is the pi-ai provider data, keyed in name order: for openai the two
 * ASCII-first of 38 ids are `gpt-4` and `gpt-4-turbo`, so any prefix of it is
 * alphabetical accident rather than a recommendation. `runtime` is a
 * descriptor's own `knownModels`, which this repo curates and orders with
 * intent, so its head means something.
 */
export type RuntimeModelListSource = "runtime" | "catalog" | "none";

export interface ProviderSupportEntry {
	runtimeId: string;
	label: string;
	group: ProviderSupportGroup;
	summary: string;
	/** Absent when the ids are catalog-ordered, because then there is no default to recommend. */
	defaultModel?: string;
	modelHints: string[];
	modelSource: RuntimeModelListSource;
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
	alcf: "ALCF inference gateway (Sophia/Metis) via Globus",
	anthropic: "Anthropic API",
	"anthropic-max": "Claude Pro/Max subscription via Anthropic OAuth",
	"antigravity-code": "Experimental local delegation via the installed Antigravity CLI",
	bedrock: "Amazon Bedrock",
	"claude-code": "Claude Code subscription via installed claude CLI",
	"claude-sdk": "Claude Code subscription via Claude Agent SDK",
	deepseek: "DeepSeek API",
	google: "Google Gemini API",
	groq: "Groq API",
	mistral: "Mistral API",
	openai: "OpenAI Platform API",
	"openai-codex": "ChatGPT Plus/Pro via Codex OAuth",
	openrouter: "OpenRouter API",
	"ollama-native": "Ollama native API",
	lmstudio: "LM Studio chat over OpenAI-compatible REST with native REST model management",
	llamacpp: "llama.cpp server (auto-detect surface)",
	"anthropic-compat": "Generic Anthropic-compatible REST",
	"openai-compat": "Generic OpenAI-compatible REST",
	litellm: "LiteLLM gateway with per-route capability discovery and physical-model attribution",
};

function groupPriority(group: ProviderSupportGroup): number {
	switch (group) {
		case "featured":
			return 0;
		case "external-worker":
			return 1;
		case "subscription":
			return 2;
		case "cloud-api":
			return 3;
		case "local-http":
			return 4;
	}
}

export function supportGroupLabel(group: ProviderSupportGroup): string {
	switch (group) {
		case "featured":
			return "Featured";
		case "external-worker":
			return "External delegation";
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
	if (runtime.externalAgentLoop !== undefined) return "external-worker";
	if (runtime.id === "alcf") return "cloud-api";
	if (runtime.auth === "oauth" || runtime.auth === "claude-cli") return "subscription";
	if (catalogProviderForRuntime(runtime.id) || (runtime.auth === "api-key" && !runtime.probe)) {
		return "cloud-api";
	}
	return "local-http";
}

function knownModelsFor(runtimeId: string, runtime: RuntimeDescriptor | null): string[] {
	const catalogModels = listCatalogModelsForRuntime(runtimeId);
	if (catalogModels.length === 0) return runtime?.knownModels ? [...runtime.knownModels] : [];
	return catalogModels.map((model) => model.id);
}

export function listKnownModelsForRuntime(runtimeId: string): string[] {
	return knownModelsFor(runtimeId, getRuntimeIfRegistered(runtimeId));
}

function getRuntimeIfRegistered(runtimeId: string): RuntimeDescriptor | null {
	try {
		return getRuntimeRegistry().get(runtimeId);
	} catch {
		return null;
	}
}

/**
 * A descriptor that carries its own `knownModels` answers for its model story
 * even when the catalog also answers for it. `claude-code` and `claude-sdk` are
 * both: the catalog wins in `listKnownModelsForRuntime`, and they are left on
 * that path here rather than having their display and default changed by a
 * decision about openai. Which of the two lists should win for those runtimes
 * is a separate question.
 */
export function runtimeModelListSource(runtime: RuntimeDescriptor): RuntimeModelListSource {
	if (runtime.knownModels && runtime.knownModels.length > 0) return "runtime";
	if (listCatalogModelsForRuntime(runtime.id).length > 0) return "catalog";
	return "none";
}

function modelListSourceForRuntimeId(runtimeId: string): RuntimeModelListSource {
	const runtime = getRuntimeIfRegistered(runtimeId);
	if (runtime) return runtimeModelListSource(runtime);
	return listCatalogModelsForRuntime(runtimeId).length > 0 ? "catalog" : "none";
}

/**
 * The model id a caller may persist without being told which one to use.
 * Undefined for catalog-ordered runtimes: the head of that list is the
 * alphabetically first id, not the one anybody would choose.
 */
export function defaultModelForRuntime(runtimeId: string): string | undefined {
	if (modelListSourceForRuntimeId(runtimeId) === "catalog") return undefined;
	return listKnownModelsForRuntime(runtimeId)[0];
}

/**
 * What a screen may say about a runtime's models. A catalog-ordered list gets
 * its size and its source instead of a sample, so nothing false is asserted
 * about which ids matter.
 */
export function describeRuntimeModels(entry: ProviderSupportEntry, sample: number): string {
	if (entry.modelSource === "catalog") return `${entry.modelHints.length} in catalog`;
	if (entry.modelHints.length === 0) return "-";
	return entry.modelHints.slice(0, sample).join(", ");
}

export function buildProviderSupportEntry(runtime: RuntimeDescriptor): ProviderSupportEntry {
	// The descriptor in hand, not a registry lookup of its id: an entry built for
	// a runtime that is not in the global registry used to report no models at all.
	const modelHints = knownModelsFor(runtime.id, runtime);
	const modelSource = runtimeModelListSource(runtime);
	const defaultModel = modelSource === "catalog" ? undefined : modelHints[0];
	return {
		runtimeId: runtime.id,
		label: runtime.displayName,
		group: classifyGroup(runtime),
		summary: SUMMARY_BY_RUNTIME_ID[runtime.id] ?? runtime.displayName,
		...(defaultModel ? { defaultModel } : {}),
		modelHints,
		modelSource,
		featured: runtime.id === "openai-codex",
		connectable: runtime.auth === "oauth" || runtime.auth === "api-key",
		supportsCustomUrl:
			runtime.kind === "http" &&
			(classifyGroup(runtime) === "local-http" ||
				runtime.id === "openai-compat" ||
				runtime.id === "anthropic-compat" ||
				runtime.id === "alcf"),
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
	const canonical = getRuntimeIfRegistered(runtimeId)?.id ?? runtimeId;
	return settings.targets.filter(
		(target) => (getRuntimeIfRegistered(target.runtime)?.id ?? target.runtime) === canonical,
	);
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
