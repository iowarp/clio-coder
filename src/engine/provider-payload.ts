import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
	GATEWAY_SCHEMA_RUNTIME_ID,
	RESPONSE_SCHEMA_RUNTIME_ID,
	type ResponseSchemaDialect,
	responseSchemaDialectFor,
} from "../core/response-schema.js";
import { resolvedRequestContext } from "./context.js";
import type { EngineModel } from "./types.js";

function isOpenAIResponsesApi(api: string): boolean {
	return api === "openai-codex-responses" || api === "openai-responses" || api === "azure-openai-responses";
}

function isAnthropicMessagesApi(api: string): boolean {
	return api === "anthropic-messages";
}

/** APIs whose named-tool request dialect is implemented below. */
export function supportsNamedToolChoice(api: string): boolean {
	return (
		isAnthropicMessagesApi(api) ||
		isOpenAIResponsesApi(api) ||
		[
			"openai-completions",
			"google-generative-ai",
			"google-vertex",
			"bedrock-converse-stream",
			"mistral-conversations",
		].includes(api)
	);
}

/**
 * Minimum version per Claude line at which the API removed forced tool use:
 * `tool_choice` of type `tool` or `any` answers HTTP 400 "tool_choice: type
 * "tool" and "any" are not supported for this model", with or without
 * thinking. Later versions in a line keep the removal.
 */
const FORCED_TOOL_CHOICE_REMOVED_AT: Readonly<Record<string, readonly [number, number]>> = {
	sonnet: [5, 5],
	opus: [5, 5],
	fable: [5, 1],
	mythos: [5, 1],
};

/**
 * Whether the model rejects a forced tool choice. Matches first-party ids
 * (`claude-sonnet-5-5`), dated snapshots and platform-prefixed ids
 * (`anthropic.claude-opus-5-5`). The minor version is one or two digits so a
 * date suffix on a whole-number release is never read as a minor version.
 */
function rejectsForcedToolChoice(model: Pick<EngineModel, "id">): boolean {
	const match = /claude-(sonnet|opus|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?!\d)/u.exec(model.id);
	if (!match) return false;
	const removedAt = FORCED_TOOL_CHOICE_REMOVED_AT[match[1] ?? ""];
	if (!removedAt) return false;
	const major = Number(match[2]);
	const minor = match[3] === undefined ? 0 : Number(match[3]);
	return major > removedAt[0] || (major === removedAt[0] && minor >= removedAt[1]);
}

