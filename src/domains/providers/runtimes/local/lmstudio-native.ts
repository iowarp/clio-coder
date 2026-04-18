import type { Api, Model } from "@mariozechner/pi-ai";
import { LMStudioClient } from "@lmstudio/sdk";

import { mergeCapabilities } from "../../capabilities.js";
import { EMPTY_CAPABILITIES, type CapabilityFlags } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type {
	ProbeContext,
	ProbeResult,
	RuntimeDescriptor,
} from "../../types/runtime-descriptor.js";
import { stripTrailingSlash } from "../common/local-synth.js";

const defaultCapabilities: CapabilityFlags = {
	...EMPTY_CAPABILITIES,
	chat: true,
	tools: true,
	toolCallFormat: "openai",
	vision: true,
	structuredOutputs: "json-schema",
	contextWindow: 8192,
	maxTokens: 4096,
};

function toWebSocketUrl(url: string): string {
	const trimmed = stripTrailingSlash(url);
	if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) return trimmed;
	if (trimmed.startsWith("https://")) return `wss://${trimmed.slice("https://".length)}`;
	if (trimmed.startsWith("http://")) return `ws://${trimmed.slice("http://".length)}`;
	return `ws://${trimmed}`;
}

function buildClient(
	endpoint: EndpointDescriptor,
	ctx: ProbeContext,
): LMStudioClient | { error: string } {
	if (!endpoint.url) return { error: "endpoint has no url" };
	try {
		const opts: ConstructorParameters<typeof LMStudioClient>[0] = {
			baseUrl: toWebSocketUrl(endpoint.url),
		};
		const auth = endpoint.auth;
		const envName = auth?.apiKeyEnvVar;
		if (envName && ctx.credentialsPresent.has(envName)) {
			const value = process.env[envName];
			if (value) opts.clientPasskey = value;
		}
		return new LMStudioClient(opts);
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

async function withTimeout<T>(task: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error("aborted by caller"));
		};
		if (signal) {
			if (signal.aborted) {
				clearTimeout(timer);
				reject(new Error("aborted by caller"));
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}
		task
			.then((value) => {
				clearTimeout(timer);
				if (signal) signal.removeEventListener("abort", onAbort);
				resolve(value);
			})
			.catch((err) => {
				clearTimeout(timer);
				if (signal) signal.removeEventListener("abort", onAbort);
				reject(err);
			});
	});
}

const lmstudioNativeRuntime: RuntimeDescriptor = {
	id: "lmstudio-native",
	displayName: "LM Studio (native SDK)",
	kind: "http",
	apiFamily: "lmstudio-native",
	auth: "api-key",
	defaultCapabilities,
	async probe(endpoint, ctx): Promise<ProbeResult> {
		const built = buildClient(endpoint, ctx);
		if ("error" in built) return { ok: false, error: built.error };
		const client = built;
		const started = Date.now();
		try {
			const version = await withTimeout(
				client.system.getLMStudioVersion(),
				ctx.httpTimeoutMs,
				ctx.signal,
			);
			const latencyMs = Date.now() - started;
			return { ok: true, latencyMs, serverVersion: version.version };
		} catch (err) {
			return {
				ok: false,
				latencyMs: Date.now() - started,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	},
	async probeModels(endpoint, ctx): Promise<string[]> {
		const built = buildClient(endpoint, ctx);
		if ("error" in built) return [];
		const client = built;
		try {
			const [downloaded, loaded] = await Promise.all([
				withTimeout(client.system.listDownloadedModels("llm"), ctx.httpTimeoutMs, ctx.signal),
				withTimeout(client.llm.listLoaded(), ctx.httpTimeoutMs, ctx.signal),
			]);
			const keys = new Set<string>();
			for (const info of downloaded) keys.add(info.modelKey);
			for (const llm of loaded) keys.add(llm.modelKey);
			return [...keys];
		} catch {
			return [];
		}
	},
	synthesizeModel(
		endpoint: EndpointDescriptor,
		wireModelId: string,
		kb: KnowledgeBaseHit | null,
	): Model<Api> {
		const caps = mergeCapabilities(
			defaultCapabilities,
			kb?.entry.capabilities ?? null,
			null,
			endpoint.capabilities ?? null,
		);
		const baseUrl = endpoint.url ? toWebSocketUrl(endpoint.url) : "";
		const pricing = endpoint.pricing;
		const model: Model<Api> = {
			id: wireModelId,
			name: `${wireModelId} (${endpoint.id})`,
			api: "lmstudio-native",
			provider: "lmstudio",
			baseUrl,
			reasoning: caps.reasoning,
			input: caps.vision ? ["text", "image"] : ["text"],
			cost: {
				input: pricing?.input ?? 0,
				output: pricing?.output ?? 0,
				cacheRead: pricing?.cacheRead ?? 0,
				cacheWrite: pricing?.cacheWrite ?? 0,
			},
			contextWindow: caps.contextWindow,
			maxTokens: caps.maxTokens,
		};
		const headers = endpoint.auth?.headers;
		if (headers) model.headers = headers;
		return model;
	},
};

export default lmstudioNativeRuntime;
