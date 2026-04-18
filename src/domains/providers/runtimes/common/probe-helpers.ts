import { probeHttp, probeJson } from "../../probe/http.js";
import type { ProbeContext, ProbeResult } from "../../types/runtime-descriptor.js";

export interface OpenAIModelsResponse {
	data?: Array<{ id?: unknown }>;
}

export async function probeUrl(
	url: string,
	ctx: ProbeContext,
	method: "GET" | "HEAD" = "GET",
): Promise<ProbeResult> {
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
