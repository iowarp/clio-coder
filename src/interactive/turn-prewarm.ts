/**
 * Pre-warm ownership: when the prefix is sent, what stops it, and what it
 * records. The round itself lives in `prewarm.ts`.
 *
 * Three moments hand the backend a prefix the operator has not paid for yet:
 * the session prompt compiling at session start, a resume rebuilding the
 * message array, and a compaction settling. All three leave a known prefix and
 * an operator who is reading rather than waiting on a turn. Everything else is
 * a refusal: another tier, a turn in flight, a running dispatch, a surface with
 * nobody watching.
 */

import { BusChannels } from "../core/bus-events.js";
import type { ClioSettings } from "../core/config.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { ProvidersContract } from "../domains/providers/index.js";
import type { SessionContract } from "../domains/session/contract.js";
import type { Usage } from "../engine/types.js";
import { type PrewarmTrigger, prewarmPromptTokens, runPrewarmRound } from "./prewarm.js";
import type { TurnContext } from "./turn-context.js";
import type { AgentRuntime, ChatTurnState } from "./turn-state.js";

/** Why a pre-warm did not run. Returned for contracts; never shown to the operator. */
export type PrewarmSkipReason =
	| "disabled"
	| "surface"
	| "turn-active"
	| "dispatch-active"
	| "tier"
	| "unresolved"
	| "superseded";

export type PrewarmOutcome = { ran: true; trigger: PrewarmTrigger } | { ran: false; reason: PrewarmSkipReason };

export interface TurnPrewarmDeps {
	state: ChatTurnState;
	getSettings: () => Readonly<ClioSettings>;
	providers: ProvidersContract;
	session?: SessionContract | undefined;
	context: TurnContext;
	bus?: SafeEventBus | undefined;
	/**
	 * True on a surface where a person is about to type the next turn. False for
	 * headless `run`: the pre-warm buys latency an unattended run never spends.
	 * Workers never reach here at all; they do not build a chat loop.
	 */
	isLatencySurface: () => boolean;
	/** True while a submit owns, or is about to own, the turn state machine. */
	isTurnActive: () => boolean;
	/**
	 * True while an attached dispatch is running. Detached runs are counted from
	 * the bus instead, so a composition without this predicate still stands down
	 * for the worker traffic the bus reports.
	 */
	hasActiveDispatch: () => boolean;
	/** Resolve the runtime and credentials the next turn would use, or a refusal. */
	prepareRuntime: (
		signal: AbortSignal,
	) => Promise<{ ok: true; runtime: AgentRuntime; apiKey: string | undefined } | { ok: false; reason: string }>;
	/** Freeze the session tool surface onto the agent, exactly as a submit does. */
	applySessionTools: (runtime: AgentRuntime) => void;
	/** Report the round's provider usage under its own `/cost` label. */
	recordUsage: (runtime: AgentRuntime, usage: Usage | null) => void;
	/**
	 * Claim one in-flight request on the runtime's endpoint for the duration of
	 * the round, returning the release handle. This is the seam brief 06 (#250)
	 * fills: on a merged tree the chat loop passes
	 *
	 *   (runtime) => {
	 *     const key = canonicalEndpointKey(runtime.runtimeResolution.target);
	 *     return key === null ? null : registerForegroundStream(key);
	 *   }
	 *
	 * from `src/domains/providers/index.ts`, so endpoint capacity counts the
	 * pre-warm the same way it counts the orchestrator's streaming turn. Until
	 * then it is absent and `dispatchActive()` stands in with a blanket skip.
	 */
	registerEndpointSlot?: (runtime: AgentRuntime) => (() => void) | null;
	/** Test seam. Production uses the real provider round. */
	runPrewarm?: typeof runPrewarmRound;
	/**
	 * Whether a submit aborts the round's request. Defaults to the measured
	 * backend behavior; see {@link ABORT_ROUND_ON_SUBMIT}.
	 */
	abortRoundOnSubmit?: boolean;
}

export interface TurnPrewarm {
	/**
	 * Queue a pre-warm for the next tick. Repeated calls before it fires collapse
	 * onto one round: boot and a boot-time resume both land in the same tick, and
	 * warming the pre-resume history would be work thrown away.
	 */
	schedule(trigger: PrewarmTrigger): void;
	/** Stop an in-flight or queued pre-warm. The operator's turn owns the slot now. */
	cancel(): void;
	/** Resolves once nothing is queued or in flight. For contracts and shutdown. */
	settled(): Promise<PrewarmOutcome | null>;
	dispose(): void;
}

