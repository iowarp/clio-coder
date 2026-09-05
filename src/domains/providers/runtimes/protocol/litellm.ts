/**
 * LiteLLM proxy: an OpenAI-compatible gateway that fronts a fleet.
 *
 * This is a separate runtime from `openai-compat` rather than a target flag on
 * it, because a gateway answers two questions the generic protocol cannot.
 *
 * First, capability discovery. A gateway may publish aliases or truthful
 * physical names such as `dynamo/qwen3.8-27b`. LiteLLM's `/v1/models` is the
 * plain OpenAI listing, so every row flattens to a bare id and the context
 * window, tool support, and modality of the model behind it are all erased.
 * Reached over
 * `openai-compat`, a 262k tool-calling coder is indistinguishable from a 4k
 * chat toy, and Clio plans the session against its own assumed floor. LiteLLM
 * publishes the real numbers on `/v1/model/info` instead, which is what this
 * probe reads.
 *
 * Structured output is the one property worth stating explicitly, because
 * getting it wrong is silent. `src/core/response-schema.ts` deliberately keys
 * the schema dialect on runtime id and not on api family, since a generic
 * OpenAI-compatible gateway answers HTTP 200 to a `response_format` spelling it
 * does not implement and returns unconstrained JSON. LiteLLM earns its entry in
 * that table by measurement rather than by assumption: against the homelab
 * gateway on 2026-08-30, `{"type":"json_schema", json_schema:{...}}` was
 * grammar-enforced end to end on both a llama.cpp upstream and an LM Studio
 * upstream, `{"type":"json_object", schema:{...}}` was enforced on llama.cpp
 * and rejected HTTP 400 by LM Studio, and the same prompt with no
 * `response_format` returned plain prose. `drop_params: true` did not strip
 * either spelling. The standard `json_schema` dialect is therefore the one that
 * holds across every measured upstream, and a gateway must publish that fact
 * explicitly per route in `model_info` before Clio relies on it.
 */

import { CLIO_MIN_CONTEXT_WINDOW, CLIO_MIN_MAX_OUTPUT_TOKENS } from "../../../../core/context-floor.js";
import type { Api, Model } from "../../../../engine/types.js";
import { probeJson } from "../../probe/http.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, ProbeModelStatus, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";
import { stripTrailingSlash, synthLocalModel, withV1 } from "../common/local-synth.js";

const LITELLM_PROVIDER = "litellm";

/**
 * Conservative until the probe answers. A gateway that does not publish
 * `model_info` has told Clio nothing, and claiming tools on a target whose tool
 * surface is unknown produces a worker that fails on its first tool call rather
 * than one that is never admitted.
 */
const defaultCapabilities: CapabilityFlags = {
	chat: true,
	tools: false,
	reasoning: false,
	vision: false,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	structuredOutputs: "none",
	contextWindow: CLIO_MIN_CONTEXT_WINDOW,
	maxTokens: CLIO_MIN_MAX_OUTPUT_TOKENS,
};

/** The server root. This runtime's own paths carry `/v1` where they need it. */
function rootUrl(target: TargetDescriptor): string | null {
	if (!target.url) return null;
	const trimmed = stripTrailingSlash(target.url);
	return trimmed.endsWith("/v1") ? trimmed.slice(0, -"/v1".length) : trimmed;
}

function bearerHeaders(target: TargetDescriptor, ctx: ProbeContext): Record<string, string> {
	const headers: Record<string, string> = { ...(target.auth?.headers ?? {}) };
	const envName = target.auth?.apiKeyEnvVar;
	const fromEnv = envName && ctx.credentialsPresent.has(envName) ? process.env[envName]?.trim() : undefined;
	const token = ctx.authToken?.trim() || fromEnv;
	if (token) headers.authorization = `Bearer ${token}`;
	return headers;
}

interface LiteLLMModelInfoRow {
	model_name?: unknown;
	litellm_params?: { model?: unknown; api_base?: unknown };
	model_info?: Record<string, unknown>;
}

interface LiteLLMModelInfoResponse {
	data?: ReadonlyArray<LiteLLMModelInfoRow>;
}

