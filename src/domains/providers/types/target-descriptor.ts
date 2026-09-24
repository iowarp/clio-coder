import type { CapabilityFlags } from "./capability-flags.js";

export interface TargetAuth {
	apiKeyEnvVar?: string;
	apiKeyRef?: string;
	oauthProfile?: string;
	headers?: Record<string, string>;
}

export interface TargetPricing {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
}

/** Request policy interpreted by the selected Pi API; it does not authorize cache administration or paid warming. */
export interface TargetCacheSettings {
	retention?: "none" | "short" | "long";
	/** Explicit read-only deployment binding; never grants administrative authority. */
	deployment?: {
		backend: "llamacpp" | "vllm" | "lmstudio";
		controlUrl: string;
		model: string;
		/** Required for build-pinned llama.cpp/vLLM deployments. */
		build?: string;
		/** Required for a gateway binding; compared with its current route inventory. */
		gatewayDeploymentId?: string;
	};
	/** Local warm bounds. Paid routes remain ineligible. */
	warm?: { startup?: boolean; maxInputTokens?: number; maxDurationMs?: number; cooldownMs?: number };
}

// Canonical persisted lifecycle name. Readers temporarily normalize the
// released `clio-managed` spelling at the settings boundary.
export type TargetLifecycle = "user-managed" | "clio-coder-managed";

/**
 * Load-time settings Clio sends to LM Studio's `POST /api/v1/models/load`. Each maps
 * one-to-one onto the load body key of the same name in snake case. `parallel` and
 * `speculativeDraftMaxTokens` are absent from LM Studio's published load reference, but
 * the server validates keys strictly and applies both (measured on dynamo, 2026-09-24).
 */
export interface LmStudioLoadSettings {
	contextLength?: number;
	flashAttention?: boolean;
	evalBatchSize?: number;
	numExperts?: number;
	offloadKvCacheToGpu?: boolean;
	/** Max concurrent predictions (continuous-batching slots). */
	parallel?: number;
	/** Most tokens a speculative draft, MTP heads included, proposes per step. */
	speculativeDraftMaxTokens?: number;
}

export type LmStudioReasoningSetting = "auto" | "off" | "on" | "low" | "medium" | "high";

export interface LmStudioRequestSettings {
	ttlSeconds?: number;
	draftModel?: string;
	reasoning?: LmStudioReasoningSetting;
}

export interface LmStudioTargetSettings {
	/** Load profile for every model Clio loads through this target. */
	load?: LmStudioLoadSettings;
	/** Per-model load overrides, keyed by the model id Clio selects on this target. */
	models?: Record<string, { load?: LmStudioLoadSettings }>;
	request?: LmStudioRequestSettings;
}

/** Per-request controls understood by a LiteLLM proxy. Values are optional so server policy remains authoritative by default. */
export interface LiteLLMRequestSettings {
	/** Extra LiteLLM request tags. Clio always adds `clio-coder`. */
	tags?: string[];
	/** Forward Clio's stable session id as `x-litellm-session-id`. Defaults to true. */
	sendSessionId?: boolean;
	/** Override the proxy/upstream request timeout through `x-litellm-timeout`. */
	timeoutSeconds?: number;
	/** Override LiteLLM's streamed-response timeout through `x-litellm-stream-timeout`. */
	streamTimeoutSeconds?: number;
	/** Override LiteLLM router retries for this request; this does not enable client-side SDK retries. */
	numRetries?: number;
}

export interface LiteLLMTargetSettings {
	request?: LiteLLMRequestSettings;
}

/** Ollama request options Clio sends only when the operator sets them. */
export interface OllamaTargetSettings {
	/**
	 * Context window requested as `options.num_ctx` on every chat request, and
	 * the window Clio plans against. Ollama reloads a model whose `num_ctx`
	 * changes, so on a server other clients share this evicts their load.
	 */
	numCtx?: number;
}

/**
 * Persisted target specification from settings.yaml (`targets:`). It binds a
 * user-facing target id to a RuntimeDescriptor id, target URL/auth metadata,
 * model defaults, and capability overrides. Runtime resolution combines this
 * spec with the registry/catalog to produce a ResolvedRuntimeTarget.
 */
export interface TargetDescriptor {
	id: string;
	runtime: string;
	url?: string;
	auth?: TargetAuth;
	defaultModel?: string;
	wireModels?: string[];
	capabilities?: Partial<CapabilityFlags>;
	lifecycle?: TargetLifecycle;
	gateway?: boolean;
	pricing?: TargetPricing;
	cache?: TargetCacheSettings;
	lmstudio?: LmStudioTargetSettings;
	litellm?: LiteLLMTargetSettings;
	ollama?: OllamaTargetSettings;
	/** Explicit request-slot limit for this inference endpoint. It overrides live discovery. */
	maxConcurrentRequests?: number;
}
