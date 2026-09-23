import { probeJson } from "../../probe/http.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";
import { synthesizeGoogleModel } from "../protocol/google.js";

const GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
/** One page holds every model the API serves today; the cap only bounds a runaway token chain. */
const MODELS_PAGE_SIZE = 1000;
const MAX_MODEL_PAGES = 10;

const defaultCapabilities: CapabilityFlags = {
	chat: true,
	tools: true,
	toolCallFormat: "openai",
	reasoning: true,
	vision: true,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	contextWindow: 2000000,
	maxTokens: 8192,
};

interface GeminiModelsPage {
	models?: Array<{ name?: unknown; displayName?: unknown; supportedGenerationMethods?: unknown }>;
	nextPageToken?: unknown;
}

function trimTrailingSlash(value: string): string {
	return value.endsWith("/") && value.length > 1 ? value.slice(0, -1) : value;
}

function resolveKey(target: TargetDescriptor, ctx: ProbeContext): string | undefined {
	if (ctx.authToken) return ctx.authToken;
	// pi-ai reads GEMINI_API_KEY at request time, so a key there serves requests and must list too.
	const names = target.auth?.apiKeyEnvVar ? [target.auth.apiKeyEnvVar] : ["GOOGLE_API_KEY", "GEMINI_API_KEY"];
	for (const name of names) {
		const value = process.env[name]?.trim();
		if (value) return value;
	}
	return undefined;
}

/** Whether the listing says this key can call the model for generation. */
function generates(methods: unknown): boolean {
	return Array.isArray(methods) && (methods.includes("generateContent") || methods.includes("streamGenerateContent"));
}

/**
 * The models this key can call for generation, from the Gemini API's own
 * listing. Embedding, AQA and media models answer other methods and are left
 * out. Nothing is sent without a key: the listing is per key, and an anonymous
 * request can only fail.
 */
async function listGenerativeModels(target: TargetDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
	const key = resolveKey(target, ctx);
	if (!key) {
		return { ok: false, failureKind: "missing", error: "no Gemini API key to list models with" };
	}
	const base = trimTrailingSlash(target.url ?? GOOGLE_BASE_URL);
	const headers = { ...(target.auth?.headers ?? {}), "x-goog-api-key": key };
	const models: string[] = [];
	const modelLabels: Record<string, string> = {};
	let latencyMs: number | undefined;
	let pageToken: string | undefined;
	for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
		const query = new URLSearchParams({ pageSize: String(MODELS_PAGE_SIZE) });
		if (pageToken) query.set("pageToken", pageToken);
		const opts = { url: `${base}/models?${query}`, timeoutMs: ctx.httpTimeoutMs, headers } as const;
		const result = await (ctx.signal
			? probeJson<GeminiModelsPage>({ ...opts, signal: ctx.signal })
			: probeJson<GeminiModelsPage>(opts));
		latencyMs ??= result.latencyMs;
		if (!result.ok) {
			// The API answers a key it does not accept with 400 API_KEY_INVALID, and one
			// without access with 401 or 403.
			const refused = result.status === 400 || result.status === 401 || result.status === 403;
			return refused
				? {
						ok: false,
						authFailed: true,
						failureKind: "authentication",
						error: `the Gemini API refused the key (${result.error})`,
						...(latencyMs !== undefined ? { latencyMs } : {}),
					}
				: {
						ok: false,
						error: result.error ?? "Gemini model listing failed",
						...(latencyMs !== undefined ? { latencyMs } : {}),
					};
		}
		for (const row of result.data?.models ?? []) {
			if (typeof row?.name !== "string" || !generates(row.supportedGenerationMethods)) continue;
			const id = row.name.replace(/^models\//u, "");
			if (id.length === 0 || models.includes(id)) continue;
			models.push(id);
			if (typeof row.displayName === "string" && row.displayName.length > 0) modelLabels[id] = row.displayName;
		}
		const next = result.data?.nextPageToken;
		pageToken = typeof next === "string" && next.length > 0 ? next : undefined;
		if (pageToken === undefined) break;
	}
	return {
		ok: true,
		models,
		...(Object.keys(modelLabels).length > 0 ? { modelLabels } : {}),
		...(latencyMs !== undefined ? { latencyMs } : {}),
	};
}

const googleRuntime: RuntimeDescriptor = {
	id: "google",
	displayName: "Google Generative AI",
	kind: "http",
	tier: "cloud",
	apiFamily: "google-generative-ai",
	auth: "api-key",
	credentialsEnvVar: "GOOGLE_API_KEY",
	defaultCapabilities,
	probe(target: TargetDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
		return listGenerativeModels(target, ctx);
	},
	synthesizeModel(target: TargetDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null) {
		return synthesizeGoogleModel({
			target,
			wireModelId,
			kb,
			defaultCapabilities,
			defaultBaseUrl: GOOGLE_BASE_URL,
		});
	},
};

export default googleRuntime;
