import type { OAuthLoginCallbacks } from "../../engine/oauth.js";
import type { AuthCredential, AuthResolution, AuthStatus } from "./auth/index.js";
import type { CapabilityFlags } from "./types/capability-flags.js";
import type { EndpointDescriptor } from "./types/endpoint-descriptor.js";
import type { KnowledgeBase } from "./types/knowledge-base.js";
import type { RuntimeDescriptor } from "./types/runtime-descriptor.js";

/**
 * Query-only surface exposed to other domains. Dispatch, chat-loop, TUI
 * overlays, and the CLI read provider state through this contract; no one
 * reaches into `extension.ts` or the runtime registry directly.
 */

export interface EndpointHealth {
	status: "healthy" | "degraded" | "unknown" | "down";
	lastCheckAt: string | null;
	lastError: string | null;
	latencyMs: number | null;
}

export interface EndpointStatus {
	endpoint: EndpointDescriptor;
	/**
	 * Null when `endpoint.runtime` does not resolve to a registered descriptor.
	 * Callers treat null as "unknown runtime"; the endpoint is still listed so
	 * misconfigurations are visible in the TUI.
	 */
	runtime: RuntimeDescriptor | null;
	available: boolean;
	reason: string;
	health: EndpointHealth;
	/** Merged: defaults + knowledge base + probe + user override. */
	capabilities: CapabilityFlags;
	/** Ids returned by the last successful probeModels() call. */
	discoveredModels: ReadonlyArray<string>;
}

export interface ProvidersContract {
	/** All configured endpoints with readiness + health + capabilities. */
	list(): ReadonlyArray<EndpointStatus>;

	/** Resolve an endpoint by id. Null when the id is not in settings.endpoints. */
	getEndpoint(id: string): EndpointDescriptor | null;

	/**
	 * Runtime descriptor by id. Null when the runtime is not registered (neither
	 * built-in nor loaded from ~/.clio/runtimes/ nor an npm plugin).
	 */
	getRuntime(id: string): RuntimeDescriptor | null;

	/** Config-only readiness sweep. Does not hit the network. */
	probeAll(): Promise<void>;

	/** Live liveness + probeModels sweep. */
	probeAllLive(): Promise<void>;

	/** Probe a single endpoint live. Null when the id is not in settings.endpoints. */
	probeEndpoint(id: string): Promise<EndpointStatus | null>;

	/**
	 * Shared auth access for both API keys and OAuth credentials. Provider ids
	 * default to runtime ids, with endpoint-level overrides through
	 * `auth.apiKeyRef` / `auth.oauthProfile`.
	 */
	auth: {
		statusForTarget(endpoint: EndpointDescriptor, runtime: RuntimeDescriptor): AuthStatus;
		resolveForTarget(endpoint: EndpointDescriptor, runtime: RuntimeDescriptor): Promise<AuthResolution>;
		getStored(providerId: string): AuthCredential | null;
		listStored(): ReadonlyArray<{ providerId: string; type: AuthCredential["type"]; updatedAt: string }>;
		setApiKey(providerId: string, key: string): void;
		remove(providerId: string): void;
		login(providerId: string, callbacks: OAuthLoginCallbacks): Promise<void>;
		logout(providerId: string): void;
		getOAuthProviders(): ReadonlyArray<{ id: string; name: string }>;
	};

	/**
	 * Legacy API-key-only shim kept for setup and older call sites while
	 * everything migrates to `auth`.
	 */
	credentials: {
		hasKey(providerId: string): boolean;
		get(providerId: string): string | null;
		set(providerId: string, key: string): void;
		remove(providerId: string): void;
	};

	/**
	 * Model knowledge base used by chat-loop and overlays to synthesize pi-ai
	 * `Model<Api>` instances via `RuntimeDescriptor.synthesizeModel(endpoint,
	 * wireModelId, kb)`. Null when the bundled YAMLs are unreadable at boot.
	 */
	knowledgeBase: KnowledgeBase | null;
}
