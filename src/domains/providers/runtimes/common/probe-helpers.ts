import { probeHttp, probeJson } from "../../probe/http.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { ProbeContext, ProbeResult } from "../../types/runtime-descriptor.js";

export interface OpenAIModelsResponse {
	data?: Array<{ id?: unknown }>;
}

export async function probeUrl(url: string, ctx: ProbeContext, method: "GET" | "HEAD" = "GET"): Promise<ProbeResult> {
	const base = { url, timeoutMs: ctx.httpTimeoutMs, method } as const;
	return ctx.signal ? probeHttp({ ...base, signal: ctx.signal }) : probeHttp(base);
}

export async function probeOpenAIModels(base: string, ctx: ProbeContext): Promise<string[]> {
	const opts = { url: `${base}/v1/models`, timeoutMs: ctx.httpTimeoutMs } as const;
	const result = await (ctx.signal
		? probeJson<OpenAIModelsResponse>({ ...opts, signal: ctx.signal })
		: probeJson<OpenAIModelsResponse>(opts));
	if (!result.ok || !result.data?.data) return [];
	return result.data.data
		.map((row) => (typeof row?.id === "string" ? row.id : null))
		.filter((id): id is string => id !== null);
}

interface LlamaCppProps {
	default_generation_settings?: { n_ctx?: unknown; n_predict?: unknown };
	modalities?: { vision?: unknown };
	build_info?: unknown;
}

export interface LlamaCppPropsEnrichment {
	discoveredCapabilities?: Partial<CapabilityFlags>;
	serverVersion?: string;
}

/**
 * llama.cpp serves a single fixed model per process. Compare the configured
 * wire model id against `/v1/models` so a mismatch surfaces as a probe note
 * instead of producing 404s or, worse, silent serves from the wrong weights.
 * Returns null when the comparison is inconclusive (probe failed, no default
 * model configured, server returned nothing).
 */
export async function detectModelMismatch(
	base: string,
	endpoint: EndpointDescriptor,
	ctx: ProbeContext,
): Promise<string | null> {
	const expected = endpoint.defaultModel?.trim();
	if (!expected) return null;
	const ids = await probeOpenAIModels(base, ctx);
	if (ids.length === 0) return null;
	if (ids.includes(expected)) return null;
	const loaded = ids[0] ?? "(unknown)";
	return `wire model id ${expected} does not match server's loaded model ${loaded}; llama.cpp serves a single fixed model`;
}

export async function probeLlamaCppProps(base: string, ctx: ProbeContext): Promise<LlamaCppPropsEnrichment> {
	const opts = { url: `${base}/props`, timeoutMs: ctx.httpTimeoutMs } as const;
	const result = await (ctx.signal
		? probeJson<LlamaCppProps>({ ...opts, signal: ctx.signal })
		: probeJson<LlamaCppProps>(opts));
	if (!result.ok || !result.data) return {};
	const data = result.data;
	const enrichment: LlamaCppPropsEnrichment = {};
	const caps: Partial<CapabilityFlags> = {};
	const nCtx = data.default_generation_settings?.n_ctx;
	if (typeof nCtx === "number" && nCtx > 0) caps.contextWindow = nCtx;
	const nPredict = data.default_generation_settings?.n_predict;
	if (typeof nPredict === "number" && nPredict > 0) caps.maxTokens = nPredict;
	const vision = data.modalities?.vision;
	if (typeof vision === "boolean") caps.vision = vision;
	if (Object.keys(caps).length > 0) enrichment.discoveredCapabilities = caps;
	if (typeof data.build_info === "string" && data.build_info.length > 0) {
		enrichment.serverVersion = data.build_info;
	}
	return enrichment;
}
