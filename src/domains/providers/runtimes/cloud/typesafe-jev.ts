/**
 * TypeSafe Jev — a System One model. It does not generate text: it evaluates
 * closed-form questions against a body of state and returns a distribution over
 * the answer shape the caller declared. That makes it the substrate for the
 * harness's micro-decisions (intent classification, dispatch routing, evidence
 * provenance, memory-layer admission) where a chat model would be both slower
 * and unparseable.
 *
 * `chat` is false and the descriptor is hidden, so Jev never appears as a
 * conversational target; reach it through `RuntimeDescriptor.decide()`.
 */

import type { Api, Model } from "../../../../engine/types.js";

import { synthesizeCatalogBackedModel } from "../../catalog.js";
import { probeJson } from "../../probe/http.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { DecideOptions, DecideResult } from "../../types/inference.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";
import { postSystemOne, systemOneBaseUrl } from "../common/systemone-wire.js";

const TYPESAFE_BASE_URL = "https://api.typesafe.ai/v1";
const DEFAULT_MODEL = "jev-latest";

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
	// Jev reads state, not conversation. The window bounds one evidence blob.
	contextWindow: 32000,
	maxTokens: 0,
};

interface TypeSafeModelsResponse {
	models?: Array<{ name?: unknown; description?: unknown }>;
}

function authHeaders(target: TargetDescriptor, ctx: ProbeContext): Record<string, string> {
	const headers: Record<string, string> = { ...(target.auth?.headers ?? {}) };
	const envName = target.auth?.apiKeyEnvVar ?? "TYPESAFE_API_KEY";
	const key = ctx.authToken ?? (ctx.credentialsPresent.has(envName) ? process.env[envName]?.trim() : undefined);
	if (key) headers.authorization = `Bearer ${key}`;
	return headers;
}

async function fetchModels(target: TargetDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
	const opts = {
		url: `${systemOneBaseUrl(target, TYPESAFE_BASE_URL)}/models`,
		timeoutMs: ctx.httpTimeoutMs,
		headers: authHeaders(target, ctx),
	} as const;
	const result = await (ctx.signal
		? probeJson<TypeSafeModelsResponse>({ ...opts, signal: ctx.signal })
		: probeJson<TypeSafeModelsResponse>(opts));
	if (!result.ok) return result;
	const rows = result.data?.models ?? [];
	const models = rows
		.map((row) => (typeof row?.name === "string" ? row.name : null))
		.filter((id): id is string => id !== null);
	const modelLabels: Record<string, string> = {};
	for (const row of rows) {
		if (typeof row?.name === "string" && typeof row?.description === "string") modelLabels[row.name] = row.description;
	}
	const out: ProbeResult = { ok: true, models };
	if (result.latencyMs !== undefined) out.latencyMs = result.latencyMs;
	if (Object.keys(modelLabels).length > 0) out.modelLabels = modelLabels;
	const configured = target.defaultModel?.trim();
	if (configured && models.length > 0 && !models.includes(configured)) {
		out.ok = false;
		out.error = `configured model '${configured}' was not returned by TypeSafe`;
	}
	return out;
}

const typesafeJevRuntime: RuntimeDescriptor = {
	id: "typesafe-jev",
	displayName: "TypeSafe (Jev / System One)",
	kind: "http",
	tier: "cloud",
	apiFamily: "openai-completions",
	auth: "api-key",
	credentialsEnvVar: "TYPESAFE_API_KEY",
	knownModels: ["jev-latest", "jev-preview"],
	defaultCapabilities,
	// Not a conversational target; the configure wizard must not offer it.
	hidden: true,
	probe(target: TargetDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
		return fetchModels(target, ctx);
	},
	async probeModels(target: TargetDescriptor, ctx: ProbeContext): Promise<string[]> {
		const result = await fetchModels(target, ctx);
		return result.ok && result.models ? [...result.models] : [];
	},
	synthesizeModel(target: TargetDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		return synthesizeCatalogBackedModel({
			target,
			wireModelId,
			kb,
			defaultCapabilities,
			runtimeId: "typesafe-jev",
			api: "openai-completions",
			provider: "typesafe",
			defaultBaseUrl: TYPESAFE_BASE_URL,
		});
	},
	decide(target: TargetDescriptor, opts: DecideOptions, ctx: ProbeContext): Promise<DecideResult> {
		return postSystemOne(
			{
				baseUrl: systemOneBaseUrl(target, TYPESAFE_BASE_URL),
				headers: authHeaders(target, ctx),
				model: opts.model ?? target.defaultModel ?? DEFAULT_MODEL,
				label: "TypeSafe",
			},
			opts,
			ctx,
		);
	},
};

export default typesafeJevRuntime;
