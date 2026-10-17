import type { Api, Model } from "../../../../engine/types.js";

import {
	capabilitiesFromCatalogModel,
	getCatalogModelForRuntime,
	synthesizeCatalogBackedModel,
} from "../../catalog.js";
import { probeJson } from "../../probe/http.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";

const defaultCapabilities: CapabilityFlags = {
	chat: true,
	tools: true,
	toolCallFormat: "anthropic",
	reasoning: true,
	thinkingFormat: "anthropic-extended",
	vision: true,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	contextWindow: 200000,
	maxTokens: 8192,
};

interface AnthropicModelsPage {
	data?: Array<{ id?: unknown; display_name?: unknown; created_at?: unknown }>;
	has_more?: unknown;
	last_id?: unknown;
}

/** #416: discovery uses the same refreshed target token as inference, never API-key auth. */
async function listAnthropicMaxModels(
	_target: TargetDescriptor,
	ctx: ProbeContext,
	fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<ProbeResult> {
	if (!ctx.authToken?.trim()) {
		return { ok: false, failureKind: "missing", error: "no Claude Pro/Max OAuth credential to list models with" };
	}
	const models: string[] = [];
	const modelLabels: Record<string, string> = {};
	const modelCreatedAt: Record<string, string> = {};
	const modelCapabilities: Record<string, Partial<CapabilityFlags>> = {};
	const cursors = new Set<string>();
	let after: string | undefined;
	for (let page = 0; page < 100; page += 1) {
		const query = new URLSearchParams({ limit: "1000" });
		if (after) query.set("after_id", after);
		const result = await probeJson<AnthropicModelsPage>({
			url: `https://api.anthropic.com/v1/models?${query}`,
			fetch,
			timeoutMs: ctx.httpTimeoutMs,
			headers: {
				Authorization: `Bearer ${ctx.authToken}`,
				"anthropic-beta": "oauth-2025-04-20",
				"anthropic-version": "2023-06-01",
			},
			...(ctx.signal ? { signal: ctx.signal } : {}),
		});
		if (!result.ok) {
			return {
				ok: false,
				error: `Anthropic model listing failed: ${result.error ?? "no response"}`,
				...(result.status === 401 || result.status === 403
					? { authFailed: true, failureKind: "authentication" as const }
					: {}),
			};
		}
		if (!Array.isArray(result.data?.data) || typeof result.data.has_more !== "boolean") {
			return { ok: false, error: "Unexpected Anthropic model listing response" };
		}
		for (const row of result.data.data) {
			if (typeof row?.id !== "string" || !row.id.trim()) {
				return { ok: false, error: "Unexpected Anthropic model listing row" };
			}
			if (models.includes(row.id)) continue;
			models.push(row.id);
			if (typeof row.display_name === "string" && row.display_name.trim()) modelLabels[row.id] = row.display_name;
			if (typeof row.created_at === "string" && Number.isFinite(Date.parse(row.created_at))) {
				modelCreatedAt[row.id] = row.created_at;
			}
			modelCapabilities[row.id] = capabilitiesFromCatalogModel(
				defaultCapabilities,
				getCatalogModelForRuntime("anthropic-max", row.id),
			);
		}
		if (!result.data.has_more) {
			return models.length > 0
				? { ok: true, models, modelLabels, modelCreatedAt, modelCapabilities }
				: { ok: false, error: "Anthropic listed no models" };
		}
		const cursor = result.data.last_id;
		if (typeof cursor !== "string" || !cursor || cursors.has(cursor)) {
			return { ok: false, error: "Unexpected Anthropic model listing pagination cursor" };
		}
		cursors.add(cursor);
		after = cursor;
	}
	return { ok: false, error: "Anthropic model listing exceeded 100 pages" };
}

/**
 * Claude Pro/Max subscription runtime (OAuth).
 *
 * Mirrors the `openai-codex` subscription runtime for Anthropic: an
 * `anthropic-messages` HTTP runtime whose credential is an OAuth access token
 * minted from a Claude Pro/Max subscription rather than an API key. Clio owns
 * credential storage and refresh; Pi's HTTP provider detects OAuth tokens to
 * select Bearer auth and the required beta headers for inference.
 *
 * Clio registers this OAuth flow as `anthropic-max`. Pi's HTTP provider remains
 * `anthropic`, but the subscription credential must never share the API-key
 * runtime's storage slot.
 *
 * #416: the account's Models API supplies discovery. The shared target-model
 * snapshot cache and catalog remain labeled fallbacks when that request fails.
 */
const anthropicMaxRuntime = {
	id: "anthropic-max",
	displayName: "Anthropic (Claude Pro/Max)",
	kind: "http",
	tier: "cloud",
	apiFamily: "anthropic-messages",
	auth: "oauth",
	authNotice:
		"Connects with your Claude Pro/Max subscription via OAuth (the same path Claude Code uses). " +
		"Using subscription credentials outside Anthropic's first-party apps may not align with their " +
		"terms of service; enable at your own discretion.",
	defaultCapabilities,
	probe: listAnthropicMaxModels,
	synthesizeModel(target: TargetDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		return synthesizeCatalogBackedModel({
			target,
			wireModelId,
			kb,
			defaultCapabilities,
			runtimeId: "anthropic-max",
			api: "anthropic-messages",
			provider: "anthropic",
			defaultBaseUrl: "https://api.anthropic.com",
		});
	},
} satisfies RuntimeDescriptor;

export default anthropicMaxRuntime;
