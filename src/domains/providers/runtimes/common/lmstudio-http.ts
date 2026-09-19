import { performance } from "node:perf_hooks";
import { THINKING_LEVELS } from "../../../../core/defaults.js";
import type { ThinkingLevel } from "../../types/capability-flags.js";
import type { ProbeContext } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";
import { targetRootUrl } from "./local-synth.js";

export interface LmStudioLoadedInstance {
	id: string;
	config: Readonly<Record<string, unknown>>;
}

export interface LmStudioModelInfo {
	key: string;
	type?: string;
	maxContextLength?: number;
	loadedInstances: LmStudioLoadedInstance[];
	vision?: boolean;
	tools?: boolean;
	reasoningOptions?: string[];
	reasoning?: boolean;
	metadata: Readonly<Record<string, unknown>>;
}

export type LmStudioApiTier = "0.4+" | "0.3.x" | "openai-compat";

export interface LmStudioCatalog {
	ok: boolean;
	models: LmStudioModelInfo[];
	tier?: LmStudioApiTier;
	latencyMs?: number;
	error?: string;
	authRequired?: boolean;
}

export interface LmStudioInstanceResolution {
	requestedId: string;
	wireModelId: string;
	model?: LmStudioModelInfo;
	instance?: LmStudioLoadedInstance;
	peerTargets: string[];
	state: "instance" | "jit" | "unknown";
}

interface LmStudioHostCatalog {
	targetId: string;
	rootUrl: string;
	models: LmStudioModelInfo[];
	catalog: LmStudioCatalog;
	requestHeaders: string;
	at: number;
}

const catalogsByHost = new Map<string, LmStudioHostCatalog>();

export interface LmStudioJsonResponse {
	ok: boolean;
	status: number;
	data?: unknown;
	latencyMs: number;
	error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function lmStudioRootUrl(url: string): string {
	const normalized = targetRootUrl({ id: "lmstudio", runtime: "lmstudio", url });
	if (!normalized) return "";
	if (normalized.startsWith("ws://")) return `http://${normalized.slice("ws://".length)}`;
	if (normalized.startsWith("wss://")) return `https://${normalized.slice("wss://".length)}`;
	return normalized;
}

function lmStudioRequestHeaders(
	base: Readonly<Record<string, string>> | undefined,
	apiKey: string | undefined,
): Record<string, string> {
	const headers = new Headers(base);
	const token = apiKey?.trim();
	if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
	return Object.fromEntries(headers);
}

function lmStudioProbeHeaders(target: TargetDescriptor, ctx: ProbeContext): Record<string, string> {
	let token = ctx.authToken?.trim();
	const envName = target.auth?.apiKeyEnvVar;
	if (!token && envName && ctx.credentialsPresent.has(envName)) token = process.env[envName]?.trim();
	return lmStudioRequestHeaders(target.auth?.headers, token);
}

function combinedSignal(timeoutMs: number, signal?: AbortSignal): { signal: AbortSignal; close(): void } {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
	const onAbort = () => controller.abort(signal?.reason);
	if (signal?.aborted) controller.abort(signal.reason);
	else signal?.addEventListener("abort", onAbort, { once: true });
	return {
		signal: controller.signal,
		close() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		},
	};
}

