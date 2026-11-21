import { createHash } from "node:crypto";
import type { Api, Context, Model, SimpleStreamOptions, StreamOptions } from "@earendil-works/pi-ai";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import { resolvedRequestContext } from "../context.js";
import type { CodexConfiguration } from "../types.js";
import type { PinnedPromptPrefix } from "./anthropic-system-split.js";

/** The stable head of one worker request: what its provider can serve from a prefix cache. */
export interface CacheFamilyInput {
	api: string;
	provider: string;
	modelId: string;
	/** The Responses APIs render the reasoning effort ahead of the whole input, so two levels never share a prefix. */
	thinkingLevel: string;
	systemPrompt: string;
	tools: ReadonlyArray<{ name: string; description: string; parameters: unknown }>;
	/** The dispatcher's lane for this run among the live workers of this head. */
	lane: number;
}

/**
 * APIs whose backend routes a request to its prefix cache by the session id Pi sends, as measured: the Codex
 * `session-id` header. Anthropic, Copilot and the chat-completions engines look a prefix up by its content alone.
 * The public Responses API takes `prompt_cache_key` as a routing hint too, but it is unmeasured here and stays out.
 */
const SESSION_ROUTED_APIS: ReadonlySet<string> = new Set(["openai-codex-responses"]);

/**
 * The session id workers with one stable head and lane take on a session-routed API, or undefined where the id plays
 * no part in cache lookup. A random id per worker routed each worker on its own there, so a worker rarely read the
 * head an identical earlier worker had written (FL-17).
 *
 * Measured on gpt-6-luna, 2026-11-20: two requests with identical leading items read 0 of 4,614 prompt tokens under
 * different `session-id` headers whatever the body `prompt_cache_key` said, and 4,480 under one header. The backend
 * reuses whole leading input items only, so the id covers exactly the items every member sends first: the tool
 * declarations and the system prompt. A request sent within about one second of the first one that wrote the head
 * still reads nothing.
 *
 * The id is a routing affinity, not a partition: a few requests miss under one id and a few hit across ids. Live
 * conversations that share an id lose their own history more often, so the dispatcher gives each live member a lane
 * of its own (`claimCacheLane`) and the lane is part of the id.
 *
 * The id is content, not a session: workers of a later session reuse the head while the backend still holds it, and
 * the parent session's own affinity carries none of its workers' traffic.
 */
export function workerCacheFamilyId(input: CacheFamilyInput): string | undefined {
	if (!SESSION_ROUTED_APIS.has(input.api)) return undefined;
	// At most 64 characters, the length Pi clamps a prompt cache key to.
	return `clio-coder-w-${headDigest(input)}-${input.lane % 1_000_000}`;
}

/**
 * The session id a tool-free side call (memory retention and review, judges) takes on a session-routed API, or
 * undefined where the id plays no part in cache lookup (OI-6). Without one Pi sends no `session-id` header, so each
 * side call is routed on its own and never reads the system prompt an identical earlier call wrote. A side call has
 * no history of its own, so calls of one head share the id without a lane: each sends its full input, and the
 * backend reuses only the leading items they have in common.
 */
export function sideCallCacheFamilyId(input: Omit<CacheFamilyInput, "tools" | "lane">): string | undefined {
	if (!SESSION_ROUTED_APIS.has(input.api)) return undefined;
	return `clio-coder-s-${headDigest({ ...input, tools: [] })}`;
}

/** The option a routed main request carries its own conversation id in, for the state that belongs to one session. */
const CONVERSATION = "clioCoderConversation";

/** The lane each live main conversation of this process holds, and the lanes each head has taken. */
const mainLaneOf = new Map<string, { head: string; lane: number }>();
const mainLanesOf = new Map<string, Set<number>>();
/** Long-lived hosts open many sessions; a conversation never cleaned up must not hold a lane forever. */
const MAX_MAIN_CONVERSATIONS = 256;

function releaseMainLane(conversation: string): void {
	const held = mainLaneOf.get(conversation);
	if (held === undefined) return;
	mainLaneOf.delete(conversation);
	const lanes = mainLanesOf.get(held.head);
	lanes?.delete(held.lane);
	if (lanes?.size === 0) mainLanesOf.delete(held.head);
}

registerSessionResourceCleanup((sessionId) => {
	if (sessionId !== undefined) return releaseMainLane(sessionId);
	mainLaneOf.clear();
	mainLanesOf.clear();
});

/**
 * The lane a live main conversation takes among this process's live conversations of one head, as workers take one
 * through `claimCacheLane` (FL-17): the lowest free lane, kept across its turns and released when its session
 * resources are (a /new, /resume, a route change, a closed host session). Sessions one after another take lane 0 and
 * share the head's cache; concurrent ones (several herdr lanes on one install, an ACP or GUI host holding several
 * sessions) stop sharing one id, under which live conversations lose their own history more often.
 */
