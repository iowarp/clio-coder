import type { Api, Model } from "@earendil-works/pi-ai";

import { probeJson } from "../../probe/http.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { EndpointDescriptor } from "../../types/endpoint-descriptor.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import { withAsIs } from "../common/local-synth.js";
import { synthesizeOpenAICompatModel } from "../protocol/openai-compat.js";

/**
 * ALCF (Argonne) inference gateway — Sophia + Metis.
 *
 * One runtime backs both clusters; they differ only by endpoint URL:
 *   Sophia: https://inference-api.alcf.anl.gov/resource_server/sophia/vllm/v1
 *   Metis:  https://inference-api.alcf.anl.gov/resource_server/metis/api/v1
 *
 * Both speak the OpenAI chat-completions wire format, so chat reuses the
 * generic openai-compat synthesis. Auth is a short-lived Globus bearer token
 * resolved by the "alcf" OAuth provider (see engine/alcf-oauth.ts); the runtime
 * never mints tokens itself — it receives the resolved bearer via
 * `ProbeContext.authToken` for discovery, and pi-ai attaches it for chat.
 *
 * Unlike clio-agent's LiteLLM port, no double-`openai/` prefix hack is needed:
 * pi-ai sends the wire model id literally, so a Sophia id like
 * `openai/gpt-oss-120b` is transmitted as-is.
 */

const CATALOG_URL = "https://inference-api.alcf.anl.gov/resource_server/list-endpoints";
const GATEWAY_ORIGIN = "https://inference-api.alcf.anl.gov/resource_server";

const defaultCapabilities: CapabilityFlags = {
	chat: true,
	tools: true,
	toolCallFormat: "openai",
	reasoning: true,
	vision: false,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	// Conservative cross-model defaults; the model knowledge base refines these
	// per wire model id (e.g. gpt-oss harmony reasoning, Llama-4 context).
	contextWindow: 32768,
	// ALCF gateway jobs reject very large generations; clio-agent capped at 4096.
	maxTokens: 4096,
};

/**
 * Static fallback model list (ported from clio-agent's `_ARGONNE_MODELS`).
 * Availability actually depends on running gateway jobs, surfaced by live
 * discovery; this list only seeds resolution before a probe runs. Sophia serves
 * `openai/`-prefixed ids; Metis serves bare ids.
 */
const KNOWN_MODELS: string[] = [
	"openai/gpt-oss-120b",
	"openai/gpt-oss-20b",
	"gpt-oss-120b",
	"meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
	"meta-llama/Llama-4-Scout-17B-16E-Instruct",
];

type AlcfCluster = string;

/** Extract the cluster segment from a gateway endpoint URL, or null. */
export function clusterFromUrl(url: string | undefined): AlcfCluster | null {
	if (!url) return null;
	const match = /\/resource_server\/([^/]+)\//.exec(url);
	return match ? (match[1] ?? null) : null;
}

/** Metis hangs the OpenAI-compatible surface off framework "api"; others use "vllm". */
export function frameworkForCluster(cluster: AlcfCluster): string {
	return cluster === "metis" ? "api" : "vllm";
}

interface CatalogPayload {
	clusters?: Record<string, { frameworks?: Record<string, { models?: unknown }> }>;
}

interface JobsPayload {
	running?: Array<{ Models?: unknown }>;
}

/** Models advertised for one cluster/framework in the endpoint catalog. */
export function catalogModels(payload: CatalogPayload, cluster: string, framework: string): string[] {
	const models = payload.clusters?.[cluster]?.frameworks?.[framework]?.models;
	if (!Array.isArray(models)) return [];
	return models.map((m) => String(m).trim()).filter((m) => m.length > 0);
}

/** Model ids reported as currently running by the /jobs endpoint. */
export function runningModels(payload: JobsPayload): string[] {
	const out: string[] = [];
	for (const job of payload.running ?? []) {
		for (const raw of String(job.Models ?? "").split(",")) {
			const id = raw.trim();
			if (id.length > 0) out.push(id);
		}
	}
	return out;
}