/**
 * Whether a submit aborts the in-flight pre-warm's HTTP request, or only stops
 * treating it as the current one.
 *
 * Measured against the operator's llama.cpp router, build `b226-2115b73d8`,
 * Qwen3.8-27B, `--parallel 1`: aborting the request 1.5 s into a 47,620-token
 * prefill did not cancel the server's work. The server finished prefilling, so
 * the prefix did survive the abort, and the very next request read 47,596 of
 * 47,620 tokens from cache and spent 927 ms in prompt. That request also waited
 * 89.5 s of wall clock for the abandoned one to finish, on a server that serves
 * one slot. Letting the pre-warm complete instead cost 89.3 s plus a 1.3 s turn:
 * the same wall clock, arrived at honestly.
 *
 * The abort therefore frees no slot and saves the operator no time on this
 * backend. All it does is discard the usage and timings of prefill the server
 * performed, which is spend the ledger should carry. So a submit detaches the
 * round: Clio stops calling it the current pre-warm and never waits on it, and
 * it still records what it cost. Set this true for a backend that honors
 * cancellation, where dropping the request genuinely releases the slot.
 */
const ABORT_ROUND_ON_SUBMIT = false;

export function createTurnPrewarm(deps: TurnPrewarmDeps): TurnPrewarm {
	const round = deps.runPrewarm ?? runPrewarmRound;
	const abortOnSubmit = deps.abortRoundOnSubmit ?? ABORT_ROUND_ON_SUBMIT;
	let pendingTrigger: PrewarmTrigger | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let active: AbortController | null = null;
	// Rounds a submit or a session switch let go of. Their result is still
	// recorded, but it no longer describes the prefix the next turn will send, so
	// it never reaches the `/context` line.
	const detached = new WeakSet<AbortController>();
	let inFlight: Promise<PrewarmOutcome | null> = Promise.resolve(null);
	// Dispatch traffic Clio can see without an endpoint registry: the run
	// lifecycle the bus already publishes. `hasActiveDispatch` covers the attached
	// calls the composition root holds; this covers detached ones. Both are the
	// stand-in for #250's per-endpoint slot accounting.
	let dispatchesInFlight = 0;
	const unsubscribeDispatch = [
		deps.bus?.on(BusChannels.DispatchStarted, () => {
			dispatchesInFlight += 1;
		}) ?? null,
		...[BusChannels.DispatchCompleted, BusChannels.DispatchFailed].map(
			(channel) =>
				deps.bus?.on(channel, () => {
					dispatchesInFlight = Math.max(0, dispatchesInFlight - 1);
				}) ?? null,
		),
	];
	const dispatchActive = (): boolean => dispatchesInFlight > 0 || deps.hasActiveDispatch();

	const admissionRefusal = (): PrewarmSkipReason | null => {
		if (deps.getSettings().prewarm?.enabled === false) return "disabled";
		if (!deps.isLatencySurface()) return "surface";
		if (deps.state.streaming || deps.isTurnActive()) return "turn-active";
		// Fleet interaction. Without per-endpoint slot accounting a pre-warm cannot
		// know whether a worker is already occupying the server it would warm, so
		// it stands down whenever any dispatch is outstanding. `registerEndpointSlot`
		// is the other half: the round claims a slot on its endpoint while its
		// request is out, so capacity sees it. Once that registry answers here too,
		// this blanket skip narrows to "the endpoint is at its bound".
		if (dispatchActive()) return "dispatch-active";
		// The tier is settled from configuration before anything is resolved. The
		// resolved runtime is checked again below, but asking here means a target
		// that was never eligible costs no capability probe, no agent, and no
		// notice from either.
		const targetId = deps.getSettings().orchestrator?.target?.trim();
		const runtimeId = targetId ? deps.providers.getTarget(targetId)?.runtime : undefined;
		if (runtimeId === undefined || deps.providers.getRuntime(runtimeId)?.tier !== "local-native") return "tier";
		return null;
	};

	const runOnce = async (trigger: PrewarmTrigger, controller: AbortController): Promise<PrewarmOutcome> => {
		const refusal = admissionRefusal();
		if (refusal) return { ran: false, reason: refusal };

		const prepared = await deps.prepareRuntime(controller.signal);
		if (!prepared.ok) return { ran: false, reason: "unresolved" };
		const runtime = prepared.runtime;
		if (deps.providers.getRuntime(runtime.runtimeId)?.tier !== "local-native") {
			// Off on every other tier regardless of the setting. A cloud provider
			// caches by exact prefix on its own schedule and bills the request; a
			// pre-warm there is spend without a latency win.
			return { ran: false, reason: "tier" };
		}

		deps.applySessionTools(runtime);
		await deps.context.ensureSessionPrompt(runtime);

		// Re-check after the awaits: a submit or a dispatch may have started while
		// the prompt compiled, and the pre-warm must never be the request the
		// operator's turn queues behind.
		const lateRefusal = admissionRefusal();
		if (lateRefusal) return { ran: false, reason: lateRefusal };
		if (detached.has(controller) || controller.signal.aborted) return { ran: false, reason: "superseded" };

		// The claim is taken before the request goes out and released in the
		// finally, including on the detach path, because the request the server is
		// still finishing is the one occupying the slot.
		const releaseEndpointSlot = deps.registerEndpointSlot?.(runtime) ?? null;
		let result: Awaited<ReturnType<typeof round>>;
		try {
			result = await round({
				model: runtime.agent.state.model,
				state: {
					systemPrompt: runtime.agent.state.systemPrompt,
					messages: runtime.agent.state.messages,
					tools: runtime.agent.state.tools,
					thinkingLevel: runtime.agent.state.thinkingLevel ?? "off",
				},
				...(prepared.apiKey !== undefined ? { apiKey: prepared.apiKey } : {}),
				signal: controller.signal,
			});
		} finally {
			releaseEndpointSlot?.();
		}

		// The prefill the server did is spend whatever the operator did next, so a
		// let-go round is recorded exactly like a completed one. Only the
		// `/context` line is withheld: it answers "is the prefix the next turn
		// wants already resident", and a detached round is no longer about that
		// prefix.
		const wasDetached = detached.has(controller) || controller.signal.aborted;
		const promptTokens = prewarmPromptTokens(result);
		if (!wasDetached) {
			deps.context.notePrewarm({
				tokens: promptTokens,
				ms: result.timing.apiMs,
				aborted: result.aborted,
			});
		}
		deps.recordUsage(runtime, result.usage);

		try {
			deps.session?.appendEntry({
				kind: "custom",
				customType: "prewarm",
				// Never a model message and never a rendered transcript block: a
				// pre-warm is a fact about the backend, not something the session said.
				display: false,
				parentTurnId: deps.state.lastTurnId,
				data: {
					trigger,
					target: runtime.targetId,
					model: runtime.wireModelId,
					promptTokens,
					aborted: result.aborted,
					detached: wasDetached,
					timing: result.timing,
					promptCache: {
						input: result.usage?.input ?? 0,
						cacheRead: result.usage?.cacheRead ?? 0,
						cacheWrite: result.usage?.cacheWrite ?? 0,
						...(result.backend ? { backend: { ...result.backend } } : {}),
					},
					...(result.errorMessage ? { error: result.errorMessage } : {}),
				},
			});
		} catch {
			// The ledger entry is diagnostics. A session that refuses it must not
			// turn an optimization into a failure.
		}
		return { ran: true, trigger };
	};

	/**
	 * Let go of the round in flight. On a backend that honors cancellation this
	 * also aborts the request; see {@link ABORT_ROUND_ON_SUBMIT} for why the
	 * measured one does not.
	 */
	const releaseActiveRound = (): void => {
		const controller = active;
		if (controller === null) return;
		detached.add(controller);
		if (abortOnSubmit) controller.abort();
		active = null;
	};

	const fire = (): void => {
		timer = null;
		const trigger = pendingTrigger;
		pendingTrigger = null;
		if (trigger === null) return;
		const controller = new AbortController();
		active = controller;
		const previous = inFlight;
		inFlight = previous
			.catch(() => null)
			.then(() => runOnce(trigger, controller))
			.catch(() => null)
			.finally(() => {
				if (active === controller) active = null;
			});
	};

	return {
		schedule(trigger: PrewarmTrigger): void {
			// A newer trigger describes a newer prefix; the older round is no longer
			// warming history this session has.
			releaseActiveRound();
			pendingTrigger = trigger;
			if (timer !== null) return;
			// Ref'd on purpose, same reasoning as `settled()` below: the timer is due
			// in 0 ms, so it holds the event loop for one tick at most, and a Node 22
			// loop that drains past a due unref'd timer would otherwise never start
			// the round a test or caller is already awaiting.
			timer = setTimeout(fire, 0);
		},

		cancel(): void {
			pendingTrigger = null;
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
			releaseActiveRound();
		},

		settled(): Promise<PrewarmOutcome | null> {
			// One hop past the scheduling tick so a caller that just scheduled a
			// round waits for that round rather than for the previous one. The timer
			// is deliberately ref'd, unlike the scheduling timer above: the caller is
			// awaiting this promise, so the event loop must stay alive for the one
			// tick that lets the scheduled round start. Node 22 drains the loop past
			// a due unref'd timer when nothing else holds it, which left this promise
			// pending forever and cancelled every later test in the lane; Node 24
			// happens to fire the due timer first, which is why the hang never
			// reproduced on a 24.x development machine.
			return new Promise((resolve) => {
				setTimeout(() => {
					resolve(inFlight.catch(() => null));
				}, 0);
			});
		},

		dispose(): void {
			for (const unsubscribe of unsubscribeDispatch) unsubscribe?.();
			pendingTrigger = null;
			if (timer !== null) {
				clearTimeout(timer);
				timer = null;
			}
			// Shutdown always aborts: the process is going away, and a socket held
			// open for a round nobody will read is not a latency question.
			active?.abort();
			active = null;
		},
	};
}

/**
 * Subscribe the pre-warm to compaction settling. A summary or an eviction moves
 * the byte prefix, so the next turn is known to be cold, and the operator is
 * usually reading the summary rather than typing. The idle guard inside
 * `schedule` is what keeps this from firing for the auto-compaction a submit
 * runs on its way to the provider.
 */
export function subscribePrewarmToCompaction(bus: SafeEventBus | undefined, prewarm: TurnPrewarm): () => void {
	const unsubscribe = bus?.on(BusChannels.CompactionEnd, () => {
		prewarm.schedule("compaction");
	});
	return () => unsubscribe?.();
}
