/**
 * Thin wrapper over @earendil-works/pi-ai. Domains consume this module, not
 * pi-ai directly. The model-lookup side-registry that used to live here is
 * gone; runtime descriptors under `src/domains/providers/runtimes/` own
 * model synthesis via `RuntimeDescriptor.synthesizeModel()`.
 *
 * pi-ai's provider registry is process-global. Calling
 * `registerBuiltInApiProviders()` multiple times is safe; we still gate on a
 * module-local flag to keep startup hot paths predictable.
 */

import {
	type Api,
	type AssistantMessage,
	fauxAssistantMessage,
	fauxToolCall,
	type KnownProvider,
	type Model,
	type ModelThinkingLevel,
	calculateCost as piCalculateCost,
	cleanupSessionResources as piCleanupSessionResources,
	getSupportedThinkingLevels as piGetSupportedThinkingLevels,
	isContextOverflow as piIsContextOverflow,
	validateToolArguments as piValidateToolArguments,
	type Tool,
	type ToolCall,
	type Usage,
} from "@earendil-works/pi-ai";
import {
	getModels,
	getProviders,
	completeSimple as piCompleteSimple,
	getModel as piGetModel,
	stream as piStream,
	registerBuiltInApiProviders,
	registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import type { EngineModel } from "./types.js";

export { fauxAssistantMessage, fauxToolCall, registerFauxProvider };

export const stream = piStream;

export interface EngineTextCompletionInput {
	model: EngineModel;
	systemPrompt: string;
	userPrompt: string;
	maxTokens: number;
	thinkingLevel: ModelThinkingLevel;
	signal: AbortSignal;
	timeoutMs: number;
	apiKey?: string;
}

export interface EngineTextCompletionResult {
	text: string;
	inputTokens: number;
	outputTokens: number;
}

/** Run one tool-free completion while keeping pi message types at the engine boundary. */
export async function completeEngineText(input: EngineTextCompletionInput): Promise<EngineTextCompletionResult> {
	const response = await piCompleteSimple(
		input.model,
		{
			systemPrompt: input.systemPrompt,
			messages: [{ role: "user", content: input.userPrompt, timestamp: Date.now() }],
		},
		{
			maxTokens: input.maxTokens,
			signal: input.signal,
			timeoutMs: input.timeoutMs,
			...(input.thinkingLevel === "off" ? {} : { reasoning: input.thinkingLevel }),
			...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
		},
	);
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		throw new Error(response.errorMessage ?? `model completion ${response.stopReason}`);
	}
	return {
		text: response.content
			.filter((block): block is Extract<(typeof response.content)[number], { type: "text" }> => block.type === "text")
			.map((block) => block.text)
			.join(""),
		inputTokens: response.usage.input,
		outputTokens: response.usage.output,
	};
}

export interface EngineAi {
	listProviders(): KnownProvider[];
	listModels<TProvider extends KnownProvider>(provider: TProvider): EngineModel[];
	getModel<TProvider extends KnownProvider>(provider: TProvider, modelId: string): EngineModel | undefined;
}

let registered = false;

export function ensurePiAiRegistered(): void {
	if (registered) return;
	registerBuiltInApiProviders();
	registered = true;
}

export function createEngineAi(): EngineAi {
	ensurePiAiRegistered();
	return {
		listProviders: () => getProviders(),
		listModels: (provider) => [...getModels(provider as never)] as EngineModel[],
		getModel: (provider, modelId) => {
			try {
				return piGetModel(provider as never, modelId as never) as EngineModel;
			} catch {
				return undefined;
			}
		},
	};
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function getEngineSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[] {
	return piGetSupportedThinkingLevels(model);
}

export function cleanupEngineSessionResources(sessionId?: string): void {
	piCleanupSessionResources(sessionId);
}

export function isEngineContextOverflow(errorMessage: string, contextWindow?: number): boolean {
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "clio",
		provider: "clio",
		model: "unknown",
		usage: emptyUsage(),
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
	return piIsContextOverflow(message, contextWindow);
}

export function validateEngineToolArguments(tool: Tool, toolCall: ToolCall): unknown {
	return piValidateToolArguments(tool, toolCall);
}

export function calculateEngineCost<TApi extends Api>(model: Model<TApi>, usage: Usage): Usage["cost"] {
	return piCalculateCost(model, usage);
}

/**
 * When `CLIO_CODER_WORKER_FAUX=1`, register the pi-ai faux provider and queue a
 * single deterministic assistant response. Used by the worker-entry diag so
 * the worker subprocess can run end-to-end without provider credentials.
 *
 * Env vars (all optional except the gate):
 *   CLIO_CODER_WORKER_FAUX               must equal "1" to arm registration
 *   CLIO_CODER_WORKER_FAUX_MODEL         model id registered under the faux provider (default "faux-model")
 *   CLIO_CODER_WORKER_FAUX_TEXT          assistant response text (default "ok")
 *   CLIO_CODER_WORKER_FAUX_STOP_REASON   assistant stopReason (default "stop")
 *   CLIO_CODER_WORKER_FAUX_ERROR_MESSAGE optional assistant errorMessage
 */
export function registerFauxFromEnv(): EngineModel | null {
	if (process.env.CLIO_CODER_WORKER_FAUX !== "1") return null;
	const modelId = process.env.CLIO_CODER_WORKER_FAUX_MODEL ?? "faux-model";
	const text = process.env.CLIO_CODER_WORKER_FAUX_TEXT ?? "ok";
	const stopReason = (process.env.CLIO_CODER_WORKER_FAUX_STOP_REASON ?? "stop") as AssistantMessage["stopReason"];
	const errorMessage = process.env.CLIO_CODER_WORKER_FAUX_ERROR_MESSAGE;
	const reg = registerFauxProvider({
		provider: "faux",
		models: [{ id: modelId }],
	});
	const response = { stopReason } as {
		stopReason: AssistantMessage["stopReason"];
		errorMessage?: string;
	};
	if (errorMessage && errorMessage.length > 0) {
		response.errorMessage = errorMessage;
	}
	reg.setResponses([fauxAssistantMessage(text, response)]);
	return reg.getModel(modelId) as EngineModel;
}
