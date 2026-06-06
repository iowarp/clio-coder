import type { CapabilityFlags } from "./capability-flags.js";

export interface EndpointAuth {
	apiKeyEnvVar?: string;
	apiKeyRef?: string;
	oauthProfile?: string;
	headers?: Record<string, string>;
}

export interface EndpointPricing {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export type EndpointLifecycle = "user-managed" | "clio-managed";

/**
 * Persisted target specification from settings.yaml (`targets:` on disk,
 * `endpoints` in normalized settings for historical compatibility). It binds a
 * user-facing target id to a RuntimeDescriptor id, endpoint URL/auth metadata,
 * model defaults, and capability overrides. Runtime resolution combines this
 * spec with the registry/catalog to produce a ResolvedRuntimeTarget.
 */
export interface EndpointDescriptor {
	id: string;
	runtime: string;
	url?: string;
	auth?: EndpointAuth;
	defaultModel?: string;
	wireModels?: string[];
	capabilities?: Partial<CapabilityFlags>;
	lifecycle?: EndpointLifecycle;
	gateway?: boolean;
	pricing?: EndpointPricing;
}

export type TargetSpec = EndpointDescriptor;
