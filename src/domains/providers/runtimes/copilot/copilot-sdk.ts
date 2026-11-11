import { listCopilotSdkModels } from "../../../../engine/ai.js";
import type { Api, Model } from "../../../../engine/types.js";
import { synthesizeCatalogBackedModel } from "../../catalog.js";
import { readTargetModelSnapshot, recordTargetModelSnapshot } from "../../target-model-cache.js";
import type { CapabilityFlags } from "../../types/capability-flags.js";
import type { KnowledgeBaseHit } from "../../types/knowledge-base.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../../types/target-descriptor.js";
import { copilotContextTierOf } from "../../types/target-descriptor.js";

export const COPILOT_SDK_RUNTIME_ID = "copilot-sdk";

/**
 * The model setup and onboarding pick when the account lists it, as `openai-codex` does. The listing's own first
 * entry is often `auto`, which lets Copilot choose a model per request and so a different premium rate.
 */
export const COPILOT_SDK_DEFAULT_MODEL = "gpt-6-luna";

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

/** Capabilities the runtime's listing reported for each model this process listed, per context tier. */
const listed = new Map<string, { base: Partial<CapabilityFlags>; longContext: Partial<CapabilityFlags> | undefined }>();

type ListedRow = {
	contextWindow: number | undefined;
	maxOutputTokens: number | undefined;
	vision: boolean;
	reasoning: boolean;
	longContext?: { contextWindow: number | undefined };
};

function rowCapabilities(row: ListedRow, contextWindow = row.contextWindow): Partial<CapabilityFlags> {
	return {
		vision: row.vision,
		reasoning: row.reasoning,
		...(contextWindow !== undefined ? { contextWindow } : {}),
		...(row.maxOutputTokens !== undefined ? { maxTokens: row.maxOutputTokens } : {}),
	};
}

/**
 * The capabilities a listed model has on a target's tier: the long-context window when the target opts into
 * `contextTier: long_context` and the listing publishes that tier, else the default window.
 */
export function copilotTierCapabilities(
	row: ListedRow,
	target: Pick<TargetDescriptor, "runtime" | "contextTier">,
): Partial<CapabilityFlags> {
	return copilotContextTierOf(target) === "long_context" && row.longContext
		? rowCapabilities(row, row.longContext.contextWindow)
		: rowCapabilities(row);
}

function listedFor(id: string, target: TargetDescriptor): Partial<CapabilityFlags> | undefined {
	const entry = listed.get(id);
	if (!entry) return undefined;
	return copilotContextTierOf(target) === "long_context" && entry.longContext ? entry.longContext : entry.base;
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
		const modelCapabilities = Object.fromEntries(snapshot.models.map((id) => [id, listedFor(id, target) ?? {}]));
		const capabilityModelId =
			target.defaultModel && listed.has(target.defaultModel) ? target.defaultModel : snapshot.models[0];
		return {
			ok: true,
			models: [...snapshot.models],
			modelsSource: "cache",
			modelCapabilities,
			...(capabilityModelId
				? { capabilityModelId, discoveredCapabilities: listedFor(capabilityModelId, target) ?? {} }
				: {}),
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
			modelCapabilities[row.id] = copilotTierCapabilities(row, target);
			listed.set(row.id, {
				base: rowCapabilities(row),
				longContext: row.longContext ? rowCapabilities(row, row.longContext.contextWindow) : undefined,
			});
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
	externalLogin: "copilot login",
	defaultCapabilities: copilotCapabilities,
	// The runtime's listing omits models the account can call (Gemini 3.8 Flash on runtime 1.0.26).
	servesUnlistedModels: true,
	defaultModel: COPILOT_SDK_DEFAULT_MODEL,
	probe: probeCopilotSdk,
	synthesizeModel(target: TargetDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
		const discovered = listedFor(wireModelId, target);
		const model = synthesizeCatalogBackedModel({
			target,
			wireModelId,
			kb,
			defaultCapabilities: { ...copilotCapabilities, ...discovered },
			runtimeId: COPILOT_SDK_RUNTIME_ID,
			api: "copilot-sdk",
			provider: "copilot-sdk",
			defaultBaseUrl: "copilot-sdk://local",
		});
		// The engine reads the tier off the model it streams with: session create and model switch pass it on.
		return copilotContextTierOf(target) === "long_context"
			? (Object.assign(model, { copilotContextTier: "long_context" }) as Model<Api>)
			: model;
	},
} satisfies RuntimeDescriptor;

export default copilotSdkRuntime;
