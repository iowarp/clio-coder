import type { Api, Model } from "@earendil-works/pi-ai";

import type { CapabilityFlags } from "./capability-flags.js";
import type { CompleteOptions, CompletionChunk, EmbedResult, InfillOptions, RerankResult } from "./inference.js";
import type { KnowledgeBaseHit } from "./knowledge-base.js";
import type { TargetDescriptor } from "./target-descriptor.js";

export type RuntimeKind = "http";
export type RuntimeTier = "protocol" | "cloud" | "local-native";

export type RuntimeApiFamily =
	| "openai-completions"
	| "openai-responses"
	| "openai-codex-responses"
	| "azure-openai-responses"
	| "anthropic-messages"
	| "bedrock-converse-stream"
	| "google-generative-ai"
	| "google-vertex"
	| "lmstudio-native"
	| "mistral-conversations"
	| "ollama-native"
	| "rerank-http"
	| "embeddings-http";

export type RuntimeAuth = "api-key" | "oauth" | "aws-sdk" | "vertex-adc" | "none";

export interface ProbeContext {
	credentialsPresent: ReadonlySet<string>;
	httpTimeoutMs: number;
	signal?: AbortSignal;
}

/**
 * Map of which inference surfaces a probe found at the endpoint.
 * Composite local descriptors (llamacpp, lemonade) populate this from a
 * batched HEAD/GET sweep; fields are absent when the surface did not respond.
 * Values are the path the probe used so callers can cite it in errors.
 */
export interface ProbeSurfaceMap {
	anthropicMessages?: string;
	openaiChat?: string;
	embeddings?: string;
	rerank?: string;
	completion?: string;
	infill?: string;
}

export type ProbeModelLoadState = "loaded" | "loading" | "unloaded" | "failed" | "unknown";

export interface ProbeModelStatus {
	state: ProbeModelLoadState;
	detail?: string;
}

export interface ProbeResult {
	ok: boolean;
	latencyMs?: number;
	error?: string;
	serverVersion?: string;
	models?: string[];
	/** Probe-only per-model load state when the runtime exposes it. */
	modelStates?: Record<string, ProbeModelStatus>;
	discoveredCapabilities?: Partial<CapabilityFlags>;
	/** Probe-only capabilities keyed by wire model id when a runtime can list model metadata. */
	modelCapabilities?: Record<string, Partial<CapabilityFlags>>;
	/** Wire model id those discovered capabilities describe, when known. */
	capabilityModelId?: string;
	/**
	 * Free-form diagnostic notes from the probe. llama.cpp uses this to flag a
	 * mismatch between the configured wire model id and the server's loaded
	 * weights (single-model server, so there is no eviction recourse).
	 */
	notes?: ReadonlyArray<string>;
	/**
	 * Composite descriptors set this to the api family they will use for chat.
	 * `synthesizeModel` reads it back out of the cached probe state to choose
	 * which provider implementation pi-ai routes to. Absent when the descriptor
	 * is single-surface or no chat surface was reachable.
	 */
	chatApiFamily?: RuntimeApiFamily;
	surfaces?: ProbeSurfaceMap;
}

export interface ReasoningProbeResult {
	reasoning: boolean;
	latencyMs: number;
	error?: string;
}

export interface RuntimeDescriptor {
	id: string;
	displayName: string;
	kind: RuntimeKind;
	tier?: RuntimeTier;
	apiFamily: RuntimeApiFamily;
	auth: RuntimeAuth;
	credentialsEnvVar?: string;
	knownModels?: string[];
	binaryName?: string;
	defaultBinaryPath?: string;
	headlessCommand?: string;
	outputParser?: string;
	defaultCapabilities: CapabilityFlags;
	/**
	 * When true, this id stays in the registry for back-compat resolution but
	 * is hidden from `clio configure --list` and the interactive wizard. Used
	 * for legacy surface-specific aliases (e.g. `llamacpp-anthropic`) after a
	 * composite descriptor takes over the user-visible slot.
	 */
	hidden?: boolean;
	probe?(endpoint: TargetDescriptor, ctx: ProbeContext): Promise<ProbeResult>;
	probeModels?(endpoint: TargetDescriptor, ctx: ProbeContext): Promise<string[]>;
	/**
	 * Optional per-model reasoning capability probe. Protocol-compatible local
	 * servers (LM Studio, llama.cpp, Ollama, ...) advertise an OpenAI or
	 * Anthropic wire surface regardless of whether the loaded model supports
	 * thinking. Implementations here send a one-shot priming request and look at
	 * `reasoning_content` / `reasoning` / `reasoning_text` in the response.
	 * Result is cached per (endpoint, model) by the providers domain so
	 * /thinking can surface the correct level set.
	 */
	probeReasoning?(endpoint: TargetDescriptor, modelId: string, ctx: ProbeContext): Promise<ReasoningProbeResult>;
	synthesizeModel(endpoint: TargetDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api>;
	complete?(endpoint: TargetDescriptor, opts: CompleteOptions, ctx: ProbeContext): AsyncIterable<CompletionChunk>;
	infill?(endpoint: TargetDescriptor, opts: InfillOptions, ctx: ProbeContext): AsyncIterable<CompletionChunk>;
	embed?(endpoint: TargetDescriptor, input: string | string[], ctx: ProbeContext): Promise<EmbedResult>;
	rerank?(endpoint: TargetDescriptor, query: string, documents: string[], ctx: ProbeContext): Promise<RerankResult>;
}
