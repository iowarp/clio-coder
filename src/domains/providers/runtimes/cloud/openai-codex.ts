import { performance } from "node:perf_hooks";
import type { Api, Model } from "../../../../engine/types.js";
import { synthesizeCatalogBackedModel } from "../../catalog.js";
import { probeJson } from "../../probe/http.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, ProbeModelStatus, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";

const defaultCapabilities: CapabilityFlags = {
	chat: true,
	tools: true,
	toolCallFormat: "openai",
	reasoning: true,
	thinkingFormat: "openai-codex",
	vision: true,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	contextWindow: 272000,
	maxTokens: 16384,
};

const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";

/**
 * The models endpoint lists only models whose `minimal_client_version` is at
 * most the `client_version` it is given, so this is the Codex protocol level
 * Clio's transport is verified against. Pi's transport declares no version of
 * its own and pi-ai's release number is not a Codex level: checked 2026-09-29,
 * 0.156.0 lists the gpt-6 models with their windows and 0.87.1 lists none.
 * Re-verify it whenever pi-ai is upgraded.
 */
export const CODEX_BACKEND_CLIENT_VERSION = "0.156.0";

/**
 * One models response is ~500 KB (each row carries the model's full prompt),
 * arrives `no-store`, and ignores `If-None-Match`. The parsed windows are reused
 * only long enough to coalesce the back-to-back reads of a probe pass, and stay
 * well inside the 30 s route TTL (TARGET_PROBE_TTL_MS in interactive/turn-runtime.ts),
 * so a server-side change shows at the next route re-probe.
 */
const MODELS_REUSE_MS = 5_000;

interface CodexModelsResponse {
	models?: ReadonlyArray<{ slug?: unknown; context_window?: unknown; max_context_window?: unknown } | null>;
}

interface CodexWindows {
	modelCapabilities: Record<string, Partial<CapabilityFlags>>;
	modelStates: Record<string, ProbeModelStatus>;
}

/** `${base}/codex/models`, resolving the same base spellings the responses transport accepts. */
function codexModelsUrl(baseUrl: string | undefined): string {
	const raw = baseUrl && baseUrl.trim().length > 0 ? baseUrl : DEFAULT_BASE_URL;
	let base = raw.replace(/\/+$/u, "");
	if (base.endsWith("/codex/responses")) base = base.slice(0, -"/responses".length);
	if (!base.endsWith("/codex")) base = `${base}/codex`;
	return `${base}/models?client_version=${CODEX_BACKEND_CLIENT_VERSION}`;
}

/** The ChatGPT account id the access token carries, which the backend requires as a header. */
function chatgptAccountId(token: string): string | null {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as unknown;
		const claim = (payload as { "https://api.openai.com/auth"?: { chatgpt_account_id?: unknown } } | null)?.[
			"https://api.openai.com/auth"
		];
		return typeof claim?.chatgpt_account_id === "string" && claim.chatgpt_account_id.length > 0
			? claim.chatgpt_account_id
			: null;
	} catch {
		// A token that is not a JWT has no account claim; the caller reports the missing id.
		return null;
	}
}

function positiveInteger(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/**
 * `context_window` is the window the backend serves a request by default and
 * `max_context_window` the most a client may ask for. The Codex CLI's own
 * `model_context_window` log line applies a client-side 95% to the first; that
 * margin is the CLI's, absent from the response, and not taken here.
 */
function windowsFromModels(response: CodexModelsResponse): CodexWindows {
	const windows: CodexWindows = { modelCapabilities: {}, modelStates: {} };
	for (const row of response.models ?? []) {
		if (typeof row?.slug !== "string" || row.slug.length === 0) continue;
		const serving = positiveInteger(row.context_window);
		const maximum = positiveInteger(row.max_context_window);
		if (serving !== undefined) windows.modelCapabilities[row.slug] = { contextWindow: serving };
		if (maximum !== undefined) windows.modelStates[row.slug] = { state: "unknown", modelMaxContextLength: maximum };
	}
	return windows;
}

async function readWindows(
	url: string,
	token: string,
	accountId: string,
	timeoutMs: number,
): Promise<{ result: ProbeResult; reusable: boolean }> {
	const response = await probeJson<CodexModelsResponse>({
		url,
		headers: { Authorization: `Bearer ${token}`, "chatgpt-account-id": accountId, accept: "application/json" },
		timeoutMs,
	});
	const latency = response.latencyMs !== undefined ? { latencyMs: response.latencyMs } : {};
	if (!response.ok || !response.data) {
		return {
			result: { ok: false, error: response.error ?? "the models endpoint returned no body", ...latency },
			reusable: false,
		};
	}
	const windows = windowsFromModels(response.data);
	if (Object.keys(windows.modelCapabilities).length === 0) {
		return {
			result: { ok: true, notes: ["The Codex models endpoint listed no model with a context window."], ...latency },
			reusable: false,
		};
	}
	return { result: { ok: true, ...latency, ...windows }, reusable: true };
}

/** Rejects with the caller's abort reason while the shared read it joined keeps running for the others. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) return promise;
	signal.throwIfAborted();
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

export interface CodexWindowReaderOptions {
	/** Monotonic clock in ms; the reuse span is measured on it. */
	now?: () => number;
	reuseMs?: number;
}

/**
 * A reader keeps its own reuse and in-flight state, so the runtime descriptor
 * owns one and a test owns another with a controlled clock.
 */
export function createCodexServingWindowReader(
	options: CodexWindowReaderOptions = {},
): (target: TargetDescriptor, ctx: ProbeContext) => Promise<ProbeResult> {
	const now = options.now ?? (() => performance.now());
	const reuseMs = options.reuseMs ?? MODELS_REUSE_MS;
	const reusable = new Map<string, { at: number; result: ProbeResult }>();
	const inFlight = new Map<string, Promise<ProbeResult>>();

	return async (target, ctx) => {
		const token = ctx.authToken;
		if (!token) return { ok: false, error: "no OpenAI Codex login; run clio-coder auth login openai-codex" };
		const accountId = chatgptAccountId(token);
		if (!accountId) return { ok: false, error: "the OpenAI Codex login carries no ChatGPT account id" };
		const url = codexModelsUrl(target.url);
		const key = `${url}\0${accountId}`;
		const held = reusable.get(key);
		if (held && now() - held.at < reuseMs) return structuredClone(held.result);

		let read = inFlight.get(key);
		if (!read) {
			read = readWindows(url, token, accountId, ctx.httpTimeoutMs)
				.then(({ result, reusable: keep }) => {
					// A failed or empty read never extends an earlier window claim.
					if (keep) reusable.set(key, { at: now(), result });
					else reusable.delete(key);
					return result;
				})
				.finally(() => inFlight.delete(key));
			inFlight.set(key, read);
		}
		return structuredClone(await untilAborted(read, ctx.signal));
	};
}

const openaiCodexRuntime: RuntimeDescriptor = {
	id: "openai-codex",
	displayName: "OpenAI Codex",
	kind: "http",
	tier: "cloud",
	apiFamily: "openai-codex-responses",
	auth: "oauth",
	defaultCapabilities,
	probeServingWindows: createCodexServingWindowReader(),
	synthesizeModel(target: TargetDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		return synthesizeCatalogBackedModel({
			target,
			wireModelId,
			kb,
			defaultCapabilities,
			runtimeId: "openai-codex",
			api: "openai-codex-responses",
			provider: "openai-codex",
			defaultBaseUrl: DEFAULT_BASE_URL,
		});
	},
};

export default openaiCodexRuntime;
