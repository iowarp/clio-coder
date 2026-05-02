import type { Api, Model } from "@mariozechner/pi-ai";

import type { CapabilityFlags } from "./capability-flags.js";
import type { EndpointDescriptor } from "./endpoint-descriptor.js";
import type { CompleteOptions, CompletionChunk, EmbedResult, InfillOptions, RerankResult } from "./inference.js";
import type { KnowledgeBaseHit } from "./knowledge-base.js";

export type RuntimeKind = "http" | "subprocess" | "sdk";
export type RuntimeTier =
	| "protocol"
	| "cloud"
	| "local-native"
	| "sdk"
	| "cli"
	| "cli-gold"
	| "cli-silver"
	| "cli-bronze";

export type RuntimeApiFamily =
	| "openai-completions"
	| "openai-responses"
	| "openai-codex-responses"
	| "azure-openai-responses"
	| "anthropic-messages"
	| "bedrock-converse-stream"
	| "google-generative-ai"
	| "google-gemini-cli"
	| "google-vertex"
	| "lmstudio-native"
	| "mistral-conversations"
	| "ollama-native"
	| "rerank-http"
	| "embeddings-http"
	| "claude-agent-sdk"
	| "subprocess-claude-code"
	| "subprocess-codex"
	| "subprocess-gemini"
	| "subprocess-copilot"
	| "subprocess-opencode";

export type RuntimeAuth = "api-key" | "oauth" | "aws-sdk" | "vertex-adc" | "cli" | "none";

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

export interface ProbeResult {
	ok: boolean;
	latencyMs?: number;
	error?: string;
	serverVersion?: string;
	models?: string[];
	discoveredCapabilities?: Partial<CapabilityFlags>;
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
	probe?(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<ProbeResult>;
	probeModels?(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<string[]>;
	/**
	 * Optional per-model reasoning capability probe. Protocol-compatible local
	 * servers (LM Studio, llama.cpp, Ollama, ...) advertise an OpenAI or
	 * Anthropic wire surface regardless of whether the loaded model supports
	 * thinking. Implementations here send a one-shot priming request and look at
	 * `reasoning_content` / `reasoning` / `reasoning_text` in the response.
	 * Result is cached per (endpoint, model) by the providers domain so
	 * /thinking can surface the correct level set.
	 */
	probeReasoning?(endpoint: EndpointDescriptor, modelId: string, ctx: ProbeContext): Promise<ReasoningProbeResult>;
	synthesizeModel(endpoint: EndpointDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api>;
	complete?(endpoint: EndpointDescriptor, opts: CompleteOptions, ctx: ProbeContext): AsyncIterable<CompletionChunk>;
	infill?(endpoint: EndpointDescriptor, opts: InfillOptions, ctx: ProbeContext): AsyncIterable<CompletionChunk>;
	embed?(endpoint: EndpointDescriptor, input: string | string[], ctx: ProbeContext): Promise<EmbedResult>;
	rerank?(endpoint: EndpointDescriptor, query: string, documents: string[], ctx: ProbeContext): Promise<RerankResult>;
}
