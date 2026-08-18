import type { OAuthLoginCallbacks } from "../../engine/oauth.js";
import type { AuthCredential, AuthResolution, AuthStatus } from "./auth/index.js";
import type { CapabilityFlags } from "./types/capability-flags.js";
import type { KnowledgeBase } from "./types/knowledge-base.js";
import type { ProbeModelStatus, ProbeSurfaceMap, RuntimeDescriptor } from "./types/runtime-descriptor.js";
import type { TargetDescriptor } from "./types/target-descriptor.js";

/**
 * Query-only surface exposed to other domains. Dispatch, chat-loop, TUI
 * overlays, and the CLI read provider state through this contract; no one
 * reaches into `extension.ts` or the runtime registry directly.
 */

/**
 * The layer that answered a target's context window, most authoritative first.
 * `runtime-default` is the absence case: nothing declared a window and the
 * runtime descriptor's placeholder stands in for one.
 */
export type ContextWindowProvenance = "configured" | "discovered" | "catalog" | "runtime-default";

export interface TargetHealth {
	status: "healthy" | "degraded" | "unknown" | "down";
	lastCheckAt: string | null;
	lastError: string | null;
	latencyMs: number | null;
}

export interface TargetStatus {
	target: TargetDescriptor;
	/**
	 * Null when `target.runtime` does not resolve to a registered descriptor.
	 * Callers treat null as "unknown runtime"; the target is still listed so
	 * misconfigurations are visible in the TUI.
	 */
	runtime: RuntimeDescriptor | null;
	available: boolean;
	reason: string;
	health: TargetHealth;
	/** Merged: defaults + knowledge base + probe + user override. */
	capabilities: CapabilityFlags;
	/**
	 * Where `capabilities.contextWindow` came from. `runtime-default` means no
	 * probe, catalog, knowledge base, or user setting answered, so the number is
	 * the runtime descriptor's placeholder and must be presented as a guess
	 * rather than a discovered capability. Absent only on statuses built before
	 * a runtime resolved.
	 */
	contextWindowProvenance?: ContextWindowProvenance;
	/** Probe-only capabilities preserved separately for per-model synthesis in the UI. */
	probeCapabilities?: Partial<CapabilityFlags> | null;
	/** Probe-only capabilities keyed by wire model id for selected-model resolution. */
	probeModelCapabilities?: Readonly<Record<string, Partial<CapabilityFlags>>> | null;
	/** Wire model id the probe-only capabilities were read from, when known. */
	probeModelId?: string | null;
	/** Diagnostic notes from the last probe (e.g. wire-model mismatch warnings). */
	probeNotes?: ReadonlyArray<string>;
	/** Inference and management surfaces selected by the last successful probe. */
	probeSurfaces?: Readonly<ProbeSurfaceMap>;
	/** Ids returned by the last successful probeModels() call. */
	discoveredModels: ReadonlyArray<string>;
	/**
	 * Source for `discoveredModels`. `probe` means the target just returned a
	 * live catalog, `cache` is a previously probed catalog preserved across a
	 * config-only refresh, and `runtime` is static descriptor knowledge.
	 */
	discoveredModelsSource?: "probe" | "cache" | "runtime" | "none";
	/** Probe-only per-model load state keyed by wire model id. */
	discoveredModelStates?: Readonly<Record<string, ProbeModelStatus>> | null;
}

export interface ProvidersContract {
	/** All configured targets with readiness + health + capabilities. */
	list(): ReadonlyArray<TargetStatus>;

	/** Resolve an target by id. Null when the id is not in settings.targets. */
	getTarget(id: string): TargetDescriptor | null;

	/**
	 * Runtime descriptor by id. Null when the runtime is not registered (neither
	 * built-in nor loaded from ~/.config/clio-coder/runtimes/ nor an npm plugin).
	 */
	getRuntime(id: string): RuntimeDescriptor | null;

	/** Config-only readiness sweep. Does not hit the network. */
	probeAll(): Promise<void>;

	/** Live liveness + probeModels sweep. */
	probeAllLive(): Promise<void>;

	/**
	 * Probe a single target live. Null when the id is not in settings.targets.
	 * `reasoning: false` skips an inference-based reasoning-capability probe while
	 * retaining the target's liveness and model-catalog checks.
	 */
	probeTarget(id: string, options?: { reasoning?: boolean }): Promise<TargetStatus | null>;

	/** Clear in-memory live connection state for a configured target. */
	disconnectTarget(id: string): TargetStatus | null;

	/**
	 * Cached reasoning detection result for a given (target, wire model id).
	 * Returns true/false when a probe has populated the cache, null otherwise.
	 * Surfaces local-server reasoning capability that is per loaded model and
	 * cannot be inferred from runtime defaults alone.
	 */
	getDetectedReasoning(targetId: string, modelId: string): boolean | null;

	/**
	 * Probe an target's loaded model for reasoning support. Caches the result
	 * keyed by `(targetId, modelId)` and returns it. Null when the runtime
	 * lacks `probeReasoning`, the target is unknown, or the probe could not
	 * reach the server.
	 */
	probeReasoningForModel(targetId: string, modelId: string): Promise<boolean | null>;

	/**
	 * Shared auth access for both API keys and OAuth credentials. Provider ids
	 * default to runtime ids, with target-level overrides through
	 * `auth.apiKeyRef` / `auth.oauthProfile`.
	 */
	auth: {
		statusForTarget(target: TargetDescriptor, runtime: RuntimeDescriptor): AuthStatus;
		resolveForTarget(target: TargetDescriptor, runtime: RuntimeDescriptor): Promise<AuthResolution>;
		getStored(providerId: string): AuthCredential | null;
		listStored(): ReadonlyArray<{ providerId: string; type: AuthCredential["type"]; updatedAt: string }>;
		setApiKey(providerId: string, key: string): void;
		remove(providerId: string): void;
		login(providerId: string, callbacks: OAuthLoginCallbacks): Promise<void>;
		logout(providerId: string): void;
		/**
		 * Why the credentials store could not be fully read, or why the last write
		 * to it did not land, or null when it is clean.
		 *
		 * `setApiKey` and `login` throw only for the damaged-store refusal. Every
		 * other write failure is recorded here instead, and the in-memory store
		 * still hands the credential back, so a caller that reports success
		 * without asking claims a credential the file does not hold. Anything
		 * that writes must consult this immediately afterwards.
		 */
		damageReason(): string | null;
		getOAuthProviders(): ReadonlyArray<{ id: string; name: string }>;
		/**
		 * Install a process-lifetime API key override for the provider behind
		 * `target`. Used by the top-level `--api-key <key>` startup flag so a
		 * one-shot run can authenticate without persisting credentials.
		 */
		setRuntimeOverrideForTarget(target: TargetDescriptor, runtime: RuntimeDescriptor, key: string): void;
		clearRuntimeOverrideForTarget(target: TargetDescriptor, runtime: RuntimeDescriptor): void;
	};

	/**
	 * Model knowledge base used by chat-loop and overlays to synthesize pi-ai
	 * `Model<Api>` instances via `RuntimeDescriptor.synthesizeModel(target,
	 * wireModelId, kb)`. Null when the bundled YAMLs are unreadable at boot.
	 */
	knowledgeBase: KnowledgeBase | null;
}
