import type {
	AnthropicOptions,
	AzureOpenAIResponsesOptions,
	BedrockOptions,
	Context,
	GoogleOptions,
	GoogleVertexOptions,
	MistralOptions,
	OpenAICodexResponsesOptions,
	OpenAICompletionsOptions,
	OpenAIResponsesOptions,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { resolvedRequestContext } from "./context.js";
import type { EngineModel } from "./types.js";

type Choice<T extends { toolChoice?: unknown }> = NonNullable<T["toolChoice"]>;

/**
 * Each API's own spelling of "call this tool", typed by that adapter's option
 * so a Pi release that renames a spelling fails the typecheck. Pi's
 * `streamSimple` copies `options.toolChoice` into the provider options
 * unchanged on all of these adapters. Generic OpenAI-compatible servers (LM
 * Studio, llama.cpp) answer HTTP 400 to the object form ("Invalid tool_choice
 * type: 'object'. Supported string values: none, auto, required"), so
 * completions use "required" over a one-tool surface, which is equivalent.
 */
const NAMED_CHOICE = {
	"anthropic-messages": (name: string, rejected: boolean): Choice<AnthropicOptions> =>
		rejected ? "auto" : { type: "tool", name },
	"bedrock-converse-stream": (name: string, rejected: boolean): Choice<BedrockOptions> =>
		rejected ? "auto" : { type: "tool", name },
	"google-generative-ai": (): Choice<GoogleOptions> => "any",
	"google-vertex": (): Choice<GoogleVertexOptions> => "any",
	"mistral-conversations": (name: string): Choice<MistralOptions> => ({ type: "function", function: { name } }),
	"openai-responses": (name: string): Choice<OpenAIResponsesOptions> => ({ type: "function", name }),
	"azure-openai-responses": (name: string): Choice<AzureOpenAIResponsesOptions> => ({ type: "function", name }),
	"openai-codex-responses": (): Choice<OpenAICodexResponsesOptions> => "required",
	"openai-completions": (): Choice<OpenAICompletionsOptions> => "required",
} as const;

function isOpenAIResponsesApi(api: string): boolean {
	return api === "openai-codex-responses" || api === "openai-responses" || api === "azure-openai-responses";
}

/** APIs whose named-tool request is expressible as a Pi tool choice. */
export function supportsNamedToolChoice(api: string): api is keyof typeof NAMED_CHOICE {
	return Object.hasOwn(NAMED_CHOICE, api);
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
 * (`anthropic.claude-opus-5-5`, `anthropic/claude-opus-5.5`). The minor version is one or two digits so a
 * date suffix on a whole-number release is never read as a minor version.
 */
function rejectsForcedToolChoice(model: Pick<EngineModel, "id">): boolean {
	const match = /claude-(sonnet|opus|fable|mythos)-(\d+)(?:[.-](\d{1,2}))?(?!\d)/u.exec(model.id);
	if (!match) return false;
	const removedAt = FORCED_TOOL_CHOICE_REMOVED_AT[match[1] ?? ""];
	if (!removedAt) return false;
	const major = Number(match[2]);
	const minor = match[3] === undefined ? 0 : Number(match[3]);
	return major > removedAt[0] || (major === removedAt[0] && minor >= removedAt[1]);
}

/**
 * One model round's tool routing, derived from the host's lock, middleware and
 * terminal-handoff state. `required` names one declared tool; `handoff` marks
 * the host-owned terminal result tool, whose round drops the work surface and
 * allows at most one call.
 */
export type ToolRound =
	| { kind: "text-only" }
	| { kind: "tools-removed" }
	| { kind: "required"; toolName: string; handoff?: boolean };

export interface ControlledRequest {
	context: Context;
	options: SimpleStreamOptions | undefined;
}

type Payload = Record<string, unknown>;

function isRecord(value: unknown): value is Payload {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
 * A forced choice is exclusive with thinking on Anthropic. Leaving `reasoning`
 * unset turns thinking off on most models, but Pi sends adaptive thinking and
 * `output_config.effort` on managed-effort ones whatever `reasoning` says, so
 * the forced round strips both from the body.
 */
function withoutThinking(payload: Payload): Payload {
	const next = { ...payload };
	delete next.thinking;
	if (isRecord(next.output_config) && "effort" in next.output_config) {
		const { effort: _effort, ...rest } = next.output_config;
		if (Object.keys(rest).length > 0) next.output_config = rest;
		else delete next.output_config;
	}
	return next;
}

/**
 * Pi has no parallel-call option on any adapter, so the single-handoff
 * guarantee is a body edit: Anthropic's `disable_parallel_tool_use` and the
 * `parallel_tool_calls: false` of completions and the Responses APIs.
 */
function singleCall(api: string, payload: Payload): Payload {
	if (api === "anthropic-messages" && isRecord(payload.tool_choice)) {
		return { ...payload, tool_choice: { ...payload.tool_choice, disable_parallel_tool_use: true } };
	}
	if (api === "openai-completions" || isOpenAIResponsesApi(api)) return { ...payload, parallel_tool_calls: false };
	return payload;
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
 * Force a text-only round through Pi's `toolChoice: "none"`. The interactive
 * loop uses it for both the loop-guard synthesis lockout and a middleware lock.
 * A worker uses it only for a middleware lock, because its synthesis lock goes
 * through {@link toolsRemovedRound}. The lockout directive alone relies on
 * model compliance, and measured local models kept calling tools until the
 * backstop stopped the turn, throwing away everything the turn had gathered.
 * The tool schema bytes are untouched (the prompt prefix and tool surface stay
 * byte-stable); only this request's routing changes, so prompt-prefix caches
 * are unaffected.
 *
 * Returns undefined when the request carries no tool surface (nothing to lock)
 * and on Bedrock Converse, where the lock stays off (see {@link lockableContext}).
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
 * request. Used for a worker's synthesis-locked rounds, which cover the
 * loop-guard lockout and the final-only result-contract repair. A terminal
 * handoff round goes first when the run has a helper result tool and the API
 * can name a tool, so this round serves the locked rounds without a handoff.
 * {@link textOnlyRound} is not enough there: llama.cpp honors tool_choice "none"
 * by disabling its tool-call parser while the chat template still renders every
 * tool schema, so a local model that decides to call a tool anyway hands its
 * markup back as content, the loop guard strips it, and the worker ends with no
 * result at all (a coder run that had written and tested its file returned zero
 * output this way, #78). With no tools in the prompt the template renders no
 * tool block and the model has nothing to call. The prompt prefix changes for
 * these one or two rounds; that is the price of a usable answer.
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

/**
 * Require one declared tool for this round through the API's own tool-choice
 * option. The request narrows to that tool, so a spelling that cannot name a
 * tool ("any", "required") still picks exactly it. Returns undefined when the
 * API has no spelling for it or the tool is not declared.
 *
 * Claude models that accept a forced choice cannot think beside it, so the
 * round drops `reasoning`; the next round without one resumes the configured
 * level. On the Anthropic API they keep the full tool array on a work round so
 * the cacheable schema prefix stays intact, and only a terminal handoff drops
 * the work surface. Bedrock Claude always narrows to the one tool. Models that
 * reject a forced choice stay on "auto" over the narrowed surface and keep
 * their thinking.
 */
function requiredRound(
	model: EngineModel,
	context: Context,
	options: SimpleStreamOptions | undefined,
	round: Extract<ToolRound, { kind: "required" }>,
): ControlledRequest | undefined {
	const api = model.api;
	const name = round.toolName;
	if (name.trim().length === 0 || !supportsNamedToolChoice(api)) return undefined;
	const resolved = resolvedRequestContext(context);
	const tools = resolved.tools ?? [];
	if (!tools.some((tool) => tool.name === name)) return undefined;
	const rejected = rejectsForcedToolChoice(model);
	// Pi types SimpleStreamOptions.toolChoice as "auto" | "none" yet forwards it
	// verbatim into each adapter's own option, which NAMED_CHOICE is typed against.
	const toolChoice = NAMED_CHOICE[api](name, rejected) as NonNullable<SimpleStreamOptions["toolChoice"]>;
	let next: SimpleStreamOptions = { ...options, toolChoice };
	let narrowed: Context = { ...resolved, tools: tools.filter((tool) => tool.name === name) };
	if (!rejected && (api === "anthropic-messages" || (api === "bedrock-converse-stream" && /claude/iu.test(model.id)))) {
		const { reasoning: _reasoning, ...withoutReasoning } = next;
		next = withoutReasoning;
		if (api === "anthropic-messages") {
			next = withPayloadEdit(next, withoutThinking);
			if (round.handoff !== true) narrowed = context;
		}
	}
	if (round.handoff === true) next = withPayloadEdit(next, (payload) => singleCall(api, payload));
	return { context: narrowed, options: next };
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
		case "required":
			return requiredRound(model, context, options, round);
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
