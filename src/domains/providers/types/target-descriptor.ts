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

export type TargetLifecycle = "user-managed" | "clio-managed";

/**
 * Persisted target specification from settings.yaml (`targets:`). It binds a
 * user-facing target id to a RuntimeDescriptor id, endpoint URL/auth metadata,
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
}
