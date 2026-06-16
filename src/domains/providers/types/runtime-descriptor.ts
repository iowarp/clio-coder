import type { Api, Model } from "@earendil-works/pi-ai";

import type { CapabilityFlags } from "./capability-flags.js";
import type { CompleteOptions, CompletionChunk, EmbedResult, InfillOptions, RerankResult } from "./inference.js";
import type { KnowledgeBaseHit } from "./knowledge-base.js";
import type { TargetDescriptor } from "./target-descriptor.js";

export type RuntimeKind = "http" | "sdk" | "subprocess";
export type RuntimeTier = "protocol" | "cloud" | "local-native" | "subscription";

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
	| "embeddings-http"
	| "claude-agent-sdk"
	| "claude-code-subprocess";

export type RuntimeAuth = "api-key" | "oauth" | "aws-sdk" | "vertex-adc" | "claude-cli" | "none";

export interface ProbeContext {
	credentialsPresent: ReadonlySet<string>;
	httpTimeoutMs: number;
	signal?: AbortSignal;
}

/**
 * Map of which inference surfaces a probe found at the target.
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
	/**
	 * Resident footprint reported by the runtime when a model is loaded. Ollama
	 * exposes both via `/api/ps` (`size_vram` is the GPU-resident portion,
	 * `size` the total). Captured here so the picker and any future VRAM-fit
	 * hinting have a real number to work with instead of re-probing.
	 */
	sizeVramBytes?: number;
	sizeBytes?: number;
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
	/**
	 * pi-ai OAuth provider id backing this runtime when `auth === "oauth"` and it
	 * differs from `id`. `openai-codex` omits this because its registry id, target
	 * `oauthProfile`, and pi-ai provider id all coincide. The Claude Pro/Max
	 * runtime sets this to `"anthropic"` so login/refresh/credential storage key
	 * on the pi-ai `anthropic` OAuth provider while keeping a distinct registry id
	 * (`anthropic-max`) from the api-key `anthropic` runtime.
	 */
	oauthProviderId?: string;
	/**
	 * Optional one-line notice printed before an interactive `clio auth login` or
	 * configure connect for this runtime. Used to surface subscription usage-terms
	 * considerations so OAuth subscription paths are an explicit, informed opt-in.
	 */
	authNotice?: string;
	knownModels?: string[];
	binaryName?: string;
	defaultBinaryPath?: string;
	headlessCommand?: string;
	outputParser?: string;
	defaultCapabilities: CapabilityFlags;
	/**
	 * When true, this id is a real, distinct runtime (e.g. `llamacpp-anthropic`,
	 * the Anthropic Messages surface on llama.cpp, or the embed/rerank runtimes)
	 * that stays resolvable by id but is hidden from `clio configure --list` and
	 * the interactive wizard, where a composite descriptor owns the
	 * user-visible slot.
	 */
	hidden?: boolean;
	probe?(target: TargetDescriptor, ctx: ProbeContext): Promise<ProbeResult>;
	probeModels?(target: TargetDescriptor, ctx: ProbeContext): Promise<string[]>;
	/**
	 * Optional per-model reasoning capability probe. Protocol-compatible local
	 * servers (LM Studio, llama.cpp, Ollama, ...) advertise an OpenAI or
	 * Anthropic wire surface regardless of whether the loaded model supports
	 * thinking. Implementations here send a one-shot priming request and look at
	 * `reasoning_content` / `reasoning` / `reasoning_text` in the response.
	 * Result is cached per (target, model) by the providers domain so
	 * /thinking can surface the correct level set.
	 */
	probeReasoning?(target: TargetDescriptor, modelId: string, ctx: ProbeContext): Promise<ReasoningProbeResult>;
	synthesizeModel(target: TargetDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api>;
	complete?(target: TargetDescriptor, opts: CompleteOptions, ctx: ProbeContext): AsyncIterable<CompletionChunk>;
	infill?(target: TargetDescriptor, opts: InfillOptions, ctx: ProbeContext): AsyncIterable<CompletionChunk>;
	embed?(target: TargetDescriptor, input: string | string[], ctx: ProbeContext): Promise<EmbedResult>;
	rerank?(target: TargetDescriptor, query: string, documents: string[], ctx: ProbeContext): Promise<RerankResult>;
}
