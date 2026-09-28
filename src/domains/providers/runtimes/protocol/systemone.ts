/**
 * A self-hosted System One server: anything that answers `POST /v1/systemone`
 * the way TypeSafe's Jev does, such as `laya-serve` or `clm-serve`.
 *
 * `typesafe-jev` reached these servers only by accident. It is cloud tier,
 * reads `TYPESAFE_API_KEY`, asks for `jev-latest` when no model is set (CLM
 * answers that with 422) and probes `/models` (Laya has no such route). This
 * runtime sends a model only when one is configured, needs no key, and
 * accepts a `/health` answer as a live server.
 *
 * The default decision window is small on purpose. These servers truncate
 * oversized state silently (Laya keeps the head, CLM the tail), and the
 * smallest known checkpoint reads 512 tokens including its options. Too small
 * a window only makes a site abstain; too large a one lets a server answer a
 * question about evidence it never read. Raise `capabilities.contextWindow` to
 * what the served checkpoint actually reads.
 */

import type { Api, Model } from "../../../../engine/types.js";
import { probeJson } from "../../probe/http.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { DecideOptions, DecideResult } from "../../types/inference.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";
import { synthLocalModel, withAsIs } from "../common/local-synth.js";
import { postSystemOne, systemOneBaseUrl } from "../common/systemone-wire.js";

const defaultCapabilities: CapabilityFlags = {
	chat: false,
	tools: false,
	reasoning: false,
	vision: false,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	decisions: true,
	contextWindow: 480,
	maxTokens: 0,
};

function authHeaders(target: TargetDescriptor, ctx: ProbeContext): Record<string, string> {
	const headers: Record<string, string> = { ...(target.auth?.headers ?? {}) };
	const envName = target.auth?.apiKeyEnvVar;
	const key =
		ctx.authToken ??
		(envName !== undefined && ctx.credentialsPresent.has(envName) ? process.env[envName]?.trim() : undefined);
	if (key) headers.authorization = `Bearer ${key}`;
	return headers;
}

function baseUrl(target: TargetDescriptor): string | null {
	if (!target.url) return null;
	return systemOneBaseUrl(target, target.url);
}

async function probe(target: TargetDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
	const base = baseUrl(target);
	if (base === null) return { ok: false, error: `systemone target '${target.id}' needs a url` };
	const headers = authHeaders(target, ctx);
	const get = <T>(url: string) => {
		const opts = { url, timeoutMs: ctx.httpTimeoutMs, headers } as const;
		return ctx.signal ? probeJson<T>({ ...opts, signal: ctx.signal }) : probeJson<T>(opts);
	};
	const configured = [...(target.wireModels ?? []), ...(target.defaultModel ? [target.defaultModel] : [])];
	const listed = await get<{ models?: Array<{ name?: unknown }> }>(`${base}/models`);
	if (listed.ok) {
		const models = (listed.data?.models ?? [])
			.map((row) => (typeof row?.name === "string" ? row.name : null))
			.filter((id): id is string => id !== null);
		const out: ProbeResult = { ok: true, models: models.length > 0 ? models : [...new Set(configured)] };
		if (listed.latencyMs !== undefined) out.latencyMs = listed.latencyMs;
		return out;
	}
	// laya-serve lists no models; its liveness route sits at the server root.
	const root = base.endsWith("/v1") ? base.slice(0, -"/v1".length) : base;
	const health = await get<unknown>(`${root}/health`);
	if (!health.ok) return health;
	const out: ProbeResult = { ok: true, models: [...new Set(configured)] };
	if (health.latencyMs !== undefined) out.latencyMs = health.latencyMs;
	return out;
}

const systemOneRuntime: RuntimeDescriptor = {
	id: "systemone",
	displayName: "System One server (experimental)",
	kind: "http",
	tier: "protocol",
	apiFamily: "openai-completions",
	auth: "api-key",
	knownModels: [],
	defaultCapabilities,
	// Not a conversational target; the configure wizard must not offer it as one.
	hidden: true,
	probe,
	async probeModels(target: TargetDescriptor, ctx: ProbeContext): Promise<string[]> {
		const result = await probe(target, ctx);
		return result.ok && result.models ? [...result.models] : [];
	},
	synthesizeModel(target: TargetDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		return synthLocalModel({
			target,
			wireModelId,
			kb,
			defaultCapabilities,
			apiFamily: "openai-completions",
			provider: "systemone",
			baseUrlForTarget: withAsIs,
		});
	},
	decide(target: TargetDescriptor, opts: DecideOptions, ctx: ProbeContext): Promise<DecideResult> {
		const base = baseUrl(target);
		if (base === null) return Promise.reject(new Error(`systemone target '${target.id}' needs a url`));
		return postSystemOne(
			{
				baseUrl: base,
				headers: authHeaders(target, ctx),
				model: opts.model ?? target.defaultModel,
				label: `System One (${target.id})`,
			},
			opts,
			ctx,
		);
	},
};

export default systemOneRuntime;
