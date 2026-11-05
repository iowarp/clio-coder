/**
 * Side-agent model calls in flight, from their journaled start to their settle.
 *
 * Memory review ran for seconds after a turn ended with nothing but a footer tag
 * that arrived late or never, and a judge's review of a call looked like the call
 * itself running (F23). The start and settle events are the evidence, so this
 * never claims work the journal did not record.
 */

import type { TelemetryHub } from "../core/telemetry/hub.js";

export interface BackgroundCall {
	callId: string;
	/** What the call is for, in the operator's words. */
	purpose: string;
	/** The model it runs on. */
	model: string;
	startedAt: number;
	/** The turn cannot continue until this settles; otherwise the session stays free. */
	blocksTurn: boolean;
}

/**
 * The side agents with no surface of their own. Compaction, side questions,
 * handoff and helpers each draw their own card or overlay, so they stay out.
 */
const PURPOSES: Readonly<Record<string, { purpose: string; blocksTurn: boolean }>> = {
	memory: { purpose: "memory review", blocksTurn: false },
	"safety-judge": { purpose: "safety judge", blocksTurn: true },
	prewarm: { purpose: "prewarm", blocksTurn: false },
	"system-one": { purpose: "steering triage", blocksTurn: true },
};

export interface BackgroundCallTracker {
	/** Oldest first; a blocking call leads because the turn is waiting on it. */
	active(): ReadonlyArray<BackgroundCall>;
	dispose(): void;
}

export function createBackgroundCallTracker(
	bus: Pick<TelemetryHub, "subscribe">,
	onChange: () => void,
	now: () => number = Date.now,
): BackgroundCallTracker {
	const calls = new Map<string, BackgroundCall>();
	const unsubscribe = [
		bus.subscribe("call.started", (payload, context) => {
			const known = context ? PURPOSES[context.agent.role] : undefined;
			if (!known || calls.has(payload.callId)) return;
			calls.set(payload.callId, {
				callId: payload.callId,
				model: payload.target.requestedModel,
				startedAt: now(),
				...known,
			});
			onChange();
		}),
		bus.subscribe("call.settled", (payload) => {
			if (calls.delete(payload.callId)) onChange();
		}),
	];
	return {
		active: () => [...calls.values()].sort((left, right) => Number(right.blocksTurn) - Number(left.blocksTurn)),
		dispose: () => {
			for (const off of unsubscribe) off();
			calls.clear();
		},
	};
}