interface LiteLLMModelsResponse {
	data?: ReadonlyArray<{ id?: unknown }>;
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function boolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

/**
 * Project one LiteLLM `model_info` block onto Clio's capability flags.
 *
 * Only fields the gateway actually filled in are returned. A `model_info` that
 * declares nothing leaves the whole record empty rather than reporting zeros,
 * so the caller can tell "the gateway says this model has no vision" apart from
 * "the gateway did not say", and merge accordingly.
 */
export function capabilitiesFromLiteLLMModelInfo(info: Record<string, unknown>): Partial<CapabilityFlags> {
	const caps: Partial<CapabilityFlags> = {};
	// This is a deployment declaration, never inferred from a URL, port or alias.
	if (info.runtime === "lm-studio") caps.thinkingControlRuntime = "lmstudio";
	else if (info.runtime === "llama.cpp") caps.thinkingControlRuntime = "llamacpp";
	const contextWindow = positiveInteger(info.max_input_tokens) ?? positiveInteger(info.max_tokens);
	if (contextWindow !== undefined) caps.contextWindow = contextWindow;
	const maxTokens = positiveInteger(info.max_output_tokens);
	if (maxTokens !== undefined) caps.maxTokens = maxTokens;
	const tools = boolean(info.supports_function_calling);
	if (tools !== undefined) caps.tools = tools;
	const vision = boolean(info.supports_vision);
	if (vision !== undefined) caps.vision = vision;
	const reasoning = boolean(info.supports_reasoning);
	if (reasoning !== undefined) caps.reasoning = reasoning;
	const audio = boolean(info.supports_audio_input);
	if (audio !== undefined) caps.audio = audio;
	// `mode` is LiteLLM's own surface discriminator. An embedding deployment is
	// not a chat deployment, and admitting it as one produces a run that fails
	// at the first completion rather than at selection.
	if (info.mode === "embedding") {
		caps.chat = false;
		caps.embeddings = true;
	}
	if (info.mode === "rerank") {
		caps.chat = false;
		caps.rerank = true;
	}
	if (info.mode === "chat") caps.chat = true;
	// Measured, not inferred: see the module header. An explicit false must
	// override this runtime's measured default for an upstream that cannot
	// preserve the schema contract.
	const responseSchema = boolean(info.supports_response_schema);
	if (responseSchema !== undefined) caps.structuredOutputs = responseSchema ? "json-schema" : "none";
	return caps;
}

const BOOLEAN_CAPABILITIES = [
	"chat",
	"tools",
	"reasoning",
	"vision",
	"audio",
	"embeddings",
	"rerank",
	"fim",
] as const satisfies ReadonlyArray<keyof CapabilityFlags>;

/**
 * One alias may load-balance across heterogeneous deployments. Clio can only
 * promise what every possible route supports: numerical limits take the
 * smallest fully-published value, booleans require unanimous publication, and
 * one explicit false defeats a true. Missing data never becomes a capability.
 */
export function aggregateLiteLLMCapabilities(rows: ReadonlyArray<Partial<CapabilityFlags>>): Partial<CapabilityFlags> {
	if (rows.length === 0) return {};
	const aggregate: Partial<CapabilityFlags> = {};
	for (const key of ["contextWindow", "maxTokens"] as const) {
		const values = rows.map((row) => row[key]);
		if (values.every((value): value is number => typeof value === "number")) {
			aggregate[key] = Math.min(...values);
		}
	}
	for (const key of BOOLEAN_CAPABILITIES) {
		const values = rows.map((row) => row[key]);
		if (values.some((value) => value === false)) aggregate[key] = false;
		else if (values.every((value) => value === true)) aggregate[key] = true;
	}
	const controlRuntime = rows[0]?.thinkingControlRuntime;
	if (controlRuntime !== undefined && rows.every((row) => row.thinkingControlRuntime === controlRuntime)) {
		aggregate.thinkingControlRuntime = controlRuntime;
	}
	const structuredOutputs = rows.map((row) => row.structuredOutputs);
	if (structuredOutputs.some((value) => value === "none")) aggregate.structuredOutputs = "none";
	else if (structuredOutputs.every((value) => value === "json-schema")) aggregate.structuredOutputs = "json-schema";
	return aggregate;
}

interface LiteLLMCatalog {
	models: string[];
	modelCapabilities: Record<string, Partial<CapabilityFlags>>;
	modelStates: Record<string, ProbeModelStatus>;
	/** Physical deployment behind each alias, for display. */
	deployments: Record<string, Array<{ model: string; apiBase?: string }>>;
	/** Whether the empty catalog is specifically because the gateway rejected the key. */
	authFailed: boolean;
}

const EMPTY_CATALOG: LiteLLMCatalog = {
	models: [],
	modelCapabilities: {},
	modelStates: {},
	deployments: {},
	authFailed: false,
};

/** Whether a failed probe leg failed specifically on the credential, not on reachability. */
function isAuthError(leg: { ok: boolean; error?: string }): boolean {
	return !leg.ok && /^HTTP 40[13]\b/u.test(leg.error ?? "");
}

/**
 * Read the catalog from `/v1/model/info`, falling back to `/v1/models`.
 *
 * The detail endpoint is the only one that carries capabilities, but it can be
 * refused for a virtual key with narrower permissions than the master key. A
 * gateway that answers the plain listing and refuses the detail is still usable;
 * it just cannot tell Clio anything beyond which aliases exist, so the target
 * falls back to its declared capabilities exactly as `openai-compat` would.
 */
async function fetchCatalog(base: string, ctx: ProbeContext, headers: Record<string, string>): Promise<LiteLLMCatalog> {
	const detailOpts = { url: `${base}/v1/model/info`, timeoutMs: ctx.httpTimeoutMs, headers } as const;
	const detail = await (ctx.signal
		? probeJson<LiteLLMModelInfoResponse>({ ...detailOpts, signal: ctx.signal })
		: probeJson<LiteLLMModelInfoResponse>(detailOpts));

	if (detail.ok && Array.isArray(detail.data?.data)) {
		const catalog: LiteLLMCatalog = {
			models: [],
			modelCapabilities: {},
			modelStates: {},
			deployments: {},
			authFailed: false,
		};
		const capabilityRows: Record<string, Array<Partial<CapabilityFlags>>> = {};
		for (const row of detail.data.data) {
			if (typeof row?.model_name !== "string" || row.model_name.length === 0) continue;
			const alias = row.model_name;
			if (catalog.deployments[alias] === undefined) {
				catalog.models.push(alias);
				catalog.deployments[alias] = [];
				capabilityRows[alias] = [];
			}
			const caps = row.model_info ? capabilitiesFromLiteLLMModelInfo(row.model_info) : {};
			capabilityRows[alias]?.push(caps);
			const upstream = row.litellm_params?.model;
			const apiBase = row.litellm_params?.api_base;
			catalog.deployments[alias]?.push({
				model: typeof upstream === "string" ? upstream : alias,
				...(typeof apiBase === "string" ? { apiBase } : {}),
			});
		}
		for (const alias of catalog.models) {
			const caps = aggregateLiteLLMCapabilities(capabilityRows[alias] ?? []);
			if (Object.keys(caps).length > 0) catalog.modelCapabilities[alias] = caps;
		}
		if (catalog.models.length > 0) return catalog;
	}
	const detailAuthFailed = isAuthError(detail);

	const listOpts = { url: `${base}/v1/models`, timeoutMs: ctx.httpTimeoutMs, headers } as const;
	const list = await (ctx.signal
		? probeJson<LiteLLMModelsResponse>({ ...listOpts, signal: ctx.signal })
		: probeJson<LiteLLMModelsResponse>(listOpts));
	if (!list.ok || !Array.isArray(list.data?.data)) {
		return { ...EMPTY_CATALOG, authFailed: detailAuthFailed || isAuthError(list) };
	}
	const models = list.data.data
		.map((row) => (typeof row?.id === "string" ? row.id : null))
		.filter((id): id is string => id !== null && id.length > 0);
	return { models, modelCapabilities: {}, modelStates: {}, deployments: {}, authFailed: false };
}

const litellmRuntime: RuntimeDescriptor = {
	id: "litellm",
	displayName: "LiteLLM gateway",
	kind: "http",
	tier: "protocol",
	apiFamily: "openai-completions",
	auth: "api-key",
	defaultCapabilities,

	async probe(target: TargetDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
		const base = rootUrl(target);
		if (!base) return { ok: false, error: "target has no url" };
		const headers = bearerHeaders(target, ctx);

		// Liveness first, and deliberately on the unauthenticated endpoint. A
		// gateway with authentication enforced answers 401 to `/v1/models` when
		// credentials are missing or wrong, which is indistinguishable from an
		// unreachable host if that is the only thing probed. `/health/liveliness`
		// separates "the gateway is down" from "this key is not valid", and the
		// two have completely different remedies.
		const liveOpts = { url: `${base}/health/liveliness`, timeoutMs: ctx.httpTimeoutMs } as const;
		const live = await (ctx.signal
			? probeJson<unknown>({ ...liveOpts, signal: ctx.signal })
			: probeJson<unknown>(liveOpts));
		if (!live.ok) return { ok: false, error: live.error ?? "gateway is not reachable" };

		const catalog = await fetchCatalog(base, ctx, headers);
		if (catalog.models.length === 0) {
			const result: ProbeResult = {
				ok: false,
				error: catalog.authFailed
					? "gateway rejected the key"
					: "gateway is live but served no model catalog; check the target's API key",
			};
			if (catalog.authFailed) result.authFailed = true;
			if (live.latencyMs !== undefined) result.latencyMs = live.latencyMs;
			return result;
		}

		const result: ProbeResult = { ok: true, models: catalog.models };
		if (live.latencyMs !== undefined) result.latencyMs = live.latencyMs;
		if (Object.keys(catalog.modelCapabilities).length > 0) {
			result.modelCapabilities = catalog.modelCapabilities;
			const selected = target.defaultModel?.trim();
			const selectedCaps = selected ? catalog.modelCapabilities[selected] : undefined;
			if (selected && selectedCaps) {
				result.discoveredCapabilities = selectedCaps;
				result.capabilityModelId = selected;
			}
		}
		const notes: string[] = [];
		const configured = target.defaultModel?.trim();
		if (configured && !catalog.models.includes(configured)) {
			notes.push(`configured model '${configured}' is not in the gateway catalog`);
		}
		// A node/model catalog already names placement. Summarize those one-to-one
		// routes instead of flooding target diagnostics with dozens of tautologies;
		// retain the explicit mapping for genuine aliases and multi-deployments.
		const routeEntries = Object.entries(catalog.deployments);
		const physical = routeEntries.filter(([alias, deployments]) => {
			const slash = alias.indexOf("/");
			if (slash <= 0 || deployments.length !== 1) return false;
			const upstream = deployments[0]?.model.replace(/^openai\//u, "");
			return upstream === alias.slice(slash + 1);
		});
		if (physical.length > 0) notes.push(`physical routes: ${physical.length} node/model names map one-to-one`);
		const routed = routeEntries
			.filter(([alias]) => !physical.some(([physicalAlias]) => physicalAlias === alias))
			.map(([alias, deployments]) => {
				const models = [...new Set(deployments.map((deployment) => deployment.model))];
				return `${alias}=${models.join("|")}`;
			})
			.sort();
		if (routed.length > 0) notes.push(`routes: ${routed.join(", ")}`);
		if (notes.length > 0) result.notes = notes;
		return result;
	},

	async probeModels(target: TargetDescriptor, ctx: ProbeContext): Promise<string[]> {
		const base = rootUrl(target);
		if (!base) return [];
		return (await fetchCatalog(base, ctx, bearerHeaders(target, ctx))).models;
	},

	synthesizeModel(target: TargetDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		return synthLocalModel({
			// A LiteLLM target is a gateway whether or not settings said so. The
			// residency layer reads this to stay observe-only: the models behind an
			// alias are the proxy's to load and evict, and a Clio stream that tried
			// to manage them would be issuing load commands to a host that does not
			// take them.
			target: { ...target, gateway: true },
			wireModelId,
			kb,
			defaultCapabilities,
			apiFamily: "openai-completions",
			provider: LITELLM_PROVIDER,
			baseUrlForTarget: withV1,
		});
	},
};

export default litellmRuntime;
