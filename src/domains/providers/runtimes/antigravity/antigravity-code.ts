import { boundedExternalDiagnostic } from "../../../../core/external-diagnostic.js";
import { runCommandVector, type SafeCommandResult } from "../../../../core/safe-exec.js";
import type { Api, Model } from "../../../../engine/types.js";

import { synthesizeCatalogBackedModel } from "../../catalog.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";

/**
 * Antigravity CLI (`agy`) external delegation runtime.
 *
 * This is deliberately a dispatch-only subprocess, not a Gemini inference
 * provider. The installed official CLI owns authentication, its agent loop,
 * tools, network access, and model access. Clio supplies one bounded work order
 * and translates the documented structured result into a worker result.
 */

export const ANTIGRAVITY_AUTH_NOTICE =
	"Experimental local delegation through your installed Antigravity (`agy`) CLI. Clio neither signs in nor stores " +
	"or inspects Antigravity credentials. Run `agy` yourself and complete sign-in before probing this target.";

// Hints only until an account returns a live catalog. They are never used to
// validate a model after a successful live probe.
export const ANTIGRAVITY_MODELS: ReadonlyArray<string> = [
	"gemini-3.8-flash-high",
	"gemini-3.8-flash-medium",
	"gemini-3.8-flash-low",
	"gemini-3.1-pro-high",
	"gemini-3.1-pro-low",
];

/** Typed Clio capabilities only. Antigravity's own opaque tools are declared separately. */
export const antigravityCapabilities: CapabilityFlags = {
	chat: true,
	tools: false,
	reasoning: false,
	vision: false,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	contextWindow: 0,
	maxTokens: 0,
};

export const ANTIGRAVITY_MAX_CATALOG_BYTES = 1024 * 1024;
export const ANTIGRAVITY_MAX_DISCOVERED_MODELS = 4096;
const MAX_MODEL_ID_CHARS = 1024;
const MAX_MODEL_LABEL_CHARS = 1024;

type AntigravityProbeFailureKind = NonNullable<ProbeResult["failureKind"]>;

class AntigravityCatalogError extends Error {
	readonly kind: AntigravityProbeFailureKind;

