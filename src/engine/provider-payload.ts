import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	AnthropicOptions,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
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
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { safeResourceWrite } from "../core/safe-resource-write.js";
import { clioStatePath } from "../core/xdg.js";
import { resolvedRequestContext } from "./context.js";
import type { EngineModel, ToolRoundRecord } from "./types.js";

type Choice<T extends { toolChoice?: unknown }> = NonNullable<T["toolChoice"]>;
/**
 * Pi types Codex's option as the string choices only, but its body builder
 * copies `toolChoice` into `tool_choice` verbatim, so the Responses function
 * form reaches the wire as written.
 */
type CodexChoice = Choice<OpenAICodexResponsesOptions> | Extract<Choice<OpenAIResponsesOptions>, { type: "function" }>;

/**
 * Each API's own spelling of "call this tool", typed by that adapter's option
 * so a Pi release that renames a spelling fails the typecheck. Pi's
 * `streamSimple` copies `options.toolChoice` into the provider options
 * unchanged on all of these adapters. Generic OpenAI-compatible servers (LM
 * Studio, llama.cpp) answer HTTP 400 to the object form ("Invalid tool_choice
 * type: 'object'. Supported string values: none, auto, required"), so
 * completions use "required" over a one-tool surface, which is equivalent.
 * A terminal handoff on completions asks with {@link completionsNamedChoice}
 * first and keeps this spelling as its fallback.
 */
const NAMED_CHOICE = {
	"anthropic-messages": (name: string, rejected: boolean): Choice<AnthropicOptions> =>
		rejected ? "auto" : { type: "tool", name },
	"bedrock-converse-stream": (name: string, rejected: boolean): Choice<BedrockOptions> =>
		rejected ? "auto" : { type: "tool", name },
	"google-generative-ai": (_name: string, rejected: boolean): Choice<GoogleOptions> => (rejected ? "auto" : "any"),
	"google-vertex": (_name: string, rejected: boolean): Choice<GoogleVertexOptions> => (rejected ? "auto" : "any"),
	"mistral-conversations": (name: string, rejected: boolean): Choice<MistralOptions> =>
		rejected ? "auto" : { type: "function", function: { name } },
	"openai-responses": (name: string, rejected: boolean): Choice<OpenAIResponsesOptions> =>
		rejected ? "auto" : { type: "function", name },
	// Codex once rejected every forced choice ("Unsupported parameter:
	// 'tool_choice' is not supported by rustponsesapi", #426) and later a forced
	// choice on a tool-less WebSocket delta ("Tool choice 'required' must be
	// specified with 'tools' parameter"). Live on gpt-6-luna in November 2026 it
	// takes the named function choice over the full list declared in
	// additional_tools; a pinned round after an unpinned one changes tool_choice,
	// so Pi sends it whole rather than as a delta. A rejection before output
	// retries the round once with auto, remembered per target and model, and the
	// round keeps the full tool list either way, so the cached prefix survives.
	"openai-codex-responses": (name: string, rejected: boolean): CodexChoice =>
		rejected ? "auto" : { type: "function", name },
	"openai-completions": (_name: string, rejected: boolean): Choice<OpenAICompletionsOptions> =>
		rejected ? "auto" : "required",
} as const;

/** The completions spelling of one named tool, which vLLM, SGLang and hosted OpenAI-compatible APIs constrain to. */
const completionsNamedChoice = (name: string): Choice<OpenAICompletionsOptions> => ({
	type: "function",
	function: { name },
});

/** Why a completions route lost the named handoff choice when the reply, not the server, refused it. */
const NAMED_CHOICE_IGNORED = "named tool_choice not honoured on this route";

