/**
 * Low-level settings read/write. The config domain wraps this module with watcher,
 * hot-reload, and event emission. Kept in core/ because multiple domains (providers,
 * modes, prompts) need settings access before the domain loader has finished booting.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { DEFAULT_SETTINGS } from "./defaults.js";
import { clioConfigDir } from "./xdg.js";

export type ClioSettings = typeof DEFAULT_SETTINGS;

type SerializedSettings = Omit<ClioSettings, "endpoints" | "orchestrator" | "workers"> & {
	targets: ClioSettings["endpoints"];
	orchestrator: Omit<ClioSettings["orchestrator"], "endpoint"> & { target: string | null };
	workers: {
		default: Omit<ClioSettings["workers"]["default"], "endpoint"> & { target: string | null };
		profiles: Record<string, Omit<ClioSettings["workers"]["default"], "endpoint"> & { target: string | null }>;
	};
};

export function settingsPath(): string {
	return join(clioConfigDir(), "settings.yaml");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
	return structuredClone(value);
}

function trimString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function trimStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const entry of value) {
		const trimmed = trimString(entry);
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

function trimStringRecord(value: unknown): Record<string, string> | undefined {
	if (!isPlainObject(value)) return undefined;
	const out: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value)) {
		const nextKey = trimString(key);
		const nextValue = trimString(raw);
		if (!nextKey || !nextValue) continue;
		out[nextKey] = nextValue;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function firstTrimmed(...values: ReadonlyArray<unknown>): string | undefined {
	for (const value of values) {
		const trimmed = trimString(value);
		if (trimmed) return trimmed;
	}
	return undefined;
}

function isToolCallFormat(
	value: unknown,
): value is NonNullable<ClioSettings["endpoints"][number]["capabilities"]>["toolCallFormat"] {
	return (
		value === "openai" ||
		value === "anthropic" ||
		value === "hermes" ||
		value === "llama3-json" ||
		value === "mistral" ||
		value === "qwen" ||
		value === "xml"
	);
}

function isThinkingFormat(
	value: unknown,
): value is NonNullable<ClioSettings["endpoints"][number]["capabilities"]>["thinkingFormat"] {
	return (
		value === "qwen-chat-template" ||
		value === "openrouter" ||
		value === "zai" ||
		value === "anthropic-extended" ||
		value === "deepseek-r1" ||
		value === "openai-codex"
	);
}

function isStructuredOutputs(
	value: unknown,
): value is NonNullable<ClioSettings["endpoints"][number]["capabilities"]>["structuredOutputs"] {
	return value === "json-schema" || value === "gbnf" || value === "xgrammar" || value === "none";
}

export function mergeSettings<T>(defaults: T, overrides: unknown): T {
	if (overrides === undefined) return cloneValue(defaults);
	if (Array.isArray(defaults)) {
		return Array.isArray(overrides) ? cloneValue(overrides as T) : cloneValue(defaults);
	}
	if (isPlainObject(defaults) && isPlainObject(overrides)) {
		const next = cloneValue(defaults) as Record<string, unknown>;
		for (const [key, overrideValue] of Object.entries(overrides)) {
			if (!(key in next)) {
				next[key] = cloneValue(overrideValue);
				continue;
			}
			next[key] = mergeSettings(next[key], overrideValue);
		}
		return next as T;
	}
	return cloneValue(overrides as T);
}

function normalizeEndpointCapabilities(value: unknown): ClioSettings["endpoints"][number]["capabilities"] | undefined {
	if (!isPlainObject(value)) return undefined;
	const out: NonNullable<ClioSettings["endpoints"][number]["capabilities"]> = {};
	if (typeof value.chat === "boolean") out.chat = value.chat;
	if (typeof value.tools === "boolean") out.tools = value.tools;
	const toolCallFormat = value.toolCallFormat;
	if (isToolCallFormat(toolCallFormat)) {
		out.toolCallFormat = toolCallFormat as NonNullable<typeof out.toolCallFormat>;
	}
	if (typeof value.reasoning === "boolean") out.reasoning = value.reasoning;
	const thinkingFormat = value.thinkingFormat;
	if (isThinkingFormat(thinkingFormat)) {
		out.thinkingFormat = thinkingFormat as NonNullable<typeof out.thinkingFormat>;
	}
	const structuredOutputs = value.structuredOutputs;
	if (isStructuredOutputs(structuredOutputs)) {
		out.structuredOutputs = structuredOutputs as NonNullable<typeof out.structuredOutputs>;
	}
	if (typeof value.vision === "boolean") out.vision = value.vision;
	if (typeof value.audio === "boolean") out.audio = value.audio;
	if (typeof value.embeddings === "boolean") out.embeddings = value.embeddings;
	if (typeof value.rerank === "boolean") out.rerank = value.rerank;
	if (typeof value.fim === "boolean") out.fim = value.fim;
	if (typeof value.contextWindow === "number" && Number.isFinite(value.contextWindow) && value.contextWindow >= 0) {
		out.contextWindow = Math.floor(value.contextWindow);
	}
	if (typeof value.maxTokens === "number" && Number.isFinite(value.maxTokens) && value.maxTokens >= 0) {
		out.maxTokens = Math.floor(value.maxTokens);
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeEndpointPricing(value: unknown): ClioSettings["endpoints"][number]["pricing"] | undefined {
	if (!isPlainObject(value)) return undefined;
	if (
		typeof value.input !== "number" ||
		!Number.isFinite(value.input) ||
		value.input < 0 ||
		typeof value.output !== "number" ||
		!Number.isFinite(value.output) ||
		value.output < 0
	) {
		return undefined;
	}
	const out: NonNullable<ClioSettings["endpoints"][number]["pricing"]> = {
		input: value.input,
		output: value.output,
	};
	if (typeof value.cacheRead === "number" && Number.isFinite(value.cacheRead) && value.cacheRead >= 0) {
		out.cacheRead = value.cacheRead;
	}
	if (typeof value.cacheWrite === "number" && Number.isFinite(value.cacheWrite) && value.cacheWrite >= 0) {
		out.cacheWrite = value.cacheWrite;
	}
	return out;
}

function normalizeEndpointAuth(value: unknown): ClioSettings["endpoints"][number]["auth"] | undefined {
	if (!isPlainObject(value)) return undefined;
	const out: NonNullable<ClioSettings["endpoints"][number]["auth"]> = {};
	const apiKeyEnvVar = trimString(value.apiKeyEnvVar);
	const apiKeyRef = trimString(value.apiKeyRef);
	const oauthProfile = trimString(value.oauthProfile);
	const headers = trimStringRecord(value.headers);
	if (apiKeyEnvVar) out.apiKeyEnvVar = apiKeyEnvVar;
	if (apiKeyRef) out.apiKeyRef = apiKeyRef;
	if (oauthProfile) out.oauthProfile = oauthProfile;
	if (headers) out.headers = headers;
	return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeLegacyEndpointAuth(
	endpointValue: unknown,
	providerValue?: unknown,
): ClioSettings["endpoints"][number]["auth"] | undefined {
	const sources = [endpointValue, providerValue].filter(isPlainObject);
	if (sources.length === 0) return undefined;
	const nestedAuth = sources
		.map((source) => normalizeEndpointAuth(source.auth))
		.find((auth): auth is NonNullable<typeof auth> => auth !== undefined);
	const out: NonNullable<ClioSettings["endpoints"][number]["auth"]> = nestedAuth ? { ...nestedAuth } : {};
	for (const source of sources) {
		const apiKeyEnvVar = firstTrimmed(source.apiKeyEnvVar, source.api_key_env_var, source.api_key_env, source.apiKeyEnv);
		const apiKeyRef = firstTrimmed(source.apiKeyRef, source.api_key_ref);
		const oauthProfile = firstTrimmed(source.oauthProfile, source.oauth_profile);
		const headers = trimStringRecord(source.headers);
		if (apiKeyEnvVar && !out.apiKeyEnvVar) out.apiKeyEnvVar = apiKeyEnvVar;
		if (apiKeyRef && !out.apiKeyRef) out.apiKeyRef = apiKeyRef;
		if (oauthProfile && !out.oauthProfile) out.oauthProfile = oauthProfile;
		if (headers && !out.headers) out.headers = headers;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeEndpoint(value: unknown): ClioSettings["endpoints"][number] | null {
	if (!isPlainObject(value)) return null;
	const id = trimString(value.id);
	const runtime = trimString(value.runtime);
	if (!id || !runtime) return null;
	const endpoint: ClioSettings["endpoints"][number] = { id, runtime };
	const url = trimString(value.url);
	const auth = normalizeEndpointAuth(value.auth);
	const wireModels = trimStringArray(value.wireModels);
	const defaultModel = trimString(value.defaultModel) ?? wireModels[0];
	const capabilities = normalizeEndpointCapabilities(value.capabilities);
	const pricing = normalizeEndpointPricing(value.pricing);
	if (url) endpoint.url = url;
	if (auth) endpoint.auth = auth;
	if (defaultModel) endpoint.defaultModel = defaultModel;
	if (wireModels.length > 0) endpoint.wireModels = wireModels;
	if (capabilities) endpoint.capabilities = capabilities;
	if (value.lifecycle === "user-managed" || value.lifecycle === "clio-managed") endpoint.lifecycle = value.lifecycle;
	if (typeof value.gateway === "boolean") endpoint.gateway = value.gateway;
	if (pricing) endpoint.pricing = pricing;
	return endpoint;
}

interface LegacyEndpointContext {
	endpoints: ClioSettings["endpoints"];
	pairToEndpointId: Map<string, string>;
}

function normalizeLegacyProviders(value: unknown): LegacyEndpointContext {
	if (!isPlainObject(value)) {
		return { endpoints: [], pairToEndpointId: new Map() };
	}
	const legacyEntries: Array<{
		runtimeId: string;
		legacyEndpointId: string;
		endpointValue: Record<string, unknown>;
		providerValue: Record<string, unknown>;
	}> = [];
	for (const [providerKey, providerValue] of Object.entries(value)) {
		const runtimeId = trimString(providerKey);
		if (!runtimeId || !isPlainObject(providerValue) || !isPlainObject(providerValue.endpoints)) continue;
		for (const [endpointKey, endpointValue] of Object.entries(providerValue.endpoints)) {
			const legacyEndpointId = trimString(endpointKey);
			if (!legacyEndpointId || !isPlainObject(endpointValue)) continue;
			legacyEntries.push({ runtimeId, legacyEndpointId, endpointValue, providerValue });
		}
	}
	const nameCounts = new Map<string, number>();
	for (const entry of legacyEntries) {
		nameCounts.set(entry.legacyEndpointId, (nameCounts.get(entry.legacyEndpointId) ?? 0) + 1);
	}
	const endpoints: ClioSettings["endpoints"] = [];
	const pairToEndpointId = new Map<string, string>();
	for (const entry of legacyEntries) {
		const endpointId =
			(nameCounts.get(entry.legacyEndpointId) ?? 0) <= 1
				? entry.legacyEndpointId
				: `${entry.runtimeId}-${entry.legacyEndpointId}`;
		const endpoint: ClioSettings["endpoints"][number] = {
			id: endpointId,
			runtime: entry.runtimeId,
		};
		const url = firstTrimmed(entry.endpointValue.url, entry.endpointValue.baseUrl, entry.endpointValue.base_url);
		const wireModels = trimStringArray(entry.endpointValue.wireModels ?? entry.endpointValue.wire_models);
		const defaultModel =
			firstTrimmed(entry.endpointValue.defaultModel, entry.endpointValue.default_model) ?? wireModels[0];
		const auth = normalizeLegacyEndpointAuth(entry.endpointValue, entry.providerValue);
		const capabilities = normalizeEndpointCapabilities(entry.endpointValue.capabilities);
		if (url) endpoint.url = url;
		if (defaultModel) endpoint.defaultModel = defaultModel;
		if (wireModels.length > 0) endpoint.wireModels = wireModels;
		if (auth) endpoint.auth = auth;
		if (capabilities) endpoint.capabilities = capabilities;
		if (entry.endpointValue.lifecycle === "user-managed" || entry.endpointValue.lifecycle === "clio-managed") {
			endpoint.lifecycle = entry.endpointValue.lifecycle;
		}
		if (typeof entry.endpointValue.gateway === "boolean") endpoint.gateway = entry.endpointValue.gateway;
		endpoints.push(endpoint);
		pairToEndpointId.set(`${entry.runtimeId}:${entry.legacyEndpointId}`, endpointId);
	}
	return { endpoints, pairToEndpointId };
}

function resolveLegacyEndpointId(
	endpoints: ReadonlyArray<ClioSettings["endpoints"][number]>,
	pairToEndpointId: ReadonlyMap<string, string>,
	providerId: unknown,
	legacyEndpointId: unknown,
): string | null {
	const runtimeId = trimString(providerId);
	const endpointName = trimString(legacyEndpointId);
	if (runtimeId && endpointName) {
		const fromPair = pairToEndpointId.get(`${runtimeId}:${endpointName}`);
		if (fromPair) return fromPair;
		const exact = endpoints.find((entry) => entry.runtime === runtimeId && entry.id === endpointName);
		if (exact) return exact.id;
		const matchingEndpointIds = endpoints.filter((entry) => entry.id === endpointName).map((entry) => entry.id);
		if (matchingEndpointIds.length === 1) return matchingEndpointIds[0] ?? null;
		return null;
	}
	if (endpointName) {
		const matchingEndpointIds = endpoints.filter((entry) => entry.id === endpointName).map((entry) => entry.id);
		if (matchingEndpointIds.length === 1) return matchingEndpointIds[0] ?? null;
	}
	if (runtimeId) {
		const runtimeEndpoints = endpoints.filter((entry) => entry.runtime === runtimeId);
		if (runtimeEndpoints.length === 1) return runtimeEndpoints[0]?.id ?? null;
	}
	return null;
}

function normalizeLegacyWorkerTarget(
	value: unknown,
	defaults: ClioSettings["orchestrator"],
	endpoints: ReadonlyArray<ClioSettings["endpoints"][number]>,
	pairToEndpointId: ReadonlyMap<string, string>,
): ClioSettings["orchestrator"] | null {
	if (!isPlainObject(value)) return null;
	const endpointId = resolveLegacyEndpointId(endpoints, pairToEndpointId, value.provider, value.endpoint);
	if (!endpointId) return null;
	const out = cloneValue(defaults);
	const endpoint = endpoints.find((entry) => entry.id === endpointId);
	out.endpoint = endpointId;
	out.thinkingLevel = normalizeThinkingLevel(value.thinkingLevel, defaults.thinkingLevel);
	out.model = trimString(value.model) ?? endpoint?.defaultModel ?? null;
	return out;
}

function normalizeLegacyProviderTarget(
	value: unknown,
	defaults: ClioSettings["orchestrator"],
	endpoints: ReadonlyArray<ClioSettings["endpoints"][number]>,
): ClioSettings["orchestrator"] | null {
	if (!isPlainObject(value)) return null;
	const runtimeId = trimString(value.active);
	if (!runtimeId) return null;
	const runtimeEndpoints = endpoints.filter((entry) => entry.runtime === runtimeId);
	if (runtimeEndpoints.length !== 1) return null;
	const endpoint = runtimeEndpoints[0];
	if (!endpoint) return null;
	const out = cloneValue(defaults);
	out.endpoint = endpoint.id;
	out.model = trimString(value.model) ?? endpoint.defaultModel ?? null;
	return out;
}

function normalizeThinkingLevel(
	value: unknown,
	fallback: ClioSettings["orchestrator"]["thinkingLevel"],
): ClioSettings["orchestrator"]["thinkingLevel"] {
	return value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh"
		? value
		: fallback;
}

function normalizeWorkerTarget(
	value: unknown,
	defaults: ClioSettings["orchestrator"],
	endpoints: ReadonlyArray<ClioSettings["endpoints"][number]>,
): ClioSettings["orchestrator"] {
	const out = cloneValue(defaults);
	if (!isPlainObject(value)) return out;
	const endpoint = trimString(value.target) ?? trimString(value.endpoint);
	const endpointExists = endpoint ? endpoints.find((entry) => entry.id === endpoint) : undefined;
	out.endpoint = endpointExists?.id ?? null;
	out.thinkingLevel = normalizeThinkingLevel(value.thinkingLevel, defaults.thinkingLevel);
	const model = trimString(value.model);
	out.model = out.endpoint ? (model ?? endpointExists?.defaultModel ?? null) : null;
	return out;
}

function normalizeWorkerProfiles(
	value: unknown,
	defaults: ClioSettings["workers"]["default"],
	endpoints: ReadonlyArray<ClioSettings["endpoints"][number]>,
): ClioSettings["workers"]["profiles"] {
	if (!isPlainObject(value)) return {};
	const out: ClioSettings["workers"]["profiles"] = {};
	for (const [rawName, rawProfile] of Object.entries(value)) {
		const name = trimString(rawName);
		if (!name) continue;
		const profile = normalizeWorkerTarget(rawProfile, defaults, endpoints);
		if (!profile.endpoint) continue;
		out[name] = {
			endpoint: profile.endpoint,
			model: profile.model,
			thinkingLevel: profile.thinkingLevel,
		};
	}
	return out;
}

function normalizeScope(
	value: unknown,
	endpoints: ReadonlyArray<ClioSettings["endpoints"][number]>,
): ClioSettings["scope"] {
	const byId = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint] as const));
	const seen = new Set<string>();
	const out: string[] = [];
	if (!Array.isArray(value)) return out;
	for (const entry of value) {
		const trimmed = trimString(entry);
		if (!trimmed) continue;
		const [endpointId, ...rest] = trimmed.split("/");
		if (!endpointId || !byId.has(endpointId)) continue;
		const normalized = rest.length === 0 ? endpointId : `${endpointId}/${rest.join("/")}`;
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
	}
	return out;
}

function normalizeLegacyScope(
	value: unknown,
	endpoints: ReadonlyArray<ClioSettings["endpoints"][number]>,
	pairToEndpointId: ReadonlyMap<string, string>,
): ClioSettings["scope"] {
	const byId = new Map(endpoints.map((endpoint) => [endpoint.id, endpoint] as const));
	const seen = new Set<string>();
	const out: string[] = [];
	if (!Array.isArray(value)) return out;
	for (const entry of value) {
		const trimmed = trimString(entry);
		if (!trimmed) continue;
		if (byId.has(trimmed)) {
			if (!seen.has(trimmed)) {
				seen.add(trimmed);
				out.push(trimmed);
			}
			continue;
		}
		const parts = trimmed.split("/");
		const [head, second, ...rest] = parts;
		if (!head) continue;
		let mapped: string | null = null;
		if (second) {
			mapped = resolveLegacyEndpointId(endpoints, pairToEndpointId, head, second);
			if (mapped) {
				const suffix = rest.length > 0 ? `/${rest.join("/")}` : "";
				const normalized = `${mapped}${suffix}`;
				if (!seen.has(normalized)) {
					seen.add(normalized);
					out.push(normalized);
				}
			} else {
				mapped = resolveLegacyEndpointId(endpoints, pairToEndpointId, head, undefined);
				if (mapped) {
					const normalized = `${mapped}/${[second, ...rest].join("/")}`;
					if (!seen.has(normalized)) {
						seen.add(normalized);
						out.push(normalized);
					}
				}
			}
		} else {
			mapped = resolveLegacyEndpointId(endpoints, pairToEndpointId, head, undefined);
			if (mapped && !seen.has(mapped)) {
				seen.add(mapped);
				out.push(mapped);
			}
		}
	}
	return out;
}

export function normalizeSettings(raw: unknown): ClioSettings {
	const settings = cloneValue(DEFAULT_SETTINGS);
	if (!isPlainObject(raw)) return settings;

	const identity = trimString(raw.identity);
	if (identity) settings.identity = identity;
	if (raw.defaultMode === "default" || raw.defaultMode === "advise" || raw.defaultMode === "super") {
		settings.defaultMode = raw.defaultMode;
	}
	if (raw.safetyLevel === "suggest" || raw.safetyLevel === "auto-edit" || raw.safetyLevel === "full-auto") {
		settings.safetyLevel = raw.safetyLevel;
	}

	const rawTargets = Array.isArray(raw.targets) ? raw.targets : Array.isArray(raw.endpoints) ? raw.endpoints : [];
	const explicitEndpoints =
		rawTargets.length > 0
			? rawTargets
					.map((entry) => normalizeEndpoint(entry))
					.filter((entry): entry is NonNullable<typeof entry> => entry !== null)
			: [];
	const legacyEndpoints = normalizeLegacyProviders(raw.providers);
	settings.endpoints = explicitEndpoints.length > 0 ? explicitEndpoints : legacyEndpoints.endpoints;
	settings.runtimePlugins = trimStringArray(raw.runtimePlugins);
	settings.orchestrator = normalizeWorkerTarget(raw.orchestrator, settings.orchestrator, settings.endpoints);
	if (!settings.orchestrator.endpoint) {
		settings.orchestrator =
			normalizeLegacyWorkerTarget(
				raw.orchestrator,
				settings.orchestrator,
				settings.endpoints,
				legacyEndpoints.pairToEndpointId,
			) ??
			normalizeLegacyProviderTarget(raw.provider, settings.orchestrator, settings.endpoints) ??
			settings.orchestrator;
	}

	if (isPlainObject(raw.workers)) {
		settings.workers.default = normalizeWorkerTarget(raw.workers.default, settings.workers.default, settings.endpoints);
		if (!settings.workers.default.endpoint) {
			settings.workers.default =
				normalizeLegacyWorkerTarget(
					raw.workers.default,
					settings.workers.default,
					settings.endpoints,
					legacyEndpoints.pairToEndpointId,
				) ?? settings.workers.default;
		}
		settings.workers.profiles = normalizeWorkerProfiles(
			raw.workers.profiles,
			DEFAULT_SETTINGS.workers.default,
			settings.endpoints,
		);
	}

	settings.scope = normalizeScope(raw.scope, settings.endpoints);
	if (settings.scope.length === 0) {
		const legacyProvider = isPlainObject(raw.provider) ? raw.provider : undefined;
		settings.scope = normalizeLegacyScope(legacyProvider?.scope, settings.endpoints, legacyEndpoints.pairToEndpointId);
	}

	if (isPlainObject(raw.budget)) {
		if (
			typeof raw.budget.sessionCeilingUsd === "number" &&
			Number.isFinite(raw.budget.sessionCeilingUsd) &&
			raw.budget.sessionCeilingUsd >= 0
		) {
			settings.budget.sessionCeilingUsd = raw.budget.sessionCeilingUsd;
		}
		if (raw.budget.concurrency === "auto") {
			settings.budget.concurrency = "auto";
		} else if (
			typeof raw.budget.concurrency === "number" &&
			Number.isFinite(raw.budget.concurrency) &&
			raw.budget.concurrency >= 1
		) {
			settings.budget.concurrency = Math.floor(raw.budget.concurrency);
		}
	}

	const theme = trimString(raw.theme);
	if (theme) settings.theme = theme;

	if (isPlainObject(raw.terminal)) {
		if (typeof raw.terminal.showTerminalProgress === "boolean") {
			settings.terminal.showTerminalProgress = raw.terminal.showTerminalProgress;
		}
	}

	if (isPlainObject(raw.keybindings)) {
		// pi-tui's KeybindingsConfig accepts `KeyId | KeyId[]`. Legacy Clio
		// settings persisted only strings; accept both shapes, drop empty or
		// non-string entries, and preserve arrays verbatim so a user can bind
		// two keystrokes to one action (`shift+tab: ["shift+tab","alt+t"]`).
		const next: Record<string, string | string[]> = {};
		for (const [rawKey, rawValue] of Object.entries(raw.keybindings)) {
			const id = trimString(rawKey);
			if (!id) continue;
			if (typeof rawValue === "string") {
				const v = trimString(rawValue);
				if (v) next[id] = v;
				continue;
			}
			if (Array.isArray(rawValue)) {
				const arr: string[] = [];
				for (const entry of rawValue) {
					if (typeof entry !== "string") continue;
					const trimmed = trimString(entry);
					if (trimmed) arr.push(trimmed);
				}
				if (arr.length > 0) next[id] = arr;
			}
		}
		settings.keybindings = next;
	}

	if (isPlainObject(raw.state)) {
		if (raw.state.lastMode === "default" || raw.state.lastMode === "advise" || raw.state.lastMode === "super") {
			settings.state.lastMode = raw.state.lastMode;
		}
	}

	if (isPlainObject(raw.compaction)) {
		if (
			typeof raw.compaction.threshold === "number" &&
			Number.isFinite(raw.compaction.threshold) &&
			raw.compaction.threshold >= 0 &&
			raw.compaction.threshold <= 1
		) {
			settings.compaction.threshold = raw.compaction.threshold;
		}
		if (typeof raw.compaction.auto === "boolean") settings.compaction.auto = raw.compaction.auto;
		const model = trimString(raw.compaction.model);
		const systemPrompt = trimString(raw.compaction.systemPrompt);
		if (model) settings.compaction.model = model;
		if (systemPrompt) settings.compaction.systemPrompt = systemPrompt;
	}

	if (isPlainObject(raw.retry)) {
		if (typeof raw.retry.enabled === "boolean") settings.retry.enabled = raw.retry.enabled;
		if (typeof raw.retry.maxRetries === "number" && Number.isFinite(raw.retry.maxRetries) && raw.retry.maxRetries >= 0) {
			settings.retry.maxRetries = Math.floor(raw.retry.maxRetries);
		}
		if (
			typeof raw.retry.baseDelayMs === "number" &&
			Number.isFinite(raw.retry.baseDelayMs) &&
			raw.retry.baseDelayMs >= 0
		) {
			settings.retry.baseDelayMs = Math.floor(raw.retry.baseDelayMs);
		}
		if (typeof raw.retry.maxDelayMs === "number" && Number.isFinite(raw.retry.maxDelayMs) && raw.retry.maxDelayMs >= 0) {
			settings.retry.maxDelayMs = Math.floor(raw.retry.maxDelayMs);
		}
	}

	return settings;
}

export function readSettings(): ClioSettings {
	const path = settingsPath();
	if (!existsSync(path)) return structuredClone(DEFAULT_SETTINGS);
	const raw = readFileSync(path, "utf8");
	const parsed = parseYaml(raw) as Partial<ClioSettings> | null;
	return normalizeSettings(parsed ?? {});
}

export function writeSettings(settings: ClioSettings): void {
	const tracePath = process.env.CLIO_TRACE_WRITESETTINGS;
	if (tracePath && tracePath !== "0") {
		const stack = new Error("writeSettings trace").stack ?? "";
		const orchTarget = settings.orchestrator?.endpoint ?? "<null>";
		const orchModel = settings.orchestrator?.model ?? "<null>";
		const tCount = settings.endpoints?.length ?? 0;
		const line = `\n[writeSettings @ ${new Date().toISOString()}] target=${orchTarget} model=${orchModel} endpoints=${tCount}\n${stack}\n`;
		appendFileSync(tracePath, line);
	}
	writeFileSync(settingsPath(), stringifyYaml(serializeSettings(normalizeSettings(settings))), {
		encoding: "utf8",
		mode: 0o644,
	});
}

function serializeSettings(settings: ClioSettings): SerializedSettings {
	const { endpoints, orchestrator, workers, ...rest } = settings;
	const profiles: SerializedSettings["workers"]["profiles"] = {};
	for (const [name, profile] of Object.entries(workers.profiles)) {
		profiles[name] = {
			target: profile.endpoint,
			model: profile.model,
			thinkingLevel: profile.thinkingLevel,
		};
	}
	return {
		...rest,
		targets: endpoints,
		orchestrator: {
			target: orchestrator.endpoint,
			model: orchestrator.model,
			thinkingLevel: orchestrator.thinkingLevel,
		},
		workers: {
			default: {
				target: workers.default.endpoint,
				model: workers.default.model,
				thinkingLevel: workers.default.thinkingLevel,
			},
			profiles,
		},
	};
}