export async function requestLmStudioJson(
	url: string,
	init: RequestInit,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<LmStudioJsonResponse> {
	const started = performance.now();
	const bounded = combinedSignal(timeoutMs, signal);
	try {
		const response = await fetch(url, { ...init, signal: bounded.signal });
		let data: unknown;
		try {
			data = await response.json();
		} catch {
			bounded.signal.throwIfAborted();
			data = undefined;
		}
		const result: LmStudioJsonResponse = {
			ok: response.ok,
			status: response.status,
			latencyMs: Math.round(performance.now() - started),
		};
		if (data !== undefined) result.data = data;
		if (!response.ok) {
			const detail = isRecord(data) ? (data.error ?? data) : undefined;
			const message = nonEmptyString(detail) ?? (isRecord(detail) ? nonEmptyString(detail.message) : undefined);
			const code = isRecord(detail) ? nonEmptyString(detail.code) : undefined;
			result.error = [code, message].filter(Boolean).join(": ") || `HTTP ${response.status}`;
		}
		return result;
	} catch (error) {
		signal?.throwIfAborted();
		return {
			ok: false,
			status: 0,
			latencyMs: Math.round(performance.now() - started),
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		bounded.close();
	}
}

function loadedInstances(value: unknown): LmStudioLoadedInstance[] {
	if (!Array.isArray(value)) return [];
	const instances: LmStudioLoadedInstance[] = [];
	for (const raw of value) {
		if (!isRecord(raw)) continue;
		const id = nonEmptyString(raw.id);
		if (!id) continue;
		instances.push({ id, config: isRecord(raw.config) ? { ...raw.config } : {} });
	}
	return instances;
}

function reasoningOptions(capabilities: unknown): string[] | undefined {
	if (!isRecord(capabilities) || !isRecord(capabilities.reasoning)) return undefined;
	const allowed = capabilities.reasoning.allowed_options;
	if (!Array.isArray(allowed)) return undefined;
	const options = allowed.filter((entry): entry is string => typeof entry === "string");
	return options.length > 0 ? options : undefined;
}

function parseLmStudioV1Models(data: unknown): LmStudioModelInfo[] | null {
	if (!isRecord(data) || !Array.isArray(data.models)) return null;
	const models: LmStudioModelInfo[] = [];
	for (const raw of data.models) {
		if (!isRecord(raw)) continue;
		const key = nonEmptyString(raw.key);
		if (!key) continue;
		const capabilities = isRecord(raw.capabilities) ? raw.capabilities : undefined;
		const info: LmStudioModelInfo = {
			key,
			loadedInstances: loadedInstances(raw.loaded_instances),
			metadata: { ...raw },
		};
		const type = nonEmptyString(raw.type);
		if (type) info.type = type;
		const maxContextLength = positiveNumber(raw.max_context_length);
		if (maxContextLength !== undefined) info.maxContextLength = maxContextLength;
		if (capabilities && typeof capabilities.vision === "boolean") info.vision = capabilities.vision;
		else if (type) info.vision = type === "vlm";
		if (capabilities && typeof capabilities.trained_for_tool_use === "boolean") {
			info.tools = capabilities.trained_for_tool_use;
		}
		const options = reasoningOptions(capabilities);
		if (options) info.reasoningOptions = options;
		if (capabilities && "reasoning" in capabilities) {
			info.reasoning = capabilities.reasoning === true || isRecord(capabilities.reasoning);
		}
		models.push(info);
	}
	return models;
}

export function foldLmStudioModels(models: ReadonlyArray<LmStudioModelInfo>): LmStudioModelInfo[] {
	const byKey = new Map<string, LmStudioModelInfo>();
	for (const model of models) {
		const previous = byKey.get(model.key);
		if (!previous) {
			byKey.set(model.key, { ...model, loadedInstances: [...model.loadedInstances] });
			continue;
		}
		const knownIds = new Set(previous.loadedInstances.map((instance) => instance.id));
		for (const instance of model.loadedInstances) {
			if (!knownIds.has(instance.id)) previous.loadedInstances.push(instance);
		}
		if (previous.maxContextLength === undefined && model.maxContextLength !== undefined) {
			previous.maxContextLength = model.maxContextLength;
		}
		if (previous.vision === undefined && model.vision !== undefined) previous.vision = model.vision;
		if (previous.tools === undefined && model.tools !== undefined) previous.tools = model.tools;
		if (previous.reasoningOptions === undefined && model.reasoningOptions !== undefined) {
			previous.reasoningOptions = model.reasoningOptions;
		}
		if (previous.reasoning === undefined && model.reasoning !== undefined) previous.reasoning = model.reasoning;
	}
	return [...byKey.values()];
}

export function invalidateLmStudioCatalog(target: TargetDescriptor): void {
	catalogsByHost.delete(lmStudioRootUrl(target.url ?? ""));
}

function peerTargetsFor(target: TargetDescriptor, instanceId: string): string[] {
	const rootUrl = lmStudioRootUrl(target.url ?? "");
	const peers: string[] = [];
	for (const catalog of catalogsByHost.values()) {
		if (catalog.rootUrl === rootUrl) continue;
		if (catalog.models.some((model) => model.loadedInstances.some((instance) => instance.id === instanceId))) {
			peers.push(catalog.targetId);
		}
	}
	return [...new Set(peers)];
}

export function resolveLmStudioInstance(
	target: TargetDescriptor,
	models: ReadonlyArray<LmStudioModelInfo>,
	requestedId: string,
	configuredDefault?: string,
): LmStudioInstanceResolution {
	const folded = foldLmStudioModels(models);
	for (const model of folded) {
		const explicit = model.loadedInstances.find((instance) => instance.id === requestedId);
		if (explicit) {
			return {
				requestedId,
				wireModelId: explicit.id,
				model,
				instance: explicit,
				peerTargets: peerTargetsFor(target, explicit.id),
				state: "instance",
			};
		}
		if (model.key !== requestedId) continue;
		if (model.loadedInstances.length === 0) {
			return { requestedId, wireModelId: requestedId, model, peerTargets: [], state: "jit" };
		}
		const preferred = configuredDefault
			? model.loadedInstances.find((instance) => instance.id === configuredDefault)
			: undefined;
		const local = model.loadedInstances.find((instance) => peerTargetsFor(target, instance.id).length === 0);
		const instance = preferred ?? local ?? model.loadedInstances[0];
		if (!instance) return { requestedId, wireModelId: requestedId, model, peerTargets: [], state: "jit" };
		return {
			requestedId,
			wireModelId: instance.id,
			model,
			instance,
			peerTargets: peerTargetsFor(target, instance.id),
			state: "instance",
		};
	}
	return { requestedId, wireModelId: requestedId, peerTargets: [], state: "unknown" };
}

export function lmStudioReasoningLevels(options: ReadonlyArray<string> | undefined): ThinkingLevel[] {
	if (!options || options.length === 0) return [...THINKING_LEVELS];
	if (options.includes("on") && !options.includes("low") && !options.includes("medium") && !options.includes("high")) {
		return ["off", "low"];
	}
	const levels: ThinkingLevel[] = ["off"];
	if (options.includes("low")) levels.push("minimal", "low");
	if (options.includes("medium")) levels.push("medium");
	if (options.includes("high")) levels.push("high", "xhigh", "max");
	return [...new Set(levels)];
}

export function lmStudioReasoningEffort(
	level: ThinkingLevel,
	options?: ReadonlyArray<string>,
): "none" | "low" | "medium" | "high" | undefined {
	// `allowed_options` describes the model's binary setting, but LM Studio's
	// OpenAI-compatible request schema still accepts only effort-level values.
	// Omit an active override for binary/default-on models; sending `low` works
	// only through a warning and sending the advertised literal `on` is a 400.
	if (options?.includes("on") && options.includes("off")) return level === "off" ? "none" : undefined;
	if (level === "off") return "none";
	if (level === "medium" && options?.includes("medium") !== false) return "medium";
	if ((level === "high" || level === "xhigh" || level === "max") && options?.includes("high") !== false) return "high";
	return "low";
}

function v0Models(data: unknown): LmStudioModelInfo[] | null {
	if (!isRecord(data) || !Array.isArray(data.data)) return null;
	const models: LmStudioModelInfo[] = [];
	for (const raw of data.data) {
		if (!isRecord(raw)) continue;
		const key = nonEmptyString(raw.id);
		if (!key) continue;
		const state = nonEmptyString(raw.state);
		const loadedContext = positiveNumber(raw.loaded_context_length);
		const config = loadedContext === undefined ? {} : { context_length: loadedContext };
		const info: LmStudioModelInfo = {
			key,
			loadedInstances: state === "loaded" || loadedContext !== undefined ? [{ id: key, config }] : [],
			metadata: { ...raw },
		};
		const type = nonEmptyString(raw.type);
		if (type) {
			info.type = type;
			info.vision = type === "vlm";
		}
		const maxContextLength = positiveNumber(raw.max_context_length);
		if (maxContextLength !== undefined) info.maxContextLength = maxContextLength;
		if (Array.isArray(raw.capabilities)) info.tools = raw.capabilities.includes("tool_use");
		models.push(info);
	}
	return models;
}

function openAIModels(data: unknown): LmStudioModelInfo[] | null {
	if (!isRecord(data) || !Array.isArray(data.data)) return null;
	const models: LmStudioModelInfo[] = [];
	for (const raw of data.data) {
		if (!isRecord(raw)) continue;
		const key = nonEmptyString(raw.id);
		if (key) models.push({ key, loadedInstances: [], metadata: { ...raw } });
	}
	return models;
}

function authFailure(result: LmStudioJsonResponse): LmStudioCatalog | null {
	if (result.status !== 401 && result.status !== 403) return null;
	return {
		ok: false,
		models: [],
		latencyMs: result.latencyMs,
		error: "LM Studio authentication required",
		authRequired: true,
	};
}

export async function listLmStudioModels(
	target: TargetDescriptor,
	ctx: ProbeContext,
	maxAgeMs = 0,
): Promise<LmStudioCatalog> {
	ctx.signal?.throwIfAborted();
	if (!target.url) return { ok: false, models: [], error: "target has no url" };
	const root = lmStudioRootUrl(target.url);
	const headers = lmStudioProbeHeaders(target, ctx);
	const requestHeaders = JSON.stringify(headers);
	const cached = catalogsByHost.get(root);
	if (cached && cached.requestHeaders === requestHeaders && performance.now() - cached.at < maxAgeMs) {
		return cached.catalog;
	}
	const endpoints: Array<[string, LmStudioApiTier, (data: unknown) => LmStudioModelInfo[] | null]> = [
		["/api/v1/models", "0.4+", parseLmStudioV1Models],
		["/api/v0/models", "0.3.x", v0Models],
		["/v1/models", "openai-compat", openAIModels],
	];
	let latencyMs = 0;
	let error = "LM Studio returned no recognized model catalog";
	for (const [path, tier, parse] of endpoints) {
		const response = await requestLmStudioJson(`${root}${path}`, { headers }, ctx.httpTimeoutMs, ctx.signal);
		latencyMs += response.latencyMs;
		const auth = authFailure(response);
		if (auth) {
			invalidateLmStudioCatalog(target);
			return auth;
		}
		const models = response.ok ? parse(response.data) : null;
		if (models) {
			const catalog = { ok: true, models: foldLmStudioModels(models), tier, latencyMs };
			catalogsByHost.set(root, {
				targetId: target.id,
				rootUrl: root,
				models: catalog.models,
				catalog,
				requestHeaders,
				at: performance.now(),
			});
			return catalog;
		}
		error = response.error ?? error;
		// Try older API versions only when this endpoint is unavailable, not on a server outage.
		if (response.status !== 404 && response.status !== 405) break;
	}
	invalidateLmStudioCatalog(target);
	return { ok: false, models: [], latencyMs, error };
}

export async function greetLmStudio(
	target: TargetDescriptor,
	ctx: ProbeContext,
): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
	if (!target.url) return { ok: false, error: "target has no url" };
	const result = await requestLmStudioJson(
		`${lmStudioRootUrl(target.url)}/lmstudio-greeting`,
		{ headers: lmStudioProbeHeaders(target, ctx) },
		ctx.httpTimeoutMs,
		ctx.signal,
	);
	if (result.ok && isRecord(result.data) && result.data.lmstudio === true) {
		return { ok: true, latencyMs: result.latencyMs };
	}
	return { ok: false, latencyMs: result.latencyMs, error: result.error ?? "endpoint did not return {lmstudio:true}" };
}

export function loadedContextLength(instance: LmStudioLoadedInstance | undefined): number | undefined {
	return positiveNumber(instance?.config.context_length);
}
