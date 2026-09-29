/**
 * What followed a decision, observed where the harness can see it.
 *
 * A decision row alone cannot say whether it was right. These observers write
 * the outcome rows a dataset joins back to it by `ref`: how an approval card was
 * answered, and whether a ranked entry was later used. Each takes the sink as a
 * function so a session with no recorder observes nothing, and each is safe to
 * call from a hot path: recording never throws.
 */

import { BusChannels, type PermissionResolvedPayload } from "../../core/bus-events.js";
import type { SafeEventBus } from "../../core/event-bus.js";
import type { ClassifierCall } from "../safety/action-classifier.js";
import type { DraftLabel } from "./sites/drafts.js";
import type { OutcomeRecord } from "./types.js";

/** The ranking calls a follow-up can still be joined to. */
export type RankedKind = "skills" | "capabilities" | "memory";

export type OutcomeSink = (outcome: OutcomeRecord) => void;

function emit(sink: OutcomeSink, outcome: OutcomeRecord): void {
	try {
		sink(outcome);
	} catch {
		// Recording never costs the action it describes.
	}
}

/** The registry surface the permission observer needs; the full registry satisfies it. */
export interface PermissionParkSource {
	onPermissionRequired(
		listener: (call: ClassifierCall, decision: unknown, meta: { requestId: string }) => void,
	): () => void;
}

/** A request that never resolves must not pin memory for the life of the session. */
const MAX_OPEN_REQUESTS = 512;

/**
 * Record how each approval the main agent parked was answered.
 *
 * The start of the park is taken from the registry's own listener, because the
 * resolved event carries no start time, and only requests seen parking here are
 * recorded: a worker's escalation resolves on the same channel and belongs to no
 * decision this session made. `latencyMs` is how long the operator (or the
 * policy that answered for them) took.
 */
export function observePermissionOutcomes(input: {
	bus: Pick<SafeEventBus, "on">;
	registry: PermissionParkSource;
	record: OutcomeSink;
	/** Monotonic milliseconds; injected for the clock, not for tests. */
	now?: () => number;
}): () => void {
	const now = input.now ?? (() => performance.now());
	const parkedAt = new Map<string, number>();
	const unsubscribePark = input.registry.onPermissionRequired((_call, _decision, meta) => {
		// A re-notified head fires the listener again; the park began the first time.
		if (parkedAt.has(meta.requestId)) return;
		parkedAt.set(meta.requestId, now());
		if (parkedAt.size > MAX_OPEN_REQUESTS) {
			const oldest = parkedAt.keys().next().value;
			if (oldest !== undefined) parkedAt.delete(oldest);
		}
	});
	const unsubscribeResolved = input.bus.on(BusChannels.PermissionResolved, (payload: PermissionResolvedPayload) => {
		const requestId = payload.requestId;
		if (typeof requestId !== "string") return;
		const started = parkedAt.get(requestId);
		if (started === undefined) return;
		parkedAt.delete(requestId);
		emit(input.record, {
			ref: requestId,
			source: "permission",
			at: new Date().toISOString(),
			facts: {
				status: payload.status,
				decidedBy: payload.decidedBy ?? null,
				latencyMs: Math.max(0, Math.round(now() - started)),
			},
		});
	});
	return () => {
		unsubscribePark();
		unsubscribeResolved();
	};
}

/**
 * Remembers what the latest ranking of each kind listed, so a later use of an
 * entry it ranked can be recorded against that ranking's call.
 */
export interface FollowUpTracker {
	/** A ranking call finished. `scores` are the noul masses it produced, by candidate id. */
	ranked(kind: RankedKind, ref: string, scores: Readonly<Record<string, number>>): void;
	/**
	 * A listing of this kind went out in its own order because the ranking had no
	 * opinion. A later use followed that listing, not the ranking before it.
	 */
	unranked(kind: RankedKind): void;
	/** An entry was used: a skill loaded, a gateway capability called, a memory record selected. */
	used(kind: RankedKind, id: string): void;
}

export function createFollowUpTracker(record: OutcomeSink): FollowUpTracker {
	const latest = new Map<RankedKind, { ref: string; order: string[]; scores: Readonly<Record<string, number>> }>();
	const joined = new Set<string>();
	return {
		ranked(kind, ref, scores) {
			const order = Object.keys(scores).sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0));
			latest.set(kind, { ref, order, scores });
		},
		unranked(kind) {
			latest.delete(kind);
		},
		used(kind, id) {
			const ranking = latest.get(kind);
			if (ranking === undefined) return;
			const position = ranking.order.indexOf(id);
			const key = `${ranking.ref}|${id}`;
			// One use per ranked entry: a skill read twice is one follow-up, not two.
			if (joined.has(key)) return;
			joined.add(key);
			if (joined.size > 1024) {
				const oldest = joined.values().next().value;
				if (oldest !== undefined) joined.delete(oldest);
			}
			emit(record, {
				ref: ranking.ref,
				source: "follow-up",
				at: new Date().toISOString(),
				facts: {
					kind,
					id,
					// 1-based among the scored entries; null for one the ranking had no opinion on.
					rank: position === -1 ? null : position + 1,
					score: position === -1 ? null : (ranking.scores[id] ?? null),
					ranked: ranking.order.length,
				},
			});
		},
	};
}

/**
 * The outcome row for a draft the operator took into the composer, joined to the
 * decision that judged the candidates. `agreed` is the label the dataset learns
 * from: whether the judge's top pick was the draft the operator wanted. A judge
 * with no pick cannot have agreed.
 */
export function draftTakenOutcome(input: {
	ref: string;
	taken: DraftLabel;
	judgedPick: DraftLabel | null;
}): Pick<OutcomeRecord, "ref" | "source" | "facts"> {
	return {
		ref: input.ref,
		source: "draft",
		facts: {
			taken: input.taken,
			judgedPick: input.judgedPick,
			agreed: input.judgedPick !== null && input.judgedPick === input.taken,
		},
	};
}
