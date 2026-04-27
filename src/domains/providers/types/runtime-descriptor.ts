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

export interface ProbeResult {
	ok: boolean;
	latencyMs?: number;
	error?: string;
	serverVersion?: string;
	models?: string[];
	discoveredCapabilities?: Partial<CapabilityFlags>;
	/**
	 * Free-form diagnostic notes from the probe. llama.cpp uses this to flag a
	 * mismatch between the configured wire model id and the server's loaded
	 * weights (single-model server, so there is no eviction recourse).
	 */
	notes?: ReadonlyArray<string>;
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
	probe?(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<ProbeResult>;
	probeModels?(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<string[]>;
	/**
	 * Optional per-model reasoning capability probe. Local servers (LM Studio,
	 * llama.cpp, ...) advertise themselves as openai-compatible regardless of
	 * whether the loaded model supports thinking. Implementations here send a
	 * one-shot priming request and look at `reasoning_content` / `reasoning` /
	 * `reasoning_text` in the response. Result is cached per (endpoint, model)
	 * by the providers domain so /thinking can surface the correct level set.
	 */
	probeReasoning?(endpoint: EndpointDescriptor, modelId: string, ctx: ProbeContext): Promise<ReasoningProbeResult>;
	synthesizeModel(endpoint: EndpointDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api>;
	complete?(endpoint: EndpointDescriptor, opts: CompleteOptions, ctx: ProbeContext): AsyncIterable<CompletionChunk>;
	infill?(endpoint: EndpointDescriptor, opts: InfillOptions, ctx: ProbeContext): AsyncIterable<CompletionChunk>;
	embed?(endpoint: EndpointDescriptor, input: string | string[], ctx: ProbeContext): Promise<EmbedResult>;
	rerank?(endpoint: EndpointDescriptor, query: string, documents: string[], ctx: ProbeContext): Promise<RerankResult>;
}
