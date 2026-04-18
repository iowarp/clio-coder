import type { Api, Model } from "@mariozechner/pi-ai";

import type { CapabilityFlags } from "./capability-flags.js";
import type { EndpointDescriptor } from "./endpoint-descriptor.js";
import type { KnowledgeBaseHit } from "./knowledge-base.js";

export type RuntimeKind = "http" | "subprocess";

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
	| "subprocess-claude-code"
	| "subprocess-codex"
	| "subprocess-gemini";

export type RuntimeAuth = "api-key" | "oauth" | "aws-sdk" | "vertex-adc" | "none";

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
}

export interface RuntimeDescriptor {
	id: string;
	displayName: string;
	kind: RuntimeKind;
	apiFamily: RuntimeApiFamily;
	auth: RuntimeAuth;
	credentialsEnvVar?: string;
	defaultCapabilities: CapabilityFlags;
	probe?(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<ProbeResult>;
	probeModels?(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<string[]>;
	synthesizeModel(
		endpoint: EndpointDescriptor,
		wireModelId: string,
		kb: KnowledgeBaseHit | null,
	): Model<Api>;
}
