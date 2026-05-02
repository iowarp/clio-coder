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
