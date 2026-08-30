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

// "clio-managed" is a settings.yaml enum value, not an artifact name; it stays
// unrenamed by rebrand decision so existing `lifecycle:` lines keep working.
export type TargetLifecycle = "user-managed" | "clio-managed";

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
	/** Explicit request-slot limit for this inference endpoint. It overrides live discovery. */
	maxConcurrentRequests?: number;
}