function claimMainLane(head: string, conversation: string): number {
	const held = mainLaneOf.get(conversation);
	if (held?.head === head) return held.lane;
	releaseMainLane(conversation);
	if (mainLaneOf.size >= MAX_MAIN_CONVERSATIONS) {
		const oldest = mainLaneOf.keys().next().value;
		if (oldest !== undefined) releaseMainLane(oldest);
	}
	const lanes = mainLanesOf.get(head) ?? new Set<number>();
	mainLanesOf.set(head, lanes);
	let lane = 0;
	while (lanes.has(lane)) lane += 1;
	lanes.add(lane);
	mainLaneOf.set(conversation, { head, lane });
	return lane;
}

/**
 * A main session's request with the cache routing id of its pinned head on a session-routed API (M-11). The main
 * thread keyed its routing by its own session id, so a new session never read the tools and install-wide pinned
 * layer an identical earlier session had written, although both sent them byte for byte; only the session layer
 * after them differs between sessions and repositories. Pi derives the body `prompt_cache_key` and the `session-id`
 * header from `sessionId`, so the routing id takes that place, and the session's own id moves to a private option
 * that the per-conversation state (turn state, WebSocket continuation) keys on through `cacheConversationOf`.
 *
 * The id covers the items every such session sends first: the tool declarations and the pinned layer, which the
 * request's prefix hash names, and ends in the conversation's lane (`claimMainLane`) as a worker's does. A prompt
 * that does not lead with that layer, or a request with cache retention off, keeps the session's own id. A request
 * already routed passes through unchanged.
 */
export function withMainCacheRouting<T extends StreamOptions | SimpleStreamOptions>(
	model: Model<Api>,
	context: Context,
	options: T | undefined,
): T | undefined {
	if (options !== undefined && Object.hasOwn(options, CONVERSATION)) return options;
	const conversation = options?.sessionId;
	if (!SESSION_ROUTED_APIS.has(model.api) || !conversation || options.cacheRetention === "none") return options;
	const extra = options as T & { clioCoderPinnedPrefix?: PinnedPromptPrefix; codexConfiguration?: CodexConfiguration };
	const pinned = extra.clioCoderPinnedPrefix;
	const { systemPrompt, tools } = resolvedRequestContext(context);
	if (
		pinned === undefined ||
		typeof systemPrompt !== "string" ||
		systemPrompt.length <= pinned.chars ||
		createHash("sha256").update(systemPrompt.slice(0, pinned.chars)).digest("hex") !== pinned.hash
	)
		return options;
	const head = headDigest({
		api: model.api,
		provider: model.provider,
		modelId: model.id,
		// The top-level effort the Codex body carries: a generation's initial one, else the request's own.
		thinkingLevel: extra.codexConfiguration?.initialEffort ?? (options as SimpleStreamOptions).reasoning ?? "off",
		systemPrompt: `pinned:${pinned.chars}:${pinned.hash}`,
		tools: tools ?? [],
	});
	// At most 60 characters, under the 64 Pi clamps a prompt cache key to.
	const lane = claimMainLane(head, conversation) % 1_000_000;
	return { ...options, sessionId: `clio-coder-m-${head}-${lane}`, [CONVERSATION]: conversation };
}

/**
 * The conversation a request's per-session state belongs to: a routed main request's own session, else its session
 * id; none with cache retention off, where Pi sends no session either.
 */
export function cacheConversationOf(options: StreamOptions | undefined): string | undefined {
	if (options?.cacheRetention === "none") return undefined;
	const conversation = (options as Record<string, unknown> | undefined)?.[CONVERSATION];
	return typeof conversation === "string" ? conversation : options?.sessionId;
}

/** The request as Pi takes it: the conversation id is Clio's own and never reaches a provider option surface. */
export function withoutCacheConversation<T extends StreamOptions>(options: T | undefined): T | undefined {
	if (options === undefined || !Object.hasOwn(options, CONVERSATION)) return options;
	const { [CONVERSATION]: _conversation, ...rest } = options as T & { [CONVERSATION]?: string };
	return rest as T;
}

function headDigest(input: Omit<CacheFamilyInput, "lane">): string {
	const head = JSON.stringify([
		input.api,
		input.provider,
		input.modelId,
		input.thinkingLevel,
		input.systemPrompt,
		input.tools.map((tool) => [tool.name, tool.description, tool.parameters]),
	]);
	return createHash("sha256").update(head).digest("hex").slice(0, 40);
}