	constructor(kind: AntigravityProbeFailureKind, message: string) {
		super(message);
		this.name = "AntigravityCatalogError";
		this.kind = kind;
	}
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export interface AntigravityModelCatalog {
	models: string[];
	labels: Record<string, string>;
}

/** Decode the machine-readable catalog emitted by `agy --output-format json models`. */
export function parseAntigravityModelCatalogDetails(output: string): AntigravityModelCatalog {
	let decoded: unknown;
	try {
		decoded = JSON.parse(output);
	} catch {
		throw new AntigravityCatalogError(
			"unsupported-feature",
			"agy returned an unreadable model catalog; update the Antigravity CLI and retry",
		);
	}
	const envelope = record(decoded);
	const command = record(envelope?.command);
	const data = record(command?.data);
	if (envelope?.status !== "SUCCESS") {
		const detail = boundedExternalDiagnostic(
			typeof envelope?.error === "string"
				? envelope.error
				: typeof command?.error === "string"
					? command.error
					: "agy could not list models",
		);
		const kind = classifyAntigravityDiagnostic(detail);
		throw new AntigravityCatalogError(kind, antigravityProbeMessage(kind, detail));
	}
	if (command?.name !== "models" || !Array.isArray(data?.models)) {
		throw new AntigravityCatalogError(
			"unsupported-feature",
			"agy returned an unsupported model catalog; update the Antigravity CLI and retry",
		);
	}
	if (data.models.length === 0) {
		throw new AntigravityCatalogError(
			"catalog-unavailable",
			"agy returned no available models; run `agy` locally and verify the signed-in account has model access",
		);
	}
	if (data.models.length > ANTIGRAVITY_MAX_DISCOVERED_MODELS) {
		throw new AntigravityCatalogError(
			"catalog-unavailable",
			`agy returned more than ${ANTIGRAVITY_MAX_DISCOVERED_MODELS} models; the authoritative catalog was refused rather than truncated`,
		);
	}

	const models: string[] = [];
	const labels: Record<string, string> = {};
	const seen = new Set<string>();
	for (const value of data.models) {
		const model = record(value);
		const id = typeof model?.id === "string" ? model.id.trim() : "";
		const label = typeof model?.label === "string" ? model.label.trim() : "";
		if (id.length === 0 || id.length > MAX_MODEL_ID_CHARS || /[\r\n\0]/u.test(id)) {
			throw new AntigravityCatalogError("catalog-unavailable", "agy returned an invalid model identifier");
		}
		if (label.length === 0 || label.length > MAX_MODEL_LABEL_CHARS || /[\r\n\0]/u.test(label)) {
			throw new AntigravityCatalogError("catalog-unavailable", `agy returned an invalid label for model '${id}'`);
		}
		if (seen.has(id)) {
			if (labels[id] !== label) {
				throw new AntigravityCatalogError(
					"catalog-unavailable",
					`agy returned conflicting labels for duplicate model '${id}'`,
				);
			}
			continue;
		}
		seen.add(id);
		models.push(id);
		labels[id] = label;
	}
	return { models, labels };
}

function classifyAntigravityDiagnostic(detail: string): AntigravityProbeFailureKind {
	if (/(?:enoent|not found|cannot find|could not start|spawn .*agy)/iu.test(detail)) return "missing";
	if (/(?:sign[ -]?in|log[ -]?in|unauthori[sz]ed|authenticat|credential|account.*required)/iu.test(detail)) {
		return "authentication";
	}
	if (
		/(?:unknown|unsupported|unrecognized|invalid) (?:option|argument|command)|output-format|models command/iu.test(detail)
	) {
		return "unsupported-feature";
	}
	return "generic";
}

function antigravityProbeMessage(kind: AntigravityProbeFailureKind, detail: string): string {
	const safeDetail = boundedExternalDiagnostic(detail || "no diagnostic was provided");
	switch (kind) {
		case "missing":
			return "Antigravity CLI is not installed or `agy` is not on PATH";
		case "authentication":
			return `Antigravity sign-in is required; run \`agy\` yourself and complete sign-in (${safeDetail})`;
		case "unsupported-feature":
			return `the installed Antigravity CLI does not expose the required structured model catalog; update \`agy\` (${safeDetail})`;
		case "catalog-unavailable":
			return safeDetail;
		case "cancelled":
			return "Antigravity model discovery was cancelled";
		default:
			return `Antigravity model discovery failed: ${safeDetail}`;
	}
}

export async function probeAntigravityModelCatalog(
	ctx: ProbeContext,
	runner: typeof runCommandVector = runCommandVector,
): Promise<ProbeResult> {
	const result: SafeCommandResult = await runner("agy", ["--output-format", "json", "models"], {
		cwd: process.cwd(),
		workspaceRoot: process.cwd(),
		timeoutMs: Math.max(1, ctx.httpTimeoutMs),
		maxOutputBytes: ANTIGRAVITY_MAX_CATALOG_BYTES,
		...(ctx.signal ? { signal: ctx.signal } : {}),
	});
	if (result.aborted || result.timedOut) {
		return {
			ok: false,
			latencyMs: result.durationMs,
			failureKind: "cancelled",
			error: antigravityProbeMessage("cancelled", ""),
		};
	}
	if (result.outputCapped) {
		return {
			ok: false,
			latencyMs: result.durationMs,
			failureKind: "catalog-unavailable",
			error: `agy model catalog exceeded ${ANTIGRAVITY_MAX_CATALOG_BYTES} bytes`,
		};
	}
	if (result.exitCode !== 0) {
		const detail = boundedExternalDiagnostic(result.stderr || result.stdout || `agy exited ${String(result.exitCode)}`);
		const kind = classifyAntigravityDiagnostic(detail);
		return { ok: false, latencyMs: result.durationMs, failureKind: kind, error: antigravityProbeMessage(kind, detail) };
	}
	try {
		const catalog = parseAntigravityModelCatalogDetails(result.stdout);
		return {
			ok: true,
			latencyMs: result.durationMs,
			models: catalog.models,
			modelLabels: catalog.labels,
		};
	} catch (cause) {
		const kind = cause instanceof AntigravityCatalogError ? cause.kind : "generic";
		const detail = cause instanceof Error ? cause.message : String(cause);
		return { ok: false, latencyMs: result.durationMs, failureKind: kind, error: boundedExternalDiagnostic(detail) };
	}
}

const antigravityCodeRuntime: RuntimeDescriptor = {
	id: "antigravity-code",
	displayName: "Antigravity CLI — experimental local delegation",
	kind: "subprocess",
	tier: "subscription",
	apiFamily: "external-agent-subprocess",
	auth: "none",
	authNotice: ANTIGRAVITY_AUTH_NOTICE,
	knownModels: [...ANTIGRAVITY_MODELS],
	binaryName: "agy",
	headlessCommand: "agy --input-format stream-json --output-format stream-json",
	outputParser: "antigravity-stream-json",
	defaultCapabilities: antigravityCapabilities,
	externalAgentLoop: {
		tools: "externally-governed-unobserved",
		network: "externally-governed-unobserved",
		budget: "external-one-shot",
		generatingRetry: "forbidden",
		modelCatalog: "live-authoritative",
	},
	async probe(_target: TargetDescriptor, ctx: ProbeContext) {
		try {
			return await probeAntigravityModelCatalog(ctx);
		} catch (cause) {
			const detail = boundedExternalDiagnostic(cause instanceof Error ? cause.message : String(cause));
			const kind = classifyAntigravityDiagnostic(detail);
			return { ok: false, failureKind: kind, error: antigravityProbeMessage(kind, detail) };
		}
	},
	synthesizeModel(target: TargetDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		return synthesizeCatalogBackedModel({
			target,
			wireModelId,
			kb,
			defaultCapabilities: antigravityCapabilities,
			runtimeId: "antigravity-code",
			api: "external-agent-subprocess",
			provider: "antigravity",
			defaultBaseUrl: "external-agent://antigravity/local",
		});
	},
};

export default antigravityCodeRuntime;
