/**
 * Hosted prompt-cache keepalive for the orchestrator's own turn (#423).
 *
 * A hosted provider drops a cached prefix after a few idle minutes (Anthropic declares 5, OpenAI documents 5 to
 * 10). The orchestrator falls silent on the provider exactly while its turn waits on its own tools, above all an
 * attached dispatch whose workers routinely outlast that lifetime, and the request that follows then re-prefills
 * the whole conversation at the uncached price. While a turn waits on tools, Clio knows that request will come, so
 * it replays the turn's last request with a minimal output cap shortly before the entry expires, whenever the
 * refresh is expected to save more than it costs.
 *
 * The keepalive is bound to one turn. It runs only while the turn waits on tools: for as long as an attached
 * dispatch awaits its runs (two hours at most), and for an hour on any other tool. It stands down while a person
 * owns the wait (a parked permission ask or an `ask_user` interview) and between turns, where the next request is
 * the operator's to send. Each refresh is admitted against the session cost ceiling, journaled as a `prewarm`
 * call, and recorded on the session ledger with its economics.
 */

import type { CallJournalOptions } from "../domains/telemetry/call-scope.js";
import { openCallScope } from "../domains/telemetry/call-scope.js";
import {
	CACHE_KEEPALIVE_MIN_SAVINGS_USD,
	type CacheKeepaliveEconomics,
	type CacheKeepaliveRefusal,
	type CacheKeepaliveReply,
	type CacheKeepaliveRequest,
	cacheKeepaliveEconomics,
	cacheKeepalivePromptTokens,
	cacheKeepaliveRoute,
	replayCacheKeepalive,
} from "../engine/cache-keepalive.js";
import type { AgentRuntime } from "./turn-state.js";

/** Longest a keepalive follows one request while the turn awaits an attached dispatch. */
export const KEEPALIVE_FLEET_HORIZON_MS = 2 * 60 * 60_000;
/** Longest a keepalive follows one request while the turn awaits any other tool. */
export const KEEPALIVE_TOOL_HORIZON_MS = 60 * 60_000;

export type KeepalivePhase = "fleet" | "tools";

export type KeepaliveStopReason =
	| "disabled"
	| "turn-settled"
	| "runtime-changed"
	| "operator-wait"
	| "horizon"
	| "deadline-missed"
	| "request-failed"
	| "economics-unavailable"
	| "below-threshold"
	| "budget"
	| "refresh-failed"
	| CacheKeepaliveRefusal;

export interface KeepaliveRefresh {
	phase: KeepalivePhase;
	economics: CacheKeepaliveEconomics;
	promptTokens: number;
	message: CacheKeepaliveReply | null;
	error: string | null;
	/** The journaled call identity; present when the call journal owns this refresh's accounting (#434). */
	call?: { callId: string; attemptId: string };
}

export interface TurnKeepaliveDeps {
	enabled: () => boolean;
	isTurnActive: () => boolean;
	/** A permission ask is parked or an interview is open: the next request waits on a person. */
	waitsOnOperator: () => boolean;
	hasAttachedDispatch: () => boolean;
	isCurrentRuntime: (runtime: AgentRuntime) => boolean;
	/** False when spending `usd` more would reach the session cost ceiling. */
	canSpend: (usd: number) => boolean;
	/** Book one sent refresh in the session ledger; its call is journaled by its own scope (#434). */
	record: (runtime: AgentRuntime, refresh: KeepaliveRefresh) => void;
	/** The session journal that owns a refresh's call facts, as prewarm's does (#434). */
	callJournal?: (runtime: AgentRuntime) => CallJournalOptions | undefined;
	/** Holds the runtime's endpoint slot for the refresh, as every out-of-turn round does. */
	withEndpointSlot?: <T>(runtime: AgentRuntime, round: () => Promise<T>) => Promise<T>;
	replay?: typeof replayCacheKeepalive;
	now?: () => number;
	timers?: {
		set: (fire: () => void, ms: number) => unknown;
		clear: (handle: unknown) => void;
	};
}

export interface TurnKeepalive {
	/** Follow the turn's newest request; any earlier one is no longer the prefix the turn extends. */
	noteRequest(
		runtime: AgentRuntime,
		request: CacheKeepaliveRequest,
		stream: { result(): Promise<CacheKeepaliveReply> },
	): void;
	/** Stop following the current request. A refresh already sent still books its spend. */
	cancel(): void;
	/** Why nothing is being kept warm, or null while a refresh is scheduled or in flight. */
	stopReason(): KeepaliveStopReason | null;
	dispose(): void;
}

interface Run {
	runtime: AgentRuntime;
	request: CacheKeepaliveRequest;
	ttlMs: number;
	delayMs: number;
	outputTokens: number;
	/** When the followed request was sent; the horizon counts from here. */
	startedAt: number;
	/** When the cache entry was last read, by the request or a refresh. */
	touchedAt: number;
	promptTokens: number;
	timer: unknown;
	controller: AbortController;
}

