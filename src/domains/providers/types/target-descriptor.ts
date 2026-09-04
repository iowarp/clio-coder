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

// Canonical persisted lifecycle name. Readers temporarily normalize the
// released `clio-managed` spelling at the settings boundary.
export type TargetLifecycle = "user-managed" | "clio-coder-managed";

export interface LmStudioLoadSettings {
	contextLength?: number;
	flashAttention?: boolean;
	evalBatchSize?: number;
	numExperts?: number;
	offloadKvCacheToGpu?: boolean;
}

export type LmStudioReasoningSetting = "auto" | "off" | "on" | "low" | "medium" | "high";

export interface LmStudioRequestSettings {
	ttlSeconds?: number;
	draftModel?: string;
	reasoning?: LmStudioReasoningSetting;
}

export interface LmStudioTargetSettings {
	load?: LmStudioLoadSettings;
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
	lmstudio?: LmStudioTargetSettings;
	litellm?: LiteLLMTargetSettings;
	/** Explicit request-slot limit for this inference endpoint. It overrides live discovery. */
	maxConcurrentRequests?: number;
}
