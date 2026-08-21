/**
 * `age-horizon`: today's selection, recorded instead of destroyed.
 *
 * The rule is exactly what `maskStaleObservations` applied before this layer
 * existed. Every tool-result body older than the protected recent-turn horizon
 * leaves the working set, and every assistant message older than the horizon
 * loses its thinking blocks. Same turn-start definition, same cutoff, same
 * skip conditions. The difference is that the bodies stay in the ledger and
 * come back with `context(scope="recall", ref=...)`.
 *
 * It shipped as the default for one slice so the ledger could stop being
 * rewritten without changing what the model saw; `structural-v1` is the default
 * now and this policy stays as the recorded form of the old selection. It has
 * no target stop on purpose: everything beyond the horizon leaves in one event,
 * as the mask did, and `pressure.target` is ignored.
 *
 * Age is not a quality signal, which is the whole reason `structural-v1`
 * exists: a file read twenty turns ago and never touched since is more useful
 * than a directory listing from two turns ago. Nothing here scores candidates
 * by size or recency beyond that ordering; the only token input is the
 * `minEvictableTokens` floor, below which the marker costs more than the body.
 */

import type { EvictionCandidate, PolicyInput, WorkingSetPolicy } from "../contract.js";
import { protectionCutoffIndex } from "../horizon.js";
import { hasLegacyCompactionMarker, hasThinking, toolResultBodyTokens } from "../payload.js";

export const ageHorizonPolicy: WorkingSetPolicy = {
	id: "age-horizon",
	select(input: PolicyInput): ReadonlyArray<EvictionCandidate> {
		const { entries, view, settings } = input;
		const cutoff = protectionCutoffIndex(entries, settings.protectLastTurns);
		const candidates: EvictionCandidate[] = [];
		// Newest-safe-first: the entry closest to the protection horizon is the
		// least likely to be re-read, and a caller that stops early has then
		// evicted the oldest nothing and the newest something.
		for (let i = cutoff - 1; i >= 0; i -= 1) {
			const entry = entries[i];
			if (entry === undefined || entry.kind !== "message") continue;
			if (view.evicted.has(entry.turnId)) continue;
			if (entry.role === "tool_result") {
				if (hasLegacyCompactionMarker(entry.payload)) continue;
				if (toolResultBodyTokens(entry.payload) < settings.minEvictableTokens) continue;
				candidates.push({ ref: { entry: entry.turnId }, reason: "age_horizon" });
				continue;
			}
			// Thinking has no size floor: dropping it costs no marker, so even a
			// short stretch of reasoning is free to remove.
			if (entry.role === "assistant" && hasThinking(entry.payload)) {
				candidates.push({ ref: { entry: entry.turnId }, reason: "thinking_turn_closed" });
			}
		}
		return candidates;
	},
};
