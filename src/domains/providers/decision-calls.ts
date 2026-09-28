/**
 * What every System One call asked, what came back, and why it did or did not
 * answer.
 *
 * Sites read their answers and keep only what they act on: a rounded summary
 * for the pre-turn sites, nothing at all for memory, skills, tool risk and
 * drafts. A threshold cannot be re-fitted, and a model build cannot be told
 * apart from the one before it, from what the sites keep. So the decider
 * reports every call here, answered or not, and the host decides where the
 * record goes. With no sink installed a call costs nothing extra.
 */

import { createHash } from "node:crypto";
import type { DecisionSite } from "../../core/defaults.js";
import type { DecisionAnswer } from "./types/inference.js";

export type DecisionCallOutcome = "answered" | "failed" | "timeout" | "canceled" | "overflow" | "breaker-open";

/** An answer as recorded: the distribution without the echoed criteria legend. */
export type RecordedDecisionAnswer = Omit<DecisionAnswer, "legend">;

export interface DecisionCallRecord {
	readonly version: 1;
	/** ISO time the call started. */
	readonly at: string;
	/** Sites whose questions the call carried; a pre-turn batch carries several. */
	readonly sites: ReadonlyArray<DecisionSite>;
	/** The caller's handle on what was being decided, e.g. a permission request id. */
	readonly ref?: string;
	readonly target: string;
	/** The model the binding asked for, or null for the target's default. */
	readonly model: string | null;
	/** The build that answered, e.g. `jev-1.13.0`, or null when nothing answered. */
	readonly build: string | null;
	readonly outcome: DecisionCallOutcome;
	readonly error?: string;
	readonly latencyMs: number;
	readonly questions: number;
	readonly stateChars: number;
	/** The same chars/4 estimate the budget check uses. */
	readonly stateTokens: number;
	/** The target's decision window, or null when it declares none. */
	readonly budgetTokens: number | null;
	/** sha256 of the serialized state, so identical evidence can be grouped without storing it. */
	readonly stateDigest: string;
	readonly answers?: Readonly<Record<string, RecordedDecisionAnswer>>;
	readonly usage?: { readonly input: number; readonly output: number };
}

export type DecisionCallSink = (record: DecisionCallRecord) => void;

let sink: DecisionCallSink | null = null;

/**
 * Install the process-wide sink, or remove it with null. One composition root
 * owns a process, so there is one sink; a worker installs none and records
 * nothing.
 */
export function setDecisionCallSink(next: DecisionCallSink | null): void {
	sink = next;
}

export function decisionCallsRecorded(): boolean {
	return sink !== null;
}

export function recordDecisionCall(record: DecisionCallRecord): void {
	if (sink === null) return;
	try {
		sink(record);
	} catch {
		// Recording never costs the decision it describes.
	}
}

export function stateDigest(serialized: string): string {
	return createHash("sha256").update(serialized).digest("hex");
}

export function recordedAnswers(
	answers: Readonly<Record<string, DecisionAnswer>>,
): Record<string, RecordedDecisionAnswer> {
	const out: Record<string, RecordedDecisionAnswer> = {};
	for (const [id, answer] of Object.entries(answers)) {
		const { legend: _legend, ...kept } = answer;
		out[id] = kept;
	}
	return out;
}

/**
 * A bounded buffer the host drains into its ledger at turn boundaries. Calls
 * made between turns (an approval card, a `/draft` judgment) wait for the next
 * drain rather than writing into a turn that is not running. Each call is
 * tagged with the session current when it was made, and a drain returns only
 * that session's calls, so `/new` or `/resume` between a call and the next
 * turn cannot file it under another session.
 */
export interface DecisionCallBuffer {
	readonly sink: DecisionCallSink;
	drain(session: string | null): DecisionCallRecord[];
}

export function createDecisionCallBuffer(currentSession: () => string | null, limit = 256): DecisionCallBuffer {
	let pending: Array<{ session: string | null; record: DecisionCallRecord }> = [];
	return {
		sink: (record) => {
			pending.push({ session: currentSession(), record });
			// A session that never reaches a drain must not grow without bound;
			// the newest calls are the ones a later turn can still be joined to.
			if (pending.length > limit) pending = pending.slice(pending.length - limit);
		},
		drain(session) {
			// Calls from a session that is no longer current are dropped: their
			// ledger is closed to this process until it is resumed.
			const out = pending.filter((entry) => entry.session === session).map((entry) => entry.record);
			pending = [];
			return out;
		},
	};
}
