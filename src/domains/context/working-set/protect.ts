/**
 * Protection predicates: what the working set never gives up, whatever a rule
 * concludes.
 *
 * These run before every rule and are absolute. A policy is allowed to be
 * wrong about relevance (that is what the replay table measures); it is not
 * allowed to drop the operator's words, the last few turns of work, a failure
 * nobody has resolved, or a mutation the current turn is still standing on.
 * Charter 4.5 lists them; this module is that list, and `structural.ts` calls
 * it on every candidate rather than reimplementing any of it.
 *
 * Pure over the entry, the index, and the policy input.
 */

import type { SessionEntry } from "../../session/entries.js";
import type { PolicyInput } from "./contract.js";
import type { PathIndex, PathObservation } from "./path-index.js";
import { hasLegacyCompactionMarker, isRecord, toolResultBodyTokens } from "./payload.js";

export interface ProtectionContext {
	entryIndex: number;
	/** First entry of the protected recent window, from `protectionCutoffIndex`. */
	cutoffIndex: number;
	input: PolicyInput;
	index: PathIndex;
}

/** Ops whose identity is the file they touched, so a retry on the same path counts as the same call. */
const PATH_IDENTIFIED_OPS = new Set(["read", "grep", "find"]);

function isBlockedResult(payload: unknown): boolean {
	if (!isRecord(payload)) return false;
	// The registry's admission verdict, persisted by turn-persistence. A call
	// the safety rails refused is a decision the session made, not an
	// observation it can re-fetch.
	return payload.outcome === "blocked" || typeof payload.blockReason === "string";
}

function isErrorResult(payload: unknown): boolean {
	if (!isRecord(payload)) return false;
	return payload.isError === true || payload.error === true;
}

/**
 * The later call that resolved this failure: same tool with byte-identical
 * arguments, or, for the path-identified ops, the same file by any route. Null
 * when nothing after it succeeded, which is what keeps the failure protected.
 *
 * Shared with `structural.ts` rung 3 on purpose: the rule that evicts a
 * resolved failure and the predicate that protects an unresolved one must
 * answer the same question, or a failure could be both.
 */
export function findLaterSuccess(observation: PathObservation, index: PathIndex): PathObservation | null {
	for (const candidate of index.observations) {
		if (candidate.entryIndex <= observation.entryIndex || candidate.isError) continue;
		if (candidate.toolName === observation.toolName && observation.argsKey.length > 0) {
			if (candidate.argsKey === observation.argsKey) return candidate;
		}
		if (
			PATH_IDENTIFIED_OPS.has(observation.op) &&
			candidate.op === observation.op &&
			observation.path.length > 0 &&
			candidate.path === observation.path
		) {
			return candidate;
		}
	}
	return null;
}

/** A write or edit the turn in flight is still standing on. */
function isActiveTurnMutation(observation: PathObservation, index: PathIndex): boolean {
	if (observation.op !== "write" && observation.op !== "edit") return false;
	return observation.turnIndex >= index.turnCount;
}

export function isProtected(entry: SessionEntry, ctx: ProtectionContext): boolean {
	// Only two things ever leave the working set: a tool result's body and an
	// assistant turn's thinking. Everything else (operator words, summaries,
	// skill activations, ledgers, worker runs, bash executions) is the session's
	// own record of itself.
	if (entry.kind !== "message") return true;
	if (entry.role !== "tool_result" && entry.role !== "assistant") return true;

	// The recent window is untouchable for both kinds.
	if (ctx.entryIndex >= ctx.cutoffIndex) return true;
	if (entry.role === "assistant") return false;

	// Below the floor the marker costs more than the body it replaces. The
	// floor is the body's size, not the payload's: details never reach the model.
	if (toolResultBodyTokens(entry.payload) < ctx.input.settings.minEvictableTokens) return true;
	// A body the legacy destructive stage already replaced has nothing left to evict.
	if (hasLegacyCompactionMarker(entry.payload)) return true;
	if (isBlockedResult(entry.payload)) return true;

	const observation = ctx.index.byRef.get(entry.turnId);
	// No observation means no way to ask whether a failure was resolved, so an
	// unindexed failure stays. Everything else unindexed is an ordinary result
	// the age rung may still take under pressure.
	if (observation === undefined) return isErrorResult(entry.payload);

	if (isActiveTurnMutation(observation, ctx.index)) return true;
	if (observation.isError && findLaterSuccess(observation, ctx.index) === null) return true;
	return false;
}