function dedupe(ids: ReadonlyArray<string>): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const id of ids) {
		if (seen.has(id)) continue;
		seen.add(id);
		out.push(id);
	}
	return out;
}

function authHeaders(ctx: ProbeContext): Record<string, string> {
	return { Authorization: `Bearer ${ctx.authToken}`, Accept: "application/json" };
}

async function discover(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
	if (!endpoint.url) return { ok: false, error: "ALCF endpoint has no url" };
	const cluster = clusterFromUrl(endpoint.url);
	if (!cluster) {
		return { ok: false, error: `cannot determine ALCF cluster from url ${endpoint.url}` };
	}
	if (!ctx.authToken) {
		return { ok: false, error: "ALCF requires Globus auth — run `clio auth login alcf`." };
	}
	const framework = frameworkForCluster(cluster);
	const headers = authHeaders(ctx);

	const catalog = await probeJson<CatalogPayload>({
		url: CATALOG_URL,
		headers,
		timeoutMs: ctx.httpTimeoutMs,
		...(ctx.signal ? { signal: ctx.signal } : {}),
	});
	if (!catalog.ok || !catalog.data) {
		const reason = catalog.error ?? "unknown error";
		const hint = reason.includes("401") ? " (token expired or rejected — run `clio auth login alcf` again)" : "";
		return {
			ok: false,
			error: `ALCF endpoint catalog unreachable: ${reason}${hint}`,
			...(catalog.latencyMs !== undefined ? { latencyMs: catalog.latencyMs } : {}),
		};
	}

	const fromCatalog = catalogModels(catalog.data, cluster, framework);

	// /jobs is best-effort enrichment: it confirms which models are live right
	// now, but a failure must not sink discovery (it can be slow/unavailable).
	let live: string[] = [];
	try {
		const jobs = await probeJson<JobsPayload>({
			url: `${GATEWAY_ORIGIN}/${cluster}/jobs`,
			headers,
			timeoutMs: Math.min(ctx.httpTimeoutMs, 12_000),
			...(ctx.signal ? { signal: ctx.signal } : {}),
		});
		if (jobs.ok && jobs.data) live = runningModels(jobs.data);
	} catch {
		// ignore — annotation only
	}

	const models = dedupe([...fromCatalog, ...live]);
	const result: ProbeResult = { ok: true, models };
	if (catalog.latencyMs !== undefined) result.latencyMs = catalog.latencyMs;
	if (models.length === 0) {
		result.notes = [`ALCF ${cluster}/${framework} reported no models; the gateway may have no running jobs.`];
	}
	return result;
}

const alcfRuntime: RuntimeDescriptor = {
	id: "alcf",
	displayName: "ALCF Inference (Globus)",
	kind: "http",
	tier: "cloud",
	apiFamily: "openai-completions",
	auth: "oauth",
	knownModels: KNOWN_MODELS,
	defaultCapabilities,
	async probe(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
		return discover(endpoint, ctx);
	},
	async probeModels(endpoint: EndpointDescriptor, ctx: ProbeContext): Promise<string[]> {
		const result = await discover(endpoint, ctx);
		return result.models ?? [];
	},
	synthesizeModel(endpoint: EndpointDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		const model = synthesizeOpenAICompatModel({
			endpoint,
			wireModelId,
			kb,
			defaultCapabilities,
			apiFamily: "openai-completions",
			provider: "alcf",
			// ALCF endpoint URLs already include the full `/.../v1` path, so use
			// them as-is rather than appending another `/v1`.
			baseUrlForEndpoint: withAsIs,
		});
		// The ALCF gateway validates request bodies strictly and rejects
		// `chat_template_kwargs` with HTTP 422 `extra_forbidden` (it accepts
		// top-level `reasoning_effort`). Harmony models (gpt-oss) would otherwise
		// have their effort templated into that field, so flag it for suppression.
		const meta = (model as Model<Api> & { clio?: Record<string, unknown> }).clio;
		if (meta) meta.chatTemplateKwargsUnsupported = true;
		return model;
	},
};

export default alcfRuntime;
