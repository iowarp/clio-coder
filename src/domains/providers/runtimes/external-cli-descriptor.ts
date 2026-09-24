import { boundedExternalDiagnostic } from "../../../core/external-diagnostic.js";
import { runCommandVector } from "../../../core/safe-exec.js";
import type { Api, Model } from "../../../engine/types.js";

import { synthesizeCatalogBackedModel } from "../catalog.js";
import type { CapabilityFlags } from "../types/capability-flags.js";
import type { KnowledgeBaseHit } from "../types/knowledge-base.js";
import type { ProbeContext, ProbeResult, RuntimeDescriptor } from "../types/runtime-descriptor.js";
import type { TargetDescriptor } from "../types/target-descriptor.js";

const opaqueCliCapabilities: CapabilityFlags = {
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

export interface CliRuntimeRecipe {
	id: string;
	displayName: string;
	binaryName: string;
	defaultModel: string;
	headlessCommand: string;
	outputParser: string;
	authNotice: string;
	provider: string;
	probe?: (target: TargetDescriptor, ctx: ProbeContext) => Promise<ProbeResult>;
}

/** Small Clio descriptor factory; each CLI still owns its parser and authority mapping. */
export function createExternalCliRuntime(recipe: CliRuntimeRecipe): RuntimeDescriptor {
	const probe =
		recipe.probe ??
		(async (_target: TargetDescriptor, ctx: ProbeContext): Promise<ProbeResult> => {
			const cwd = process.cwd();
			const result = await runCommandVector(recipe.binaryName, ["--version"], {
				cwd,
				workspaceRoot: cwd,
				timeoutMs: Math.max(1, ctx.httpTimeoutMs),
				maxOutputBytes: 4096,
				...(ctx.signal ? { signal: ctx.signal } : {}),
			});
			if (result.exitCode !== 0) {
				return {
					ok: false,
					latencyMs: result.durationMs,
					failureKind: result.aborted ? "cancelled" : result.stderr.includes("ENOENT") ? "missing" : "generic",
					error: boundedExternalDiagnostic(result.stderr || `${recipe.binaryName} is unavailable`),
				};
			}
			return {
				ok: true,
				latencyMs: result.durationMs,
				serverVersion: result.stdout.trim(),
				models: [recipe.defaultModel],
			};
		});
	return {
		id: recipe.id,
		displayName: recipe.displayName,
		kind: "subprocess",
		tier: "subscription",
		apiFamily: "external-agent-subprocess",
		auth: "none",
		authNotice: recipe.authNotice,
		knownModels: [recipe.defaultModel],
		binaryName: recipe.binaryName,
		headlessCommand: recipe.headlessCommand,
		outputParser: recipe.outputParser,
		defaultCapabilities: opaqueCliCapabilities,
		externalAgentLoop: {
			tools: "externally-governed-unobserved",
			network: "externally-governed-unobserved",
			budget: "external-one-shot",
			generatingRetry: "forbidden",
			modelCatalog: "static",
		},
		probe,
		synthesizeModel(target: TargetDescriptor, wireModelId: string, kb: KnowledgeBaseHit | null): Model<Api> {
			return synthesizeCatalogBackedModel({
				target,
				wireModelId,
				kb,
				defaultCapabilities: opaqueCliCapabilities,
				runtimeId: recipe.id,
				api: "external-agent-subprocess",
				provider: recipe.provider,
				defaultBaseUrl: `${recipe.id}://local`,
			});
		},
	};
}
