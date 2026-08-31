/**
 * The dispatch-to-pane-host bridge.
 *
 * Two responsibilities, both projections of state the session already owns:
 *
 * - **Terminal-run notifications.** A finished dispatch raises a pane-host
 *   toast per the `panes.notifications` policy, and a failure additionally
 *   leaves a persistent transcript notice, which unlike a toast remains
 *   auditable in the TUI and does not depend on the pane host being alive.
 *
 * - **Self-report (SA-3).** Clio's own hosting pane, in guest mode, carries
 *   the interactive status machine's phase as a semantic agent state, on a
 *   trailing-edge throttle: herdr answers one request per connection, and an
 *   operator turn passes through several phases inside one window, of which
 *   only the last is worth a wire call.
 *
 * What this bridge deliberately no longer does is open panes. The phase 3/4
 * integration projected every dispatch onto a viewer pane in a hidden Fleet
 * tab (an `agents` policy knob, a keep-failed close policy, resume adoption,
 * role-vocabulary sidebar labels). All of it duplicated the native fleet
 * surfaces into panes the operator had not asked for; the one pane that
 * renders runs is now the operator-pulled watch pane (`watch-pane.ts`), and
 * the policy line lives in `pane-policy.ts`.
 */

import { type AgentStatusChangedPayload, BusChannels, type DispatchRunIdentity } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { MuxContract, MuxLog } from "../domains/mux/index.js";
import { sanitizeCallTargetText } from "../domains/safety/call-target.js";

/** Trailing-edge window for the self-report; matches `WAIT_POLL_MS`. */
export const MUX_BRIDGE_THROTTLE_MS = 250;

/**
 * A success worth a sound. Below it a finished run is one of many and a chime
 * per run is noise; above it the operator has moved on and wants telling.
 */
const LONG_RUN_MS = 60_000;

/** How much terminal detail may reach a toast body or a notice line. */
const DETAIL_MAX_CHARS = 96;

export type PanesNotificationsPolicy = "failures" | "all" | "off";

/** Terminal outcomes that read as failure for the notification policy. */
type BridgeRunOutcome = "succeeded" | "failed" | "canceled" | "timed_out";

export interface MuxBridgeDeps {
	bus: SafeEventBus;
	mux: MuxContract;
	/** Read live so a `/settings` change takes effect on the next terminal run. */
	notificationsPolicy: () => PanesNotificationsPolicy;
	/** Persistent transcript notice; unlike a herdr toast, this remains auditable in the TUI. */
	notice?: (level: "error", text: string) => void;
	log?: MuxLog;
	now?: () => number;
	throttleMs?: number;
	setTimeoutFn?: typeof setTimeout;
	clearTimeoutFn?: typeof clearTimeout;
}

export interface MuxBridge {
	/** Settle every in-flight notification and self-report. Tests await it. */
	flush(): Promise<void>;
	dispose(): void;
}

function isFailure(outcome: BridgeRunOutcome): boolean {
	return outcome === "failed" || outcome === "timed_out";
}

/** Clio's own pane state (SA-3), mapped from the interactive status machine. */
function selfStateFor(phase: AgentStatusChangedPayload["phase"]): "working" | "blocked" | "idle" {
	if (phase === "tool_blocked") return "blocked";
	// `ended` is the settle step on the way back to idle, so both read idle.
	return phase === "idle" || phase === "ended" ? "idle" : "working";
}

/**
 * Clio's seven-member run outcome taxonomy narrowed to the four states the
 * notification policy distinguishes. `stalled`, `denied_by_policy`,
 * `spawn_failed`, and the synthetic `retry_denied` all read as failure, which
 * is the safe direction: an unrecognized terminal state must not silently
 * skip the failure notice.
 */
function terminalOutcome(outcome: string): BridgeRunOutcome {
	if (outcome === "succeeded") return "succeeded";
	if (outcome === "canceled") return "canceled";
	if (outcome === "timed_out") return "timed_out";
	return "failed";
}