export function createTurnKeepalive(deps: TurnKeepaliveDeps): TurnKeepalive {
	const now = deps.now ?? Date.now;
	const timers = deps.timers ?? {
		set: (fire: () => void, ms: number) => {
			const handle = setTimeout(fire, ms);
			// A pending refresh never keeps the process alive.
			handle.unref?.();
			return handle;
		},
		clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
	};
	const replay = deps.replay ?? replayCacheKeepalive;
	let run: Run | null = null;
	let stopped: KeepaliveStopReason | null = "turn-settled";

	const stop = (reason: KeepaliveStopReason): void => {
		const current = run;
		run = null;
		stopped = reason;
		if (current === null) return;
		if (current.timer !== undefined) timers.clear(current.timer);
		current.controller.abort();
	};

	const arm = (current: Run): void => {
		current.timer = timers.set(() => void fire(current), Math.max(0, current.touchedAt + current.delayMs - now()));
	};

	const fire = async (current: Run): Promise<void> => {
		if (run !== current) return;
		current.timer = undefined;
		// A timer that ran late after sleep or a blocked loop would refresh an entry that may already be gone, which
		// is a full-price write rather than a read; keep half the planned margin for that delay.
		if (now() > current.touchedAt + current.delayMs + (current.ttlMs - current.delayMs) / 2)
			return stop("deadline-missed");
		if (!deps.enabled()) return stop("disabled");
		if (!deps.isTurnActive()) return stop("turn-settled");
		if (!deps.isCurrentRuntime(current.runtime)) return stop("runtime-changed");
		if (deps.waitsOnOperator()) return stop("operator-wait");
		const phase: KeepalivePhase = deps.hasAttachedDispatch() ? "fleet" : "tools";
		const horizon = phase === "fleet" ? KEEPALIVE_FLEET_HORIZON_MS : KEEPALIVE_TOOL_HORIZON_MS;
		if (now() - current.startedAt > horizon) return stop("horizon");
		const provenance = current.runtime.runtimeResolution.costProvenance;
		if (provenance !== "known" && provenance !== "estimated") return stop("economics-unavailable");
		// The turn is waiting on its own tools, so its next request is certain; only its timing is not.
		const economics = cacheKeepaliveEconomics(current.request.model, current.promptTokens, current.outputTokens, 1);
		if (!economics.available) return stop("economics-unavailable");
		if (economics.expectedSavingsUsd < CACHE_KEEPALIVE_MIN_SAVINGS_USD) return stop("below-threshold");
		if (!deps.canSpend(economics.warmUsd)) return stop("budget");
		const sentAt = now();
		let message: CacheKeepaliveReply | null = null;
		let error: string | null = null;
		let call: KeepaliveRefresh["call"];
		// A refresh is a prewarm call: the journal owns its facts, so readers never miss keepalive spend (#434).
		const scope = await openCallScope(deps.callJournal?.(current.runtime), current.request.model);
		try {
			scope.startAttempt({ roundKind: "normal", toolChoice: "unknown" });
			const send = () => scope.withContext(() => replay(current.request, current.outputTokens, current.controller.signal));
			message = await (deps.withEndpointSlot ? deps.withEndpointSlot(current.runtime, send) : send());
			if (message.stopReason === "error" || message.stopReason === "aborted")
				error = message.errorMessage ?? message.stopReason;
			scope.settle(message);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
			scope.settle({ stopReason: "error", errorMessage: error });
		} finally {
			call = scope.identity();
			await scope.close();
		}
		try {
			// The provider was asked either way, so even a refresh the turn has moved past is booked.
			deps.record(current.runtime, {
				phase,
				economics,
				promptTokens: current.promptTokens,
				message,
				error,
				...(call ? { call } : {}),
			});
		} catch {
			// Booking is bookkeeping; it must not turn a refresh into a turn failure.
		}
		if (run !== current) return;
		if (error !== null) return stop("refresh-failed");
		current.touchedAt = sentAt;
		arm(current);
	};

	return {
		noteRequest(runtime, request, stream) {
			stop("turn-settled");
			const route = cacheKeepaliveRoute(request);
			if (!route.ok) {
				stopped = route.reason;
				return;
			}
			const startedAt = now();
			const current: Run = {
				runtime,
				request,
				ttlMs: route.ttlMs,
				delayMs: route.delayMs,
				outputTokens: route.outputTokens,
				startedAt,
				touchedAt: startedAt,
				promptTokens: 0,
				timer: undefined,
				controller: new AbortController(),
			};
			run = current;
			stopped = null;
			// Nothing is refreshed while the request itself is out; its prompt size is known once it finishes.
			stream.result().then(
				(message) => {
					if (run !== current) return;
					if (message.stopReason === "error" || message.stopReason === "aborted") return stop("request-failed");
					current.promptTokens = cacheKeepalivePromptTokens(message);
					arm(current);
				},
				() => {
					if (run === current) stop("request-failed");
				},
			);
		},
		cancel() {
			stop("turn-settled");
		},
		stopReason: () => stopped,
		dispose() {
			stop("turn-settled");
		},
	};
}
