/**
 * The protection horizon: where the recent, untouchable window begins.
 *
 * Both policies and every protection predicate answer "is this entry inside the
 * recent window" the same way, so the arithmetic lives here once.
 *
 * Two horizons, and the window is the narrower of them. The turn horizon is
 * the same cutoff `maskStaleObservations` used before this layer existed:
 * walk back `protectLastTurns` turn starts. The step horizon walks back
 * `protectLastSteps` assistant messages. Real ledgers put most of a session
 * inside one to four user turns, each with dozens of tool results, so a
 * turn-only window covered the whole session and the layer never fired; the
 * step horizon is what lets a stale read from forty steps ago leave while the
 * last few steps, including the assistant message whose thinking the provider
 * still needs paired with its tool results, stay untouched.
 */

import type { SessionEntry } from "../../session/entries.js";

export interface ProtectionHorizon {
	protectLastTurns: number;
	protectLastSteps: number;
}

/**
 * What starts a turn, in the sense the protection horizon counts. A local `!`
 * bash execution and a branch summary both open a new stretch of work the same
 * way an operator message does.
 */
export function isTurnStart(entry: SessionEntry): boolean {
	if (entry.kind === "bashExecution" || entry.kind === "branchSummary") return true;
	return entry.kind === "message" && entry.role === "user";
}

/** What starts a step: the assistant message whose tool calls the following results answer. */
function isStepStart(entry: SessionEntry): boolean {
	return entry.kind === "message" && entry.role === "assistant";
}

function cutoffByStarts(
	entries: ReadonlyArray<SessionEntry>,
	horizon: number,
	isStart: (entry: SessionEntry) => boolean,
): number {
	const wanted = Math.max(1, Math.floor(horizon));
	let seen = 0;
	for (let i = entries.length - 1; i >= 0; i -= 1) {
		const entry = entries[i];
		if (!entry || !isStart(entry)) continue;
		seen += 1;
		if (seen >= wanted) return i;
	}
	return 0;
}

/**
 * Index of the first protected entry. Entries before it are candidates,
 * entries from it on are the recent window nothing touches. The later of the
 * two cutoffs wins: the window is at most `protectLastTurns` turns and at most
 * `protectLastSteps` steps.
 *
 * A turn whose model reply has not started yet has no step start after its
 * user message; the step cutoff then falls inside the previous turn and the
 * turn cutoff, which is later, decides. A ledger with no assistant message at
 * all protects everything, as before.
 */
export function protectionCutoffIndex(entries: ReadonlyArray<SessionEntry>, horizon: ProtectionHorizon): number {
	const byTurn = cutoffByStarts(entries, horizon.protectLastTurns, isTurnStart);
	const byStep = cutoffByStarts(entries, horizon.protectLastSteps, isStepStart);
	return Math.max(byTurn, byStep);
}