export function createMuxBridge(deps: MuxBridgeDeps): MuxBridge {
	const log = deps.log ?? ((): void => undefined);
	const now = deps.now ?? Date.now;
	const throttleMs = deps.throttleMs ?? MUX_BRIDGE_THROTTLE_MS;
	const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
	const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;

	/** Start stamps, so a terminal event without a duration still gets one. */
	const startedAt = new Map<string, number>();
	let disposed = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	/** Serializes wire work: notifies and self-reports must not interleave. */
	let draining: Promise<void> = Promise.resolve();
	/** Pending self-report state, or null when nothing changed since the last flush. */
	let pendingSelf: "working" | "blocked" | "idle" | null = null;
	/** The last state actually reported, so a repeated phase costs no wire call. */
	let reportedSelf: "working" | "blocked" | "idle" | null = null;

	const schedule = (): void => {
		if (disposed || timer !== null) return;
		timer = setTimeoutFn(() => {
			timer = null;
			void drainSelf();
		}, throttleMs);
		timer.unref?.();
	};

	const drainSelf = (): Promise<void> => {
		draining = draining.then(async () => {
			if (disposed) return;
			const self = pendingSelf;
			pendingSelf = null;
			if (self !== null && self !== reportedSelf) {
				reportedSelf = self;
				await deps.mux.reportSelf({ state: self }).catch(() => false);
			}
		});
		return draining;
	};

	const boundedDetail = (value: string | null | undefined): string | null => {
		if (typeof value !== "string" || value.length === 0) return null;
		return sanitizeCallTargetText(value).slice(0, DETAIL_MAX_CHARS);
	};

	const onTerminal = (
		identity: DispatchRunIdentity,
		rawOutcome: string,
		fields: { durationMs?: number | undefined; detail?: string | null | undefined },
	): void => {
		const outcome = terminalOutcome(rawOutcome);
		const begun = startedAt.get(identity.runId);
		startedAt.delete(identity.runId);
		const policy = deps.notificationsPolicy();
		const failed = isFailure(outcome);
		const qualifies = policy === "all" || (policy === "failures" && failed);
		if (!qualifies) return;
		const detail = boundedDetail(fields.detail);
		const durationMs =
			typeof fields.durationMs === "number" ? fields.durationMs : begun === undefined ? null : now() - begun;
		if (failed) {
			deps.notice?.("error", `${identity.agentId} ${outcome} (${identity.runId})${detail ? `: ${detail}` : ""}`);
		}
		if (!deps.mux.available()) return;
		draining = draining.then(async () => {
			if (disposed) return;
			try {
				await deps.mux.notify({
					title: `${identity.agentId} ${outcome}`,
					...(detail ? { body: detail } : {}),
					// A failure interrupts; a long success announces. A short success
					// in `all` mode gets the toast without the chime.
					sound: failed ? "request" : durationMs !== null && durationMs >= LONG_RUN_MS ? "done" : "none",
				});
			} catch (error) {
				// The contract swallows its own failures; anything arriving here is a
				// bug rather than a dead socket, and must still not kill the chain.
				log("debug", `mux bridge notify failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		});
	};

	const unsubscribers = [
		deps.bus.on(BusChannels.DispatchStarted, (payload) => {
			startedAt.set(payload.runId, now());
		}),
		deps.bus.on(BusChannels.DispatchCompleted, (payload) => {
			onTerminal(payload, payload.outcome, { durationMs: payload.durationMs, detail: payload.outcomeDetail });
		}),
		deps.bus.on(BusChannels.DispatchFailed, (payload) => {
			onTerminal(payload, payload.reason, { durationMs: payload.durationMs, detail: payload.outcomeDetail });
		}),
		// SA-3. The interactive status machine is the one surface that already
		// knows when a turn starts, when it ends, and when a tool call is parked
		// on an approval, so the self-report rides its transitions rather than
		// growing a second turn-lifecycle listener.
		deps.bus.on(BusChannels.AgentStatusChanged, (payload) => {
			const state = selfStateFor(payload.phase);
			if (state === reportedSelf && pendingSelf === null) return;
			pendingSelf = state;
			schedule();
		}),
	];

	return {
		flush(): Promise<void> {
			if (timer !== null) {
				clearTimeoutFn(timer);
				timer = null;
			}
			return drainSelf();
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			if (timer !== null) clearTimeoutFn(timer);
			timer = null;
			for (const unsubscribe of unsubscribers) unsubscribe();
			startedAt.clear();
		},
	};
}
