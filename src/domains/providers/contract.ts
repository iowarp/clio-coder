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
	/** Probe-only capabilities preserved separately for per-model synthesis in the UI. */
	probeCapabilities?: Partial<CapabilityFlags> | null;
	/** Diagnostic notes from the last probe (e.g. wire-model mismatch warnings). */
	probeNotes?: ReadonlyArray<string>;
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

	/** Clear in-memory live connection state for a configured target. */
	disconnectEndpoint(id: string): EndpointStatus | null;

	/**
	 * Cached reasoning detection result for a given (endpoint, wire model id).
	 * Returns true/false when a probe has populated the cache, null otherwise.
	 * Surfaces local-server reasoning capability that is per loaded model and
	 * cannot be inferred from runtime defaults alone.
	 */
	getDetectedReasoning(endpointId: string, modelId: string): boolean | null;

	/**
	 * Probe an endpoint's loaded model for reasoning support. Caches the result
	 * keyed by `(endpointId, modelId)` and returns it. Null when the runtime
	 * lacks `probeReasoning`, the endpoint is unknown, or the probe could not
	 * reach the server.
	 */
	probeReasoningForModel(endpointId: string, modelId: string): Promise<boolean | null>;

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
		/**
		 * Install a process-lifetime API key override for the provider behind
		 * `endpoint`. Used by the top-level `--api-key <key>` startup flag so a
		 * one-shot run can authenticate without persisting credentials.
		 */
		setRuntimeOverrideForTarget(endpoint: EndpointDescriptor, runtime: RuntimeDescriptor, key: string): void;
		clearRuntimeOverrideForTarget(endpoint: EndpointDescriptor, runtime: RuntimeDescriptor): void;
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
