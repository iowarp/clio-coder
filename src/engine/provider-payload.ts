import { RESPONSE_SCHEMA_RUNTIME_ID, type ResponseSchemaDialect } from "../core/response-schema.js";
import type { ThinkingLevel } from "../domains/providers/index.js";
import type { EngineModel } from "./types.js";

function reasoningSummaryForLevel(level: ThinkingLevel | undefined): "concise" | "detailed" | undefined {
	if (!level || level === "off") return undefined;
	if (level === "minimal" || level === "low") return "concise";
	return "detailed";
}

function isOpenAIResponsesApi(api: string): boolean {
	return api === "openai-codex-responses" || api === "openai-responses" || api === "azure-openai-responses";
}

function isAnthropicMessagesApi(api: string): boolean {
	return api === "anthropic-messages";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function namedToolDefinitions(tools: unknown, toolName: string): unknown[] | null {
	if (!Array.isArray(tools)) return null;
	const narrowed: unknown[] = [];
	for (const tool of tools) {
		if (!isRecord(tool)) continue;
		const directName = typeof tool.name === "string" ? tool.name : undefined;
		const functionName =
			isRecord(tool.function) && typeof tool.function.name === "string" ? tool.function.name : undefined;
		const toolSpecName =
			isRecord(tool.toolSpec) && typeof tool.toolSpec.name === "string" ? tool.toolSpec.name : undefined;
		if (directName === toolName || functionName === toolName || toolSpecName === toolName) {
			narrowed.push(tool);
			continue;
		}
		if (Array.isArray(tool.functionDeclarations)) {
			const declarations = tool.functionDeclarations.filter(
				(declaration) => isRecord(declaration) && declaration.name === toolName,
			);
			if (declarations.length > 0) narrowed.push({ ...tool, functionDeclarations: declarations });
		}
	}
	return narrowed.length > 0 ? narrowed : null;
}

function patchOpenAIReasoningSummaryPayload(
	payload: unknown,
	model: EngineModel,
	thinkingLevel: ThinkingLevel | undefined,
): unknown | undefined {
	if (!isOpenAIResponsesApi(model.api)) return undefined;
	const summary = reasoningSummaryForLevel(thinkingLevel);
	if (!summary || !isRecord(payload)) return undefined;
	const record = payload;
	const reasoning = record.reasoning;
	if (!isRecord(reasoning)) return undefined;
	return {
		...record,
		reasoning: {
			...reasoning,
			summary,
		},
	};
}

/**
 * Align provider payloads with Clio's effective thinking level.
 *
 * OpenAI Responses defaults reasoning summaries to "auto", which can yield no
 * visible thinking blocks, and the agent loop has no option for the summary
 * field, so it is set here. Anthropic thinking is pi-owned: pi-ai's
 * `streamSimple` maps the agent's thinking level onto adaptive effort (via
 * `model.thinkingLevelMap` and `compat.forceAdaptiveThinking`) or a bounded
 * `budget_tokens`, so the payload is left untouched for that API.
 */
export function patchProviderThinkingPayload(
	payload: unknown,
	model: EngineModel,
	thinkingLevel: ThinkingLevel | undefined,
): unknown | undefined {
	return patchOpenAIReasoningSummaryPayload(payload, model, thinkingLevel);
}

/**
 * Force a text-only round by setting the request-level tool-choice knob to
 * "none". Used while a loop-guard synthesis lockout is active: the lockout
 * directive alone relies on model compliance, and measured local models kept
 * calling tools until the backstop stopped the turn, throwing away everything
 * the turn had gathered. The tool schema bytes are untouched (the prompt
 * prefix and tool surface stay byte-stable); only this request's routing
 * changes, so prompt-prefix caches are unaffected.
 *
 * Returns undefined when the payload carries no tool surface (nothing to
 * lock) or is not a record (unknown provider shape; leave it alone).
 */
export function patchToolChoiceNonePayload(payload: unknown, model: EngineModel): unknown | undefined {
	if (!isRecord(payload)) return undefined;
	if (!("tools" in payload) || payload.tools === undefined || payload.tools === null) return undefined;
	if (isAnthropicMessagesApi(model.api)) return { ...payload, tool_choice: { type: "none" } };
	return { ...payload, tool_choice: "none" };
}

/**
 * Force a text-only round the hard way: remove the tool surface from the
 * request. Used for a worker's synthesis-locked rounds (the loop-guard lockout
 * and the terminal result-contract repair). {@link patchToolChoiceNonePayload}
 * is not enough there: llama.cpp honors tool_choice "none" by disabling its
 * tool-call parser while the chat template still renders every tool schema,
 * so a local model that decides to call a tool anyway hands its markup back
 * as content, the loop guard strips it, and the worker ends with no result
 * at all (a coder run that had written and tested its file returned zero
 * output this way, #78). With no tools in the prompt the template renders no
 * tool block and the model has nothing to call. The prompt prefix changes for
 * these one or two rounds; that is the price of a usable answer.
 *
 * Anthropic keeps the tool_choice knob instead: its API rejects a history
 * that carries tool_use blocks unless tools are defined, and it honors
 * tool_choice none properly.
 */
function patchToolSurfaceLockedPayload(payload: unknown, model: EngineModel): unknown | undefined {
	if (!isRecord(payload)) return undefined;
	if (!("tools" in payload) || payload.tools === undefined || payload.tools === null) return undefined;
	if (isAnthropicMessagesApi(model.api)) return patchToolChoiceNonePayload(payload, model);
	const stripped = { ...payload };
	delete stripped.tools;
	delete stripped.tool_choice;
	return stripped;
}

/** Require one exposed tool for the next provider round while preserving the full schema surface. */
export function patchToolChoiceNamedPayload(
	payload: unknown,
	model: EngineModel,
	toolName: string,
): unknown | undefined {
	if (!isRecord(payload) || toolName.trim().length === 0) return undefined;
	if (isAnthropicMessagesApi(model.api)) {
		const tools = namedToolDefinitions(payload.tools, toolName);
		if (tools === null) return undefined;
		// Anthropic rejects a named tool choice while extended/adaptive thinking
		// is active. Required-tool rounds are routing rounds, so disable thinking
		// for this request only and remove the adaptive effort knob that belongs
		// to it; the next automatic round resumes the configured thinking level.
		const patched = { ...payload };
		delete patched.thinking;
		if (isRecord(patched.output_config) && "effort" in patched.output_config) {
			const outputConfig = { ...patched.output_config };
			delete outputConfig.effort;
			if (Object.keys(outputConfig).length > 0) patched.output_config = outputConfig;
			else delete patched.output_config;
		}
		return { ...patched, tools, tool_choice: { type: "tool", name: toolName } };
	}
	if (model.api === "google-generative-ai" || model.api === "google-vertex") {
		if (!isRecord(payload.config) || payload.config.tools === undefined || payload.config.tools === null)
			return undefined;
		const tools = namedToolDefinitions(payload.config.tools, toolName);
		if (tools === null) return undefined;
		const toolConfig = isRecord(payload.config.toolConfig) ? payload.config.toolConfig : {};
		return {
			...payload,
			config: {
				...payload.config,
				tools,
				toolConfig: {
					...toolConfig,
					functionCallingConfig: { mode: "ANY", allowedFunctionNames: [toolName] },
				},
			},
		};
	}
	if (model.api === "bedrock-converse-stream") {
		if (!isRecord(payload.toolConfig) || payload.toolConfig.tools === undefined || payload.toolConfig.tools === null) {
			return undefined;
		}
		const tools = namedToolDefinitions(payload.toolConfig.tools, toolName);
		if (tools === null) return undefined;
		return { ...payload, toolConfig: { ...payload.toolConfig, tools, toolChoice: { tool: { name: toolName } } } };
	}
	const tools = namedToolDefinitions(payload.tools, toolName);
	if (tools === null) return undefined;
	if (isOpenAIResponsesApi(model.api)) {
		return { ...payload, tools, tool_choice: { type: "function", name: toolName } };
	}
	if (model.api === "mistral-conversations") {
		return { ...payload, tools, toolChoice: { type: "function", function: { name: toolName } } };
	}
	// Generic OpenAI-compatible servers reject the object form outright: both LM
	// Studio and llama.cpp answer HTTP 400 with "Invalid tool_choice type:
	// 'object'. Supported string values: none, auto, required". The tool surface
	// is already narrowed to the single named definition above, so "required" is
	// equivalent here and is the only spelling every server accepts.
	return { ...payload, tools, tool_choice: "required" };
}

/** Attach llama-server's native JSON-schema response constraint without changing its tool surface. */
function patchLlamaCppResponseSchemaPayload(
	payload: unknown,
	runtimeId: string,
	responseSchema: Record<string, unknown> | undefined,
): unknown | undefined {
	if (responseSchema === undefined) return undefined;
	if (runtimeId !== RESPONSE_SCHEMA_RUNTIME_ID) {
		throw new Error(`responseSchema requires the native llamacpp runtime; received '${runtimeId}'`);
	}
	if (!isRecord(payload)) throw new Error("cannot apply responseSchema to a non-object provider payload");
	return {
		...payload,
		response_format: {
			// llama-server accepts schema-constrained JSON through the widely
			// compatible json_object form; some deployed gateways silently ignore
			// the newer json_schema discriminator while still returning HTTP 200.
			type: "json_object",
			schema: responseSchema,
		},
	};
}

/**
 * Apply a JSON-schema response constraint in the dialect the runtime takes.
 *
 * Unlike the worker patcher above, this one is for a seam that treats native
 * enforcement as an optimization: the caller looks the dialect up first and
 * simply does not call this when there is none, so an unconstrained request
 * still goes out and the prompt-level instruction carries it (issue #223).
 * Returns undefined when the payload is not an object, which leaves it alone.
 */
export function patchResponseSchemaPayloadForDialect(
	payload: unknown,
	dialect: ResponseSchemaDialect,
	responseSchema: Record<string, unknown>,
	schemaName: string,
): unknown | undefined {
	if (!isRecord(payload)) return undefined;
	if (dialect === "llamacpp-json-object") {
		return { ...payload, response_format: { type: "json_object", schema: responseSchema } };
	}
	return {
		...payload,
		response_format: {
			type: "json_schema",
			json_schema: { name: schemaName, strict: true, schema: responseSchema },
		},
	};
}

export interface WorkerPayloadPatchOptions {
	runtimeId: string;
	thinkingLevel?: ThinkingLevel;
	responseSchema?: Record<string, unknown>;
	toolChoiceNone?: boolean;
	toolChoiceName?: string;
	/** Synthesis-locked round: remove the tool surface, see {@link patchToolSurfaceLockedPayload}. */
	toolSurfaceLocked?: boolean;
	/**
	 * How a locked round is enforced on OpenAI-family APIs. `strip` (default)
	 * removes the tool schemas, which changes the prompt prefix for the last
	 * round or two; `tool-choice` keeps the schemas and sends tool_choice none,
	 * which preserves the prefix but relies on the runtime honoring the knob.
	 */
	toolSurfaceLockMode?: SynthesisLockMode;
}

export type SynthesisLockMode = "strip" | "tool-choice";

/** Operator override for experiments; anything but `tool-choice` is the default strip. */
export function synthesisLockModeFromEnv(env: NodeJS.ProcessEnv = process.env): SynthesisLockMode {
	return env.CLIO_CODER_SYNTHESIS_LOCK === "tool-choice" ? "tool-choice" : "strip";
}

/** Compose all worker-owned request mutations over one payload in a stable order. */
export function patchWorkerRequestPayload(
	payload: unknown,
	model: EngineModel,
	options: WorkerPayloadPatchOptions,
): unknown | undefined {
	let patched = payload;
	let changed = false;

	const thinkingPatched = patchProviderThinkingPayload(patched, model, options.thinkingLevel);
	if (thinkingPatched !== undefined) {
		patched = thinkingPatched;
		changed = true;
	}

	const schemaPatched = patchLlamaCppResponseSchemaPayload(patched, options.runtimeId, options.responseSchema);
	if (schemaPatched !== undefined) {
		patched = schemaPatched;
		changed = true;
	}

	if (options.toolSurfaceLocked === true) {
		const lockedPatched =
			options.toolSurfaceLockMode === "tool-choice"
				? patchToolChoiceNonePayload(patched, model)
				: patchToolSurfaceLockedPayload(patched, model);
		if (lockedPatched !== undefined) {
			patched = lockedPatched;
			changed = true;
		}
	} else if (options.toolChoiceNone === true) {
		const toolChoicePatched = patchToolChoiceNonePayload(patched, model);
		if (toolChoicePatched !== undefined) {
			patched = toolChoicePatched;
			changed = true;
		}
	} else if (options.toolChoiceName !== undefined) {
		const toolChoicePatched = patchToolChoiceNamedPayload(patched, model, options.toolChoiceName);
		if (toolChoicePatched !== undefined) {
			patched = toolChoicePatched;
			changed = true;
		}
	}

	return changed ? patched : undefined;
}
