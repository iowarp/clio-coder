import { listCopilotSdkModels } from "../../../../engine/ai.js";
import type { Api, Model } from "../../../../engine/types.js";
import { synthesizeCatalogBackedModel } from "../../catalog.js";
import { readTargetModelSnapshot, recordTargetModelSnapshot } from "../../target-model-cache.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";

export const COPILOT_SDK_RUNTIME_ID = "copilot-sdk";

export const COPILOT_SDK_AUTH_NOTICE =
	"Uses your GitHub Copilot subscription through the official Copilot SDK, as the account signed in with `copilot login`; your organization's Copilot policies apply. Clio stores no Copilot token.";

const copilotCapabilities: CapabilityFlags = {
	chat: true,
	tools: true,
	toolCallFormat: "openai",
	reasoning: false,
	vision: false,
	audio: false,
	embeddings: false,
	rerank: false,
	fim: false,
	contextWindow: 128000,
	maxTokens: 16384,
};

/** Capabilities the runtime's listing reported for each model this process listed. */
const listed = new Map<string, Partial<CapabilityFlags>>();

function rowCapabilities(row: {
	contextWindow: number | undefined;
	maxOutputTokens: number | undefined;
	vision: boolean;
	reasoning: boolean;
}): Partial<CapabilityFlags> {
	return {
		vision: row.vision,
		reasoning: row.reasoning,
		...(row.contextWindow !== undefined ? { contextWindow: row.contextWindow } : {}),
		...(row.maxOutputTokens !== undefined ? { maxTokens: row.maxOutputTokens } : {}),
	};
}

async function probeCopilotSdk(
	target: TargetDescriptor,
	ctx: ProbeContext,
	listModels = listCopilotSdkModels,
): Promise<ProbeResult> {
	ctx.signal?.throwIfAborted();
	const snapshot = readTargetModelSnapshot(target);
	// The cached listing is used only once this process has the capabilities that go with it.
	if (snapshot && snapshot.models.length > 0 && snapshot.models.every((id) => listed.has(id))) {
		const modelCapabilities = Object.fromEntries(snapshot.models.map((id) => [id, listed.get(id) ?? {}]));
		const capabilityModelId =
			target.defaultModel && listed.has(target.defaultModel) ? target.defaultModel : snapshot.models[0];
		return {
			ok: true,
			models: [...snapshot.models],
			modelsSource: "cache",
			modelCapabilities,
			...(capabilityModelId ? { capabilityModelId, discoveredCapabilities: listed.get(capabilityModelId) ?? {} } : {}),
			...(snapshot.modelLabels ? { modelLabels: snapshot.modelLabels } : {}),
		};
	}
	try {
		const rows = await listModels();
		ctx.signal?.throwIfAborted();
		if (rows.length === 0) {
			return {
				ok: false,
				failureKind: "catalog-unavailable",
				error: "GitHub Copilot lists no enabled models for this account",
			};
		}
		const models = rows.map((row) => row.id);
		const modelLabels = Object.fromEntries(rows.map((row) => [row.id, row.label]));
		const modelCapabilities: Record<string, Partial<CapabilityFlags>> = {};
		for (const row of rows) {
			modelCapabilities[row.id] = rowCapabilities(row);
			listed.set(row.id, modelCapabilities[row.id] as Partial<CapabilityFlags>);
		}
		recordTargetModelSnapshot(target, models, { modelLabels });
		const capabilityModelId = target.defaultModel && listed.has(target.defaultModel) ? target.defaultModel : models[0];
		const discoveredCapabilities = capabilityModelId ? modelCapabilities[capabilityModelId] : undefined;
		return {
			ok: true,
			models,
			modelLabels,
			modelCapabilities,
			...(capabilityModelId && discoveredCapabilities ? { capabilityModelId, discoveredCapabilities } : {}),
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const code = (err as { code?: unknown } | null)?.code;
		return {
			ok: false,
			failureKind:
				code === "COPILOT_LOGIN_REQUIRED"
					? "authentication"
					: code === "COPILOT_SDK_UNAVAILABLE"
						? "missing"
						: "catalog-unavailable",
			...(code === "COPILOT_LOGIN_REQUIRED" ? { authFailed: true } : {}),
			error: message,
		};
	}
}

const copilotSdkRuntime = {
	id: COPILOT_SDK_RUNTIME_ID,
	displayName: "GitHub Copilot SDK",
	// An HTTP-kind runtime to the rest of Clio: Clio's own agent loop drives it and runs every tool. The
	// model call itself goes through the official SDK (engine/copilot/stream.ts), never through Pi.
	kind: "http",
	tier: "subscription",
	apiFamily: "copilot-sdk",
	// The credential belongs to the official Copilot runtime, not to Clio's store.
	auth: "none",
	authNotice: COPILOT_SDK_AUTH_NOTICE,
	defaultCapabilities: copilotCapabilities,
	probe: probeCopilotSdk,
	synthesizeModel(target: TargetDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		const discovered = listed.get(wireModelId);
		return synthesizeCatalogBackedModel({
			target,
			wireModelId,
			kb,
			defaultCapabilities: { ...copilotCapabilities, ...discovered },
			runtimeId: COPILOT_SDK_RUNTIME_ID,
			api: "copilot-sdk",
			provider: "copilot-sdk",
			defaultBaseUrl: "copilot-sdk://local",
		});
	},
} satisfies RuntimeDescriptor;

export default copilotSdkRuntime;
