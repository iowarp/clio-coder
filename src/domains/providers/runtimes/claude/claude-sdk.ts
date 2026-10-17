import { listClaudeSdkModels } from "../../../../engine/ai.js";
import type { Api, Model } from "../../../../engine/types.js";

import { capabilitiesFromCatalogModel, getCatalogModelForRuntime } from "../../catalog.js";
import { readTargetModelSnapshot, recordTargetModelSnapshot } from "../../target-model-cache.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";
import {
	CLAUDE_CODE_AUTH_NOTICE,
	CLAUDE_CODE_MODELS,
	claudeCodeCapabilities,
	synthesizeClaudeDelegatedModel,
} from "./common.js";

async function probeClaudeSdkModels(
	target: TargetDescriptor,
	ctx: ProbeContext,
	listModels = listClaudeSdkModels,
): Promise<ProbeResult> {
	ctx.signal?.throwIfAborted();
	const snapshot = readTargetModelSnapshot(target);
	if (snapshot && snapshot.models.length > 0) {
		return {
			ok: true,
			models: [...snapshot.models],
			modelsSource: "cache",
			...(snapshot.modelLabels ? { modelLabels: snapshot.modelLabels } : {}),
		};
	}
	try {
		const rows = await listModels(target, ctx);
		const models: string[] = [];
		const modelLabels: Record<string, string> = {};
		const modelCapabilities: Record<string, Partial<CapabilityFlags>> = {};
		// #416: concrete ids use family or catalog names even when only "default" resolves to them.
		const familyLabels = new Map(rows.filter((row) => row.id !== "default").map((row) => [row.catalogId, row.label]));
		for (const row of rows) {
			for (const id of new Set([row.id, row.catalogId])) {
				if (!id.trim() || models.includes(id)) continue;
				models.push(id);
				modelLabels[id] =
					id === row.id
						? row.label
						: (familyLabels.get(id) ?? getCatalogModelForRuntime("claude-sdk", id)?.name ?? row.label);
				modelCapabilities[id] = capabilitiesFromCatalogModel(
					claudeCodeCapabilities,
					getCatalogModelForRuntime("claude-sdk", row.catalogId),
				);
			}
		}
		if (models.length === 0) {
			return { ok: false, failureKind: "catalog-unavailable", error: "Claude SDK listed no models" };
		}
		ctx.signal?.throwIfAborted();
		// #416: doctor and direct listing callers also need to seed the shared TTL cache.
		recordTargetModelSnapshot(target, models, { modelLabels });
		return { ok: true, models, modelLabels, modelCapabilities };
	} catch (err) {
		return {
			ok: false,
			failureKind: "catalog-unavailable",
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

const claudeSdkRuntime = {
	id: "claude-sdk",
	displayName: "Claude Agent SDK",
	kind: "sdk",
	tier: "subscription",
	apiFamily: "claude-agent-sdk",
	auth: "claude-cli",
	authNotice: CLAUDE_CODE_AUTH_NOTICE,
	knownModels: [...CLAUDE_CODE_MODELS],
	binaryName: "claude",
	headlessCommand: "@anthropic-ai/claude-agent-sdk query()",
	outputParser: "claude-agent-sdk-messages",
	defaultCapabilities: claudeCodeCapabilities,
	probe: probeClaudeSdkModels,
	// canUseTool admits every SDK tool call through the shared evaluator, but the
	// callback cannot park a call for a later decision.
	enforcement: {
		perCallMediation: true,
		toolNarrowing: "exact",
		scopeEnforcement: true,
		grantPauseResume: false,
		cancellation: true,
	},
	synthesizeModel(target: TargetDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		return synthesizeClaudeDelegatedModel({
			target,
			wireModelId,
			kb,
			defaultCapabilities: claudeCodeCapabilities,
			runtimeId: "claude-sdk",
			apiFamily: "claude-agent-sdk",
		});
	},
} satisfies RuntimeDescriptor;

export default claudeSdkRuntime;
