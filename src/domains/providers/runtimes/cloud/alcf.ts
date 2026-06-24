import type { Api, Model } from "@earendil-works/pi-ai";

import { probeJson } from "../../probe/http.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";
import { withAsIs } from "../common/local-synth.js";
import { synthesizeOpenAICompatModel } from "../protocol/openai-compat.js";

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
	contextWindow: 32768,
	maxTokens: 4096,
};

const KNOWN_MODELS: string[] = [
	"openai/gpt-oss-120b",
	"openai/gpt-oss-20b",
	"gpt-oss-120b",
	"meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
	"meta-llama/Llama-4-Scout-17B-16E-Instruct",
];

type AlcfCluster = string;

export function clusterFromUrl(url: string | undefined): AlcfCluster | null {
	if (!url) return null;
	const match = /\/resource_server\/([^/]+)\//.exec(url);
	return match ? (match[1] ?? null) : null;
}

export function frameworkForCluster(cluster: AlcfCluster): string {
	return cluster === "metis" ? "api" : "vllm";
}

interface CatalogPayload {
	clusters?: Record<string, { frameworks?: Record<string, { models?: unknown }> }>;
}

interface JobsPayload {
	running?: Array<{ Models?: unknown }>;
}

export function catalogModels(payload: CatalogPayload, cluster: string, framework: string): string[] {
	const models = payload.clusters?.[cluster]?.frameworks?.[framework]?.models;
	if (!Array.isArray(models)) return [];
	return models.map((model) => String(model).trim()).filter((model) => model.length > 0);
}

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

async function discover(target: TargetDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
	if (!target.url) return { ok: false, error: "ALCF target has no url" };
	const cluster = clusterFromUrl(target.url);
	if (!cluster) {
		return { ok: false, error: `cannot determine ALCF cluster from url ${target.url}` };
	}
	if (!ctx.authToken) {
		return { ok: false, error: "ALCF requires Globus auth; run `clio auth login alcf`." };
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
		const hint = reason.includes("401") ? " (token expired or rejected; run `clio auth login alcf` again)" : "";
		return {
			ok: false,
			error: `ALCF endpoint catalog unreachable: ${reason}${hint}`,
			...(catalog.latencyMs !== undefined ? { latencyMs: catalog.latencyMs } : {}),
		};
	}

	const fromCatalog = catalogModels(catalog.data, cluster, framework);
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
		// /jobs is enrichment only; catalog discovery is authoritative enough.
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
	probe(target: TargetDescriptor, ctx: ProbeContext): Promise<ProbeResult> {
		return discover(target, ctx);
	},
	async probeModels(target: TargetDescriptor, ctx: ProbeContext): Promise<string[]> {
		const result = await discover(target, ctx);
		return result.models ?? [];
	},
	synthesizeModel(target: TargetDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		const model = synthesizeOpenAICompatModel({
			target,
			wireModelId,
			kb,
			defaultCapabilities,
			apiFamily: "openai-completions",
			provider: "alcf",
			baseUrlForTarget: withAsIs,
		});
		const meta = (model as Model<Api> & { clio?: { chatTemplateKwargsUnsupported?: boolean } }).clio;
		if (meta) meta.chatTemplateKwargsUnsupported = true;
		return model;
	},
};

export default alcfRuntime;
