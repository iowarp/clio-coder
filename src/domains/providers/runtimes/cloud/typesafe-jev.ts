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
import type { DecideOptions, DecideResult, DecisionAnswer } from "../../types/inference.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";

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

interface TypeSafeDecideResponse {
	model?: unknown;
	answers?: Record<string, unknown>;
	usage?: { input_tokens?: unknown; output_tokens?: unknown };
}

function trimTrailingSlash(value: string): string {
	return value.endsWith("/") && value.length > 1 ? value.slice(0, -1) : value;
}

function targetBaseUrl(target: TargetDescriptor): string {
	return trimTrailingSlash(target.url ?? TYPESAFE_BASE_URL);
}

function authHeaders(target: TargetDescriptor, ctx: ProbeContext): Record<string, string> {
	const headers: Record<string, string> = { ...(target.auth?.headers ?? {}) };
	const envName = target.auth?.apiKeyEnvVar ?? "TYPESAFE_API_KEY";
	const key = ctx.authToken ?? (ctx.credentialsPresent.has(envName) ? process.env[envName]?.trim() : undefined);
	if (key) headers.authorization = `Bearer ${key}`;
	return headers;
}

function numberOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringMap(value: unknown): Record<string, string> | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const out: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string") out[key] = entry;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

function numberMap(value: unknown): Record<string, number> | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const out: Record<string, number> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "number" && Number.isFinite(entry)) out[key] = entry;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Narrow one wire answer. An answer whose `type` is unrecognised is dropped
 * rather than coerced: a caller gating on a decision must not receive a
 * silently defaulted one.
 */
function parseAnswer(raw: unknown): DecisionAnswer | null {
	if (typeof raw !== "object" || raw === null) return null;
	const row = raw as Record<string, unknown>;
	const type = row.type;
	if (type !== "noul" && type !== "choice" && type !== "score") return null;
	const answer: DecisionAnswer = { type };
	const noul = numberOrUndefined(row.noul);
	if (noul !== undefined) answer.noul = noul;
	if (typeof row.choice === "string") answer.choice = row.choice;
	const probabilities = numberMap(row.probabilities);
	if (probabilities) answer.probabilities = probabilities;
	const score = numberOrUndefined(row.score);
	if (score !== undefined) answer.score = score;
	const legend = stringMap(row.legend);
	if (legend) answer.legend = legend;
	const confidence = numberOrUndefined(row.confidence);
	if (confidence !== undefined) answer.confidence = confidence;
	return answer;
}

async function fetchModels(target: TargetDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
	const opts = {
		url: `${targetBaseUrl(target)}/models`,
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
	async decide(target: TargetDescriptor, opts: DecideOptions, ctx: ProbeContext): Promise<DecideResult> {
		const questionIds = Object.keys(opts.questions);
		if (questionIds.length === 0) throw new Error("decide() requires at least one question");
		const model = opts.model ?? target.defaultModel ?? DEFAULT_MODEL;
		const signal = opts.signal ?? ctx.signal;
		const request = {
			url: `${targetBaseUrl(target)}/systemone`,
			method: "POST" as const,
			timeoutMs: ctx.httpTimeoutMs,
			headers: { ...authHeaders(target, ctx), "content-type": "application/json" },
			body: JSON.stringify({ state: opts.state, model, questions: opts.questions }),
		};
		const response = await (signal
			? probeJson<TypeSafeDecideResponse>({ ...request, signal })
			: probeJson<TypeSafeDecideResponse>(request));
		if (!response.ok || !response.data) {
			throw new Error(`TypeSafe decide failed: ${response.error ?? "unknown"}`);
		}
		const answers: Record<string, DecisionAnswer> = {};
		for (const [id, raw] of Object.entries(response.data.answers ?? {})) {
			const parsed = parseAnswer(raw);
			if (parsed) answers[id] = parsed;
		}
		// A dropped or absent answer is a contract break, not a soft failure:
		// callers index by the ids they submitted.
		const missing = questionIds.filter((id) => !(id in answers));
		if (missing.length > 0) {
			throw new Error(`TypeSafe decide returned no usable answer for: ${missing.join(", ")}`);
		}
		const result: DecideResult = {
			model: typeof response.data.model === "string" ? response.data.model : model,
			answers,
		};
		const input = numberOrUndefined(response.data.usage?.input_tokens);
		const output = numberOrUndefined(response.data.usage?.output_tokens);
		if (input !== undefined && output !== undefined) result.tokensUsed = { input, output };
		return result;
	},
};

export default typesafeJevRuntime;
