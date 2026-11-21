import { createHash } from "node:crypto";
import type { Api, Context, Model, SimpleStreamOptions, StreamOptions } from "@earendil-works/pi-ai";
import { registerSessionResourceCleanup } from "@earendil-works/pi-ai";
import { StateFileLockTimeoutError } from "../../core/state-file-lock.js";
import { telemetryHub } from "../../core/telemetry/hub.js";
import { resolvedRequestContext } from "../context.js";
import type { CodexConfiguration } from "../types.js";
import type { PinnedPromptPrefix } from "./anthropic-system-split.js";
import { declareRuntimeNoticeProducer } from "./residency.js";

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
 * conversations that share an id lose their own history more often, so each live worker takes a lane of its own on
 * its capacity lease (`claimWorkerCacheLane`), seen by every process of the state dir, and the lane is part of the id.
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

/**
 * Where main sessions claim their cache lanes across processes: the dispatch admission store registers itself at
 * boot (M-11), so two processes on one install never put two live conversations on one routing id.
 */
export interface MainCacheLaneStore {
	claim(key: string, conversation: string): number;
	/** Release this process's lane of one conversation, or all of them when none is named. */
	release(conversation: string | undefined): void;
}
let laneStore: MainCacheLaneStore | undefined;
export function useMainCacheLaneStore(store: MainCacheLaneStore | undefined): void {
	laneStore = store;
}

/** The lane each live main conversation of this process holds; `shared` when the store holds it. */
const mainLaneOf = new Map<string, { key: string; lane: number; shared: boolean; claimedAt: number }>();
/** The fallback's lanes by key, for conversations the store could not take. */
const localLanesOf = new Map<string, Set<number>>();
/** Long-lived hosts open many sessions; a conversation never cleaned up must not hold a lane forever. */
const MAX_MAIN_CONVERSATIONS = 256;
/** A held store lane is renewed this often, well inside the store's one-hour expiry for owners without a birth token. */
const STORE_RENEW_MS = 10 * 60_000;
/** Conversations already told that their lane is this process's own; the host says so once per conversation. */
const fallbackNoticed = new Set<string>();
const emitLaneFallbackNotice = declareRuntimeNoticeProducer("main-cache-lane", ["cache-lane-fallback"]);

/**
 * The store could not take a conversation's claim, so its turn runs on an in-process lane: journal each fallback and
 * tell the operator once per conversation, in host text, since a concurrent process may now share its routing id.
 */
function reportLaneFallback(conversation: string, lane: number, error: unknown, model: Model<Api>): void {
	const timeoutMs = error instanceof StateFileLockTimeoutError ? error.timeoutMs : null;
	try {
		telemetryHub().emit("cache.lane_fell_back", {
			reason: timeoutMs !== null ? "lock-timeout" : "store-failed",
			timeoutMs,
			lane,
		});
	} catch {
		// Telemetry never stops a turn.
	}
	if (fallbackNoticed.has(conversation)) return;
	fallbackNoticed.add(conversation);
	const why =
		timeoutMs !== null
			? `another Clio process held the dispatch admission lock past ${timeoutMs} ms`
			: `the dispatch admission store failed (${error instanceof Error ? error.message : String(error)})`;
	emitLaneFallbackNotice({
		kind: "cache-lane-fallback",
		level: "info",
		targetId: model.provider,
		runtimeId: model.provider,
		model: model.id,
		message: `Prompt cache routing for this conversation uses an in-process cache lane: ${why}. A concurrent session on this install may share its cache routing id and read less of its own cache.`,
	});
}

function releaseMainLane(conversation: string): void {
	const held = mainLaneOf.get(conversation);
	if (held === undefined) return;
	mainLaneOf.delete(conversation);
	if (held.shared) {
		releaseStoreLane(conversation);
		return;
	}
	const lanes = localLanesOf.get(held.key);
	lanes?.delete(held.lane);
	if (lanes?.size === 0) localLanesOf.delete(held.key);
}

function releaseStoreLane(conversation: string | undefined): void {
	try {
		laneStore?.release(conversation);
	} catch {
		// The store reaps the record when this process ends; a failed release only keeps the lane until then.
	}
}

registerSessionResourceCleanup((sessionId) => {
	if (sessionId !== undefined) {
		releaseMainLane(sessionId);
		fallbackNoticed.delete(sessionId);
		return;
	}
	const shared = [...mainLaneOf.values()].some((held) => held.shared);
	mainLaneOf.clear();
	localLanesOf.clear();
	fallbackNoticed.clear();
	if (shared) releaseStoreLane(undefined);
});

/**
 * The lane a live main conversation takes among the live conversations of one key, as workers take one on their
 * capacity lease (FL-17): kept across its turns and released when its session resources are (a /new, /resume, a
 * route change, a closed host session) or, through the store, when its process dies. Sessions one after another take
 * lane 0 and share the head's cache; concurrent ones (two herdr lanes or a TUI beside a GUI or ACP host on one
 * install, or several sessions in one host) stop sharing one id, under which live conversations lose their own
 * history more often. The store spans every process of this state dir; when it is absent or fails, the lanes are
 * this process's own. The store waits at most a second for its lock on this thread; a failed claim is journaled and
 * said once per conversation (`reportLaneFallback`), and a failed renewal keeps the lane the conversation has.
 */
function claimMainLane(key: string, conversation: string, model: Model<Api>, nowMs = Date.now()): number {
	const held = mainLaneOf.get(conversation);
	if (held?.key === key && !(held.shared && nowMs - held.claimedAt >= STORE_RENEW_MS)) return held.lane;
	if (held?.key === key) {
		try {
			const lane = laneStore?.claim(key, conversation);
			// A record the store had reaped comes back as a fresh claim, possibly on another lane.
			if (lane !== undefined) {
				held.lane = lane;
				held.claimedAt = nowMs;
				return lane;
			}
		} catch {
			// Keep the lane this conversation has; the next request tries the renewal again.
			return held.lane;
		}
	}
	releaseMainLane(conversation);
	if (mainLaneOf.size >= MAX_MAIN_CONVERSATIONS) {
		const oldest = mainLaneOf.keys().next().value;
		if (oldest !== undefined) {
			releaseMainLane(oldest);
			fallbackNoticed.delete(oldest);
		}
	}
	let failure: { error: unknown } | undefined;
	if (laneStore !== undefined) {
		try {
			const lane = laneStore.claim(key, conversation);
			mainLaneOf.set(conversation, { key, lane, shared: true, claimedAt: nowMs });
			return lane;
		} catch (error) {
			// An unreadable or locked store must not stop the turn: fall back to this process's own lanes.
			failure = { error };
		}
	}
	const lanes = localLanesOf.get(key) ?? new Set<number>();
	localLanesOf.set(key, lanes);
	let lane = 0;
	while (lanes.has(lane)) lane += 1;
	lanes.add(lane);
	mainLaneOf.set(conversation, { key, lane, shared: false, claimedAt: nowMs });
	if (failure !== undefined) reportLaneFallback(conversation, lane, failure.error, model);
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
	const lane = claimMainLane(JSON.stringify(["main", model.baseUrl, head]), conversation, model) % 1_000_000;
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