/** A terminal protocol round exposes one handoff tool, never the work surface. */
export function patchTerminalToolPayload(payload: unknown, model: EngineModel, toolName: string): unknown | undefined {
	if (!supportsNamedToolChoice(model.api)) return undefined;
	const patched = patchToolChoiceNamedPayload(payload, model, toolName);
	if (!isRecord(patched)) return undefined;
	// Named Anthropic choices normally preserve the schema cache. A terminal
	// handoff deliberately removes the work surface as well as requiring its name.
	if (isAnthropicMessagesApi(model.api)) {
		const tools = namedToolDefinitions(patched.tools, toolName);
		if (tools === null) return undefined;
		// The handoff tool is the only one attached, so auto with one call at most
		// is the forced round on models that reject a named choice.
		const toolChoice = rejectsForcedToolChoice(model)
			? { type: "auto", disable_parallel_tool_use: true }
			: { type: "tool", name: toolName, disable_parallel_tool_use: true };
		return { ...patched, tools, tool_choice: toolChoice };
	}
	if (model.api === "openai-completions" || isOpenAIResponsesApi(model.api)) {
		return { ...patched, parallel_tool_calls: false };
	}
	return patched;
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

/** One model round's tool routing, derived from the host's lock and middleware state. */
export type ToolRound = { kind: "text-only" } | { kind: "tools-removed" };

export interface ControlledRequest {
	context: Context;
	options: SimpleStreamOptions | undefined;
}

type Payload = Record<string, unknown>;

/** Run the caller's hook first, then one request-local edit, so the host's own patches still apply underneath. */
function withPayloadEdit(
	options: SimpleStreamOptions | undefined,
	edit: (payload: Payload) => Payload,
): SimpleStreamOptions {
	const previous = options?.onPayload;
	return {
		...options,
		onPayload: async (payload, model) => {
			const base = (await previous?.(payload, model)) ?? payload;
			return isRecord(base) ? edit(base) : base;
		},
	};
}

/**
 * A locked round has no tool declarations, so the body carries neither `tools`
 * nor `tool_choice`. Pi adds `tools: []` beside tool history on completions and
 * Codex always sends `tool_choice: "auto"`; both would change the body a
 * llama.cpp or LM Studio server sees from the one #78 was fixed with.
 */
function withoutToolSurface(payload: Payload): Payload {
	const next = { ...payload };
	if (!Array.isArray(next.tools) || next.tools.length === 0) {
		delete next.tools;
		delete next.tool_choice;
	}
	return next;
}

function hasToolHistory(messages: Context["messages"]): boolean {
	return messages.some(
		(message) =>
			message.role === "toolResult" ||
			(message.role === "assistant" && message.content.some((block) => block.type === "toolCall")),
	);
}

/**
 * The resolved context when the request carries a tool surface a lock can act
 * on, otherwise undefined (nothing to lock).
 */
function lockableContext(model: EngineModel, context: Context): Context | undefined {
	const resolved = resolvedRequestContext(context);
	// Pi adds `tools: []` beside tool history on completions, a surface Clio has
	// always locked; every other API serializes a tool surface only when tools
	// are declared.
	const hasSurface =
		(resolved.tools?.length ?? 0) > 0 || (model.api === "openai-completions" && hasToolHistory(resolved.messages));
	if (!hasSurface) return undefined;
	// Pi answers "none" on Converse by dropping toolConfig, which Bedrock rejects
	// beside toolUse and toolResult history. The lock stays off there, as it
	// always was, instead of failing every locked round with a ValidationException.
	if (model.api === "bedrock-converse-stream") return undefined;
	return resolved;
}

/**
 * Force a text-only round through Pi's `toolChoice: "none"`. Used while a
 * loop-guard synthesis lockout or a middleware lock is active: the lockout
 * directive alone relies on model compliance, and measured local models kept
 * calling tools until the backstop stopped the turn, throwing away everything
 * the turn had gathered. The tool schema bytes are untouched (the prompt
 * prefix and tool surface stay byte-stable); only this request's routing
 * changes, so prompt-prefix caches are unaffected.
 *
 * Returns undefined when the request carries no tool surface (nothing to lock).
 */
function textOnlyRound(
	model: EngineModel,
	context: Context,
	options: SimpleStreamOptions | undefined,
): ControlledRequest | undefined {
	if (lockableContext(model, context) === undefined) return undefined;
	return { context, options: { ...options, toolChoice: "none" } };
}

/**
 * Force a text-only round the hard way: remove the tool declarations from the
 * request. Used for a worker's synthesis-locked rounds (the loop-guard lockout
 * and the terminal result-contract repair). {@link textOnlyRound} is not enough
 * there: llama.cpp honors tool_choice "none" by disabling its tool-call parser
 * while the chat template still renders every tool schema, so a local model
 * that decides to call a tool anyway hands its markup back as content, the loop
 * guard strips it, and the worker ends with no result at all (a coder run that
 * had written and tested its file returned zero output this way, #78). With no
 * tools in the prompt the template renders no tool block and the model has
 * nothing to call. The prompt prefix changes for these one or two rounds; that
 * is the price of a usable answer.
 *
 * Anthropic keeps the tool_choice knob instead: its API rejects a history that
 * carries tool_use blocks unless tools are defined, and it honors none
 * properly. Google and Vertex take Pi's function-calling mode NONE.
 */
function toolsRemovedRound(
	model: EngineModel,
	context: Context,
	options: SimpleStreamOptions | undefined,
): ControlledRequest | undefined {
	const resolved = lockableContext(model, context);
	if (resolved === undefined) return undefined;
	if (model.api === "anthropic-messages" || model.api === "google-generative-ai" || model.api === "google-vertex") {
		return { context, options: { ...options, toolChoice: "none" } };
	}
	return { context: { ...resolved, tools: [] }, options: withPayloadEdit(options, withoutToolSurface) };
}

function applyToolRound(
	model: EngineModel,
	context: Context,
	options: SimpleStreamOptions | undefined,
	round: ToolRound,
): ControlledRequest | undefined {
	switch (round.kind) {
		case "text-only":
			return textOnlyRound(model, context, options);
		case "tools-removed":
			return toolsRemovedRound(model, context, options);
	}
}

/** Apply the first round that changes this request; later rounds are fallbacks. */
export function applyToolRounds(
	model: EngineModel,
	context: Context,
	options: SimpleStreamOptions | undefined,
	rounds: readonly (ToolRound | undefined)[],
): ControlledRequest {
	for (const round of rounds) {
		const controlled = round === undefined ? undefined : applyToolRound(model, context, options, round);
		if (controlled !== undefined) return controlled;
	}
	return { context, options };
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
		// These models reject any forced choice and cannot turn thinking off.
		// Narrowing the surface to the required tool under auto keeps the
		// requirement and leaves the configured thinking in place.
		if (rejectsForcedToolChoice(model)) return { ...payload, tools, tool_choice: { type: "auto" } };
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
		// Keep the cacheable schema prefix intact. The request-level choice
		// already identifies the required tool; narrowing changes it twice.
		return { ...patched, tool_choice: { type: "tool", name: toolName } };
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
		const toolChoice = rejectsForcedToolChoice(model) ? { auto: {} } : { tool: { name: toolName } };
		return { ...payload, toolConfig: { ...payload.toolConfig, tools, toolChoice } };
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

/** Attach the admitted runtime's JSON-schema constraint without changing its tool surface. */
function patchLlamaCppResponseSchemaPayload(
	payload: unknown,
	runtimeId: string,
	responseSchema: Record<string, unknown> | undefined,
): unknown | undefined {
	if (responseSchema === undefined) return undefined;
	if (runtimeId !== RESPONSE_SCHEMA_RUNTIME_ID && runtimeId !== GATEWAY_SCHEMA_RUNTIME_ID) {
		throw new Error(`responseSchema requires the native llamacpp or litellm runtime; received '${runtimeId}'`);
	}
	if (!isRecord(payload)) throw new Error("cannot apply responseSchema to a non-object provider payload");
	const dialect = responseSchemaDialectFor(runtimeId);
	return dialect === null
		? undefined
		: patchResponseSchemaPayloadForDialect(payload, dialect, responseSchema, "clio_result");
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
	responseSchema?: Record<string, unknown>;
	toolChoiceName?: string;
	/** Host-owned terminal handoff; takes precedence over the work-tool lock. */
	terminalToolName?: string;
}

// Identical local handbook runs shared few rules when servers sampled at their defaults.
const CONTEXT_GENERATION_SEED = 42;
const DETERMINISTIC_SAMPLING_RUNTIMES = new Set([
	"llamacpp",
	"llamacpp-completion",
	"lmstudio",
	"litellm",
	"lemonade",
	"sglang",
	"vllm",
	"openai-compat",
]);

/**
 * Stream options that make generated context reproducible, or undefined where
 * the API cannot take them. The caller merges the result over its own options
 * so these values beat quirk profiles and run overrides.
 *
 * Temperature appears twice on purpose: Pi applies `Model.samplingParams` and
 * then `options.samplingParams` after every named field, so a top-level
 * temperature alone would lose to a catalog default.
 */
export function deterministicSampling(
	model: EngineModel,
	runtimeId: string,
): Required<Pick<SimpleStreamOptions, "temperature" | "samplingParams">> | undefined {
	// Anthropic proxies reject non-default sampling even through a self-hosted gateway.
	if (/claude-/i.test(model.id)) return undefined;
	// Cloud dialects may reject a seed or zero temperature; only these self-hosted APIs accept both.
	const accepted =
		(model.api === "ollama-native" && runtimeId === "ollama") ||
		(model.api === "openai-completions" && DETERMINISTIC_SAMPLING_RUNTIMES.has(runtimeId));
	return accepted ? { temperature: 0, samplingParams: { temperature: 0, seed: CONTEXT_GENERATION_SEED } } : undefined;
}

/** Compose all worker-owned request mutations over one payload in a stable order. */
export function patchWorkerRequestPayload(
	payload: unknown,
	model: EngineModel,
	options: WorkerPayloadPatchOptions,
): unknown | undefined {
	let patched = payload;
	let changed = false;

	const schemaPatched = patchLlamaCppResponseSchemaPayload(patched, options.runtimeId, options.responseSchema);
	if (schemaPatched !== undefined) {
		patched = schemaPatched;
		changed = true;
	}

	if (options.terminalToolName !== undefined) {
		const terminal = patchTerminalToolPayload(patched, model, options.terminalToolName);
		if (terminal !== undefined) return terminal;
	}
	if (options.toolChoiceName !== undefined) {
		const toolChoicePatched = patchToolChoiceNamedPayload(patched, model, options.toolChoiceName);
		if (toolChoicePatched !== undefined) {
			patched = toolChoicePatched;
			changed = true;
		}
	}

	return changed ? patched : undefined;
}