function isOpenAIResponsesApi(api: string): boolean {
	return api === "openai-codex-responses" || api === "openai-responses";
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
 * Whether a Claude line has reached a routing-policy threshold. Matches first-party ids
 * (`claude-sonnet-5-5`), dated snapshots and platform-prefixed ids
 * (`anthropic.claude-opus-5-5`, `anthropic/claude-opus-5.5`). The minor version is one or two digits so a
 * date suffix on a whole-number release is never read as a minor version.
 */
function claudeVersionAtLeast(
	model: Pick<EngineModel, "id">,
	minimumVersions: Readonly<Record<string, readonly [number, number]>>,
): boolean {
	const match = /claude-(sonnet|opus|fable|mythos|haiku)-(\d+)(?:[.-](\d{1,2}))?(?!\d)/u.exec(model.id);
	if (!match) return false;
	const removedAt = minimumVersions[match[1] ?? ""];
	if (!removedAt) return false;
	const major = Number(match[2]);
	const minor = match[3] === undefined ? 0 : Number(match[3]);
	return major > removedAt[0] || (major === removedAt[0] && minor >= removedAt[1]);
}

/**
 * One model round's tool routing, derived from the host's lock, middleware and
 * terminal-handoff state. `required` names one declared tool; `handoff` marks
 * the host-owned terminal result tool, whose round allows at most one call.
 * Anthropic retains the work surface to preserve its cached prefix (#423).
 */
export type ToolRound =
	| { kind: "text-only" }
	| { kind: "tools-removed" }
	| { kind: "required"; toolName: string; handoff?: boolean };

export interface ControlledRequest {
	toolRounds?: ToolRoundRecord[];
	context: Context;
	options: SimpleStreamOptions | undefined;
	/** The request {@link streamToolRound} sends instead when the server rejects this one's named choice. */
	fallback?: ControlledRequest;
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
 * nor `tool_choice`. Since Pi 1.5.2 completions send `tools: []` beside tool
 * history only when the model's compat sets `requiresToolsWithToolHistory`, and
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
	// Completions with tool history stay lockable even with no tools declared: a
	// compat with `requiresToolsWithToolHistory` still sends `tools: []` there
	// (Pi 1.5.2 omits it otherwise), and the round keeps the `tool_choice: "none"`
	// Clio has always sent. Every other API carries a tool surface only when tools
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
 * properly. Google and Vertex take Pi's function-calling mode NONE. The OpenAI
 * Responses APIs honor none too and keep their declarations: Codex sends them
 * as the first input item, so removing them made every locked round miss the
 * whole cached prefix.
 *
 * The Copilot SDK has no tool choice, and replacing a live session's tools
 * (setTools) made its locked round read none of the cached prefix (M-20). The
 * round keeps the session's tools; the lock directive rides the prompt and the
 * worker's synthesis lockout refuses a call at admission.
 */
function toolsRemovedRound(
	model: EngineModel,
	context: Context,
	options: SimpleStreamOptions | undefined,
): ControlledRequest | undefined {
	const resolved = lockableContext(model, context);
	if (resolved === undefined) return undefined;
	if (
		model.api === "anthropic-messages" ||
		model.api === "google-generative-ai" ||
		model.api === "google-vertex" ||
		isOpenAIResponsesApi(model.api)
	) {
		return { context, options: { ...options, toolChoice: "none" } };
	}
	if (model.api === "copilot-sdk") return { context, options };
	return { context: { ...resolved, tools: [] }, options: withPayloadEdit(options, withoutToolSurface) };
}

/**
 * Route this round to one declared tool. Anthropic and the OpenAI Responses
 * APIs (Codex included) keep the complete tool surface, including during
 * terminal handoff, to retain the cached schema prefix (#423): their named
 * choice picks the tool out of the full list, and a narrowed list would change
 * the tool declarations Pi places at the head of the prompt, so every pinned
 * round would miss the prefix cache. Other APIs narrow to the required tool,
 * so a spelling that cannot name one ("any", "required") still picks exactly
 * it. Returns undefined when the API has no spelling for it or the tool is not
 * declared.
 *
 * Claude models that accept a forced choice cannot think beside it, so the
 * round drops `reasoning`; the next round without one resumes the configured
 * level. Models rejecting forced choice and Anthropic Haiku 5.5 or later use
 * "auto" and retain thinking: Haiku's forced handoff missed the full message
 * cache (#423). The host retains a middleware requirement until its tool starts;
 * terminal handoffs additionally reject work calls and validate the result.
 * Bedrock Claude always narrows to the one tool.
 *
 * A worker's terminal handoff on completions keeps the full list too and names
 * the tool in the object form, so a local engine reuses the work phase's
 * prefill instead of rendering a new tool block (dynamo measured about 0.9 s
 * against 0.15 s warm). The narrowed "required" request rides along as the
 * fallback for a server that rejects the object form (llama.cpp, LM Studio);
 * that rejection, or a reply that ignores the choice, is remembered per target,
 * endpoint and model in the state root, and later handoffs there, in this
 * process or a later one, narrow from the start.
 */
function requiredRound(
	model: EngineModel,
	context: Context,
	options: SimpleStreamOptions | undefined,
	round: Extract<ToolRound, { kind: "required" }>,
	rejection?: string,
	namedRejection?: string,
): ControlledRequest | undefined {
	const api = model.api;
	const name = round.toolName;
	if (name.trim().length === 0 || !supportsNamedToolChoice(api)) return undefined;
	const resolved = resolvedRequestContext(context);
	const tools = resolved.tools ?? [];
	if (!tools.some((tool) => tool.name === name)) return undefined;
	const rejected = rejection !== undefined || claudeVersionAtLeast(model, FORCED_TOOL_CHOICE_REMOVED_AT);
	const automatic = rejected || (api === "anthropic-messages" && claudeVersionAtLeast(model, { haiku: [5, 5] }));
	// Pi types SimpleStreamOptions.toolChoice as "auto" | "none" yet forwards it
	// verbatim into each adapter's own option, which NAMED_CHOICE is typed against.
	const toolChoice = NAMED_CHOICE[api](name, automatic) as NonNullable<SimpleStreamOptions["toolChoice"]>;
	let next: SimpleStreamOptions = { ...options, toolChoice };
	const narrowed: Context =
		api === "anthropic-messages" || isOpenAIResponsesApi(api)
			? context
			: { ...resolved, tools: tools.filter((tool) => tool.name === name) };
	if (!automatic && (api === "anthropic-messages" || (api === "bedrock-converse-stream" && /claude/iu.test(model.id)))) {
		const { reasoning: _reasoning, ...withoutReasoning } = next;
		next = withoutReasoning;
		if (api === "anthropic-messages") {
			next = withPayloadEdit(next, withoutThinking);
		}
	}
	if (round.handoff === true) next = withPayloadEdit(next, (payload) => singleCall(api, payload));
	const request: ControlledRequest = { context: narrowed, options: next };
	if (api === "openai-completions" && round.handoff === true && !automatic && namedRejection === undefined) {
		const named = completionsNamedChoice(name) as NonNullable<SimpleStreamOptions["toolChoice"]>;
		return { context, options: { ...next, toolChoice: named }, fallback: request };
	}
	return request;
}

function applyToolRound(
	model: EngineModel,
	context: Context,
	options: SimpleStreamOptions | undefined,
	round: ToolRound,
	rejection?: string,
	namedRejection?: string,
): ControlledRequest | undefined {
	switch (round.kind) {
		case "text-only":
			return textOnlyRound(model, context, options);
		case "tools-removed":
			return toolsRemovedRound(model, context, options);
		case "required":
			return requiredRound(model, context, options, round, rejection, namedRejection);
	}
}

// A rejected required/named choice says nothing about none. Keep those
// capabilities separate within each target and model so text locks survive (#426).
const rejectedChoices = new Map<string, string>();

function choiceKey(model: EngineModel, targetId: string, kind: "forced" | "named" | "none"): string {
	return JSON.stringify([targetId, model.api, model.provider, model.baseUrl, model.id, kind]);
}

/**
 * Completions endpoints that refused or ignored the named handoff choice, kept in the state root so a later process
 * on the same target, endpoint and model sends the narrowed request at once instead of paying the refused round
 * again (dynamo: LM Studio behind LiteLLM). Pi declares no tool_choice capability for completions, so the first
 * refusal is the only source. Best effort: an unreadable or unwritable file costs that one round again. A mark
 * expires after a week, so a backend swapped behind the same endpoint is asked again.
 */
const NAMED_CHOICE_MARK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function namedChoiceMarksPath(): string {
	return join(clioStatePath(), "tool-choice-routes.json");
}

function readNamedChoiceMarks(): Record<string, { reason: string; at: number }> {
	const marks: Record<string, { reason: string; at: number }> = {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(namedChoiceMarksPath(), "utf8"));
		if (typeof parsed !== "object" || parsed === null) return marks;
		const now = Date.now();
		for (const [key, value] of Object.entries(parsed)) {
			const { reason, at } = (value ?? {}) as { reason?: unknown; at?: unknown };
			if (typeof reason === "string" && typeof at === "number" && now - at < NAMED_CHOICE_MARK_TTL_MS) {
				marks[key] = { reason, at };
			}
		}
	} catch {
		/* No file yet, or a damaged one: nothing learned. */
	}
	return marks;
}

function namedChoiceRejection(model: EngineModel, targetId: string): string | undefined {
	const key = choiceKey(model, targetId, "named");
	const known = rejectedChoices.get(key);
	if (known !== undefined) return known;
	const persisted = readNamedChoiceMarks()[key]?.reason;
	if (persisted !== undefined) rejectedChoices.set(key, persisted);
	return persisted;
}

function rememberNamedChoiceRejection(model: EngineModel, targetId: string, reason: string): void {
	const key = choiceKey(model, targetId, "named");
	rejectedChoices.set(key, reason);
	try {
		const marks = readNamedChoiceMarks();
		marks[key] = { reason, at: Date.now() };
		safeResourceWrite(namedChoiceMarksPath(), `${JSON.stringify(marks, null, 2)}\n`, { mode: 0o600 });
	} catch {
		/* Kept for this process only. */
	}
}

/** Apply the first round that changes this request; later rounds are fallbacks. */
export function applyToolRounds(
	model: EngineModel,
	context: Context,
	options: SimpleStreamOptions | undefined,
	rounds: readonly (ToolRound | undefined)[],
	targetId = model.provider,
): ControlledRequest {
	for (const round of rounds) {
		if (round === undefined) continue;
		const rejection = rejectedChoices.get(choiceKey(model, targetId, round.kind === "required" ? "forced" : "none"));
		const namedRejection =
			round.kind === "required" && round.handoff === true && model.api === "openai-completions"
				? namedChoiceRejection(model, targetId)
				: undefined;
		let controlled = applyToolRound(model, context, options, round, rejection, namedRejection);
		if (controlled === undefined) continue;
		if (rejection !== undefined && controlled.options?.toolChoice === "none") {
			controlled = { ...controlled, options: { ...controlled.options, toolChoice: "auto" } };
		}
		const choice =
			round.kind === "tools-removed" && (resolvedRequestContext(controlled.context).tools?.length ?? 0) === 0
				? null
				: (controlled.options?.toolChoice ?? null);
		const downgradeReason =
			rejection ??
			namedRejection ??
			(round.kind === "required" && choice === "auto"
				? model.api === "anthropic-messages" && claudeVersionAtLeast(model, { haiku: [5, 5] })
					? "Anthropic cache-preserving tool routing (#423)"
					: "Model does not support forced tool_choice"
				: undefined);
		return {
			...controlled,
			toolRounds: [
				{
					kind: round.kind,
					...(round.kind === "required" ? { toolName: round.toolName } : {}),
					choice,
					attempt: 0,
					...(downgradeReason !== undefined ? { downgradeReason } : {}),
				},
			],
		};
	}
	return { context, options };
}

/**
 * Radiance and SGLang drop the tool block from the rendered prompt when tool_choice is "none", and Qwen-family
 * templates render tools first, so a text-only round there re-reads the whole prompt; llama.cpp and vLLM keep it.
 * The runtime id cannot tell which engine is behind a route, so a route is learned: a "none" round whose cache read
 * fell below half of the previous call's on the same route marks it. An engine that reports no cached count teaches
 * nothing. The mark is per process.
 */
const NONE_RERENDERS = "none re-renders the prompt on this route";
const noneRerenders = new Set<string>();
const priorCacheRead = new Map<string, number>();

function noteCacheRead(key: string, message: AssistantMessage, choice: unknown): void {
	const cacheRead = message.usage?.cacheRead;
	if (message.stopReason === "error" || message.stopReason === "aborted" || typeof cacheRead !== "number") return;
	const prior = priorCacheRead.get(key);
	if (choice === "none" && prior !== undefined && prior > 0 && cacheRead < prior / 2) noneRerenders.add(key);
	priorCacheRead.set(key, cacheRead);
}

/**
 * The request `streamToolRound` invokes first: on a route where "none" re-renders, a text-only round asks with "auto"
 * beside the lockout directive. Admission prices this same request (F15).
 */
export function firstToolRoundAttempt(
	model: EngineModel,
	controlled: ControlledRequest,
	targetId = model.provider,
): ControlledRequest {
	return controlled.toolRounds?.[0]?.kind === "text-only" &&
		controlled.options?.toolChoice === "none" &&
		noneRerenders.has(choiceKey(model, targetId, "none"))
		? { ...controlled, options: { ...controlled.options, toolChoice: "auto" } }
		: controlled;
}

/**
 * Retry only a rejected routing parameter before output, with one auto attempt (#426). On a route where "none" is
 * known to re-render, a text-only round first asks with "auto" beside the lockout directive, which keeps the cached
 * prefix; a reply that calls a tool anyway is discarded and the round is sent again with "none".
 */
export function streamToolRound(
	model: EngineModel,
	controlled: ControlledRequest,
	invoke: (request: ControlledRequest) => AssistantMessageEventStream,
	targetId = model.provider,
	observeRetry?: (message: AssistantMessage) => void,
): AssistantMessageEventStream {
	const routeKey = choiceKey(model, targetId, "none");
	const initial = controlled.toolRounds?.[0];
	const observed = (request: ControlledRequest): AssistantMessageEventStream => {
		const stream = invoke(request);
		const choice = request.options?.toolChoice;
		void stream.result().then(
			(message) => {
				noteCacheRead(routeKey, message, choice);
				// A server that accepts the named choice but does not constrain to it narrows later handoffs instead.
				const named = initial?.toolName;
				if (
					request.fallback !== undefined &&
					named !== undefined &&
					(message.stopReason === "stop" || message.stopReason === "toolUse") &&
					!message.content.some((block) => block.type === "toolCall" && block.name === named)
				) {
					rememberNamedChoiceRejection(model, targetId, NAMED_CHOICE_IGNORED);
				}
			},
			() => {},
		);
		return stream;
	};
	if (!initial) return observed(controlled);
	const output = createAssistantMessageEventStream();
	const first = firstToolRoundAttempt(model, controlled, targetId);
	const complianceFirst = first !== controlled;
	const records = [complianceFirst ? { ...initial, choice: "auto" as const, downgradeReason: NONE_RERENDERS } : initial];
	const annotate = (event: AssistantMessageEvent): AssistantMessageEvent => {
		if ("partial" in event) Object.assign(event.partial, { toolRounds: records });
		if (event.type === "done") Object.assign(event.message, { toolRounds: records });
		if (event.type === "error") Object.assign(event.error, { toolRounds: records });
		return event;
	};
	void (async () => {
		let source: AssistantMessageEventStream | undefined;
		try {
			if (complianceFirst) {
				// Held whole: a reply that calls a tool is thrown away, so none of it may reach the transcript.
				source = observed(first);
				const held: AssistantMessageEvent[] = [];
				for await (const event of source) held.push(event);
				const reply = await source.result();
				if (reply.stopReason === "error" || !reply.content.some((block) => block.type === "toolCall")) {
					for (const event of held) output.push(annotate(event));
					output.end(Object.assign(reply, { toolRounds: records }));
					return;
				}
				try {
					observeRetry?.(reply);
				} catch {
					/* Telemetry cannot change provider retry behavior (#434). */
				}
				records.push({ ...initial, attempt: 1 });
			}
			source = observed(controlled);
			let held: AssistantMessageEvent[] | null = [];
			for await (const event of source) {
				if (held !== null && event.type === "start") {
					held.push(annotate(event));
					continue;
				}
				const message = event.type === "error" ? (event.error.errorMessage ?? "") : "";
				const choice = controlled.options?.toolChoice;
				// Pi serializes some HTTP 400s as bare parameter errors. Match that
				// spelling as well, but never retry auth/rate/server failures (#426).
				const status = /\b[45]\d\d\b/u.exec(message)?.[0];
				const rejected =
					/tool[_ ]choice/iu.test(message) &&
					(status === "400" ||
						(status === undefined &&
							/unsupported parameter|not supported|invalid.*tool_choice|must be specified with.*tools|not found in.*tools.*parameter/iu.test(
								message,
							)));
				if (held !== null && rejected && choice !== undefined && choice !== "auto") {
					try {
						if (event.type === "error") observeRetry?.(event.error);
					} catch {
						/* Telemetry cannot change provider retry behavior (#434). */
					}
					const reason = (message.split("\n\n")[0] ?? message).slice(0, 512);
					const fallback = controlled.fallback;
					if (fallback !== undefined) rememberNamedChoiceRejection(model, targetId, reason);
					else rejectedChoices.set(choiceKey(model, targetId, choice === "none" ? "none" : "forced"), reason);
					const retry: ControlledRequest =
						fallback !== undefined
							? { ...fallback, ...(controlled.toolRounds ? { toolRounds: controlled.toolRounds } : {}) }
							: { ...controlled, options: { ...controlled.options, toolChoice: "auto" } };
					const retryChoice = retry.options?.toolChoice ?? null;
					records.push({ ...initial, choice: retryChoice, attempt: 1, downgradeReason: reason });
					source = invoke(retry);
					for await (const retryEvent of source) output.push(annotate(retryEvent));
					output.end(Object.assign(await source.result(), { toolRounds: records }));
					return;
				}
				if (held !== null) for (const pending of held) output.push(pending);
				held = null;
				output.push(annotate(event));
			}
			if (held !== null) for (const pending of held) output.push(pending);
			output.end(Object.assign(await source.result(), { toolRounds: records }));
		} catch (error) {
			// A thrown delegate must settle the stream too, including the retry;
			// preserve the provider fault instead of leaving the agent waiting (#426).
			const message = {
				role: "assistant" as const,
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					// This synthetic fault has no metered provider usage (#423).
					callInvoked: false,
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "error" as const,
				errorMessage: error instanceof Error ? error.message : String(error),
				timestamp: Date.now(),
				toolRounds: records,
			};
			output.push({ type: "error", reason: "error", error: message });
			output.end(message);
		}
	})();
	return output;
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
