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
import type { ChainMember, PathIndex, PathObservation } from "./path-index.js";
import { hasLegacyCompactionMarker, isRecord, recalledRef, toolResultBodyTokens } from "./payload.js";

export interface ProtectionContext {
	entryIndex: number;
	/** First entry of the protected recent window, from `protectionCutoffIndex`. */
	cutoffIndex: number;
	input: PolicyInput;
	index: PathIndex;
	/** Units a protection profile pins (`profilePins` in policies/profiles.ts); absent means none. */
	pins?: ReadonlySet<string>;
	/**
	 * The churn pin: a body the model recalled more than once stays where the
	 * recall put it. The recalled body lives in the recall tool result, so the
	 * pin protects that result, keyed by the ref it readmitted.
	 */
	pinRecalledTwice?: boolean;
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
 * A refused call is not a success: the safety rails returned a verdict, not
 * the observation the failure was trying to make.
 *
 * Shared with `structural.ts` rung 3 on purpose: the rule that evicts a
 * resolved failure and the predicate that protects an unresolved one must
 * answer the same question, or a failure could be both.
 */
export function findLaterSuccess(observation: PathObservation, index: PathIndex): PathObservation | null {
	for (const candidate of index.observations) {
		if (candidate.entryIndex <= observation.entryIndex || candidate.isError || candidate.isBlocked) continue;
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

/**
 * A later call of the same tool with byte-identical arguments, whatever its
 * outcome. The newer run is the live evidence for that command; the older
 * output is a claim about a state the session has since re-observed. Shared
 * with `structural.ts` rung 4 and with the unresolved-failure protection below,
 * so a failure that was re-run and failed again is superseded rather than
 * pinned forever.
 */
export function findLaterRun(observation: PathObservation, index: PathIndex): PathObservation | null {
	if (observation.argsKey.length === 0) return null;
	for (const candidate of index.observations) {
		if (candidate.entryIndex <= observation.entryIndex || candidate.isBlocked) continue;
		if (candidate.toolName === observation.toolName && candidate.argsKey === observation.argsKey) return candidate;
	}
	return null;
}

/** A write or edit the turn in flight is still standing on. */
function isActiveTurnMutation(observation: PathObservation, index: PathIndex): boolean {
	if (observation.op !== "write" && observation.op !== "edit") return false;
	return observation.turnIndex >= index.turnCount;
}

/**
 * What an observed result keeps on its own: a mutation the turn in flight
 * stands on, or a failure nothing later resolved or re-ran.
 */
function isKeptObservation(observation: PathObservation, index: PathIndex): boolean {
	if (isActiveTurnMutation(observation, index)) return true;
	return (
		observation.isError && findLaterSuccess(observation, index) === null && findLaterRun(observation, index) === null
	);
}

/**
 * Whether one member of a chain aggregate would be kept as a standalone result
 * of its capability, and nothing stricter: a refused step, an unindexed
 * failure, or what `isKeptObservation` keeps. Size, pins and the recent window
 * belong to the aggregate, because it is the unit a marker replaces.
 */
function isKeptChainMember(member: ChainMember, index: PathIndex): boolean {
	if (member.isBlocked) return true;
	if (member.observation === null) return member.isError;
	return isKeptObservation(member.observation, index);
}

/**
 * A failed step the member list cannot account for. A step whose `$from`
 * binding failed never ran, so it is no member, yet the aggregate's failure
 * rests on it. Nothing can say that failure was resolved, so the aggregate
 * stays, exactly as an unindexed standalone failure does.
 */
function hasUnindexedChainFailure(payload: unknown, members: ReadonlyArray<ChainMember>): boolean {
	const result = isRecord(payload) && isRecord(payload.result) ? payload.result : null;
	const steps = result !== null && isRecord(result.details) ? result.details.steps : undefined;
	if (!Array.isArray(steps)) return false;
	// Member ids are `<aggregate toolCallId>:<step id>`; step ids never contain a colon.
	const indexed = new Set(members.map((member) => member.toolCallId.slice(member.toolCallId.lastIndexOf(":") + 1)));
	return steps.some(
		(row) => isRecord(row) && row.kind === "error" && typeof row.id === "string" && !indexed.has(row.id),
	);
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
	// Eviction addresses whole persisted results, so a chain aggregate leaves
	// as one unit or not at all: one member a standalone result would keep
	// keeps every sibling. The composer separately requires every member to earn a
	// rung reason before it claims the aggregate (`policies/compose.ts`).
	const members = ctx.index.chainMembers.get(entry.turnId);
	if (members?.some((member) => isKeptChainMember(member, ctx.index))) return true;
	if (members !== undefined && hasUnindexedChainFailure(entry.payload, members)) return true;

	// Profile pins and the churn pin come before the floor: a pinned unit stays
	// whatever its size.
	if (ctx.pins?.has(entry.turnId)) return true;
	if (ctx.pinRecalledTwice === true) {
		const ref = recalledRef(entry.payload);
		if (ref !== null && (ctx.input.view.recallsByRef.get(ref) ?? 0) >= 2) return true;
	}

	// The floor protects low-yield bodies from churn. The engine separately
	// rejects any candidate whose marker would free zero or negative tokens, so
	// this setting may stay above the literal marker break-even point. The floor
	// is the body's size, not the payload's: details never reach the model.
	if (toolResultBodyTokens(entry.payload) < ctx.input.settings.minEvictableTokens) return true;
	// A body the legacy destructive stage already replaced has nothing left to evict.
	if (hasLegacyCompactionMarker(entry.payload)) return true;
	if (isBlockedResult(entry.payload)) return true;
	// A failed chain is an error result as a whole; its members, and the
	// unindexed-failure check above, already answered the failure question.
	if (members !== undefined) return false;

	const observation = ctx.index.byRef.get(entry.turnId);
	// No observation means no way to ask whether a failure was resolved, so an
	// unindexed failure stays. Everything else unindexed is an ordinary result
	// the age rung may still take under pressure.
	if (observation === undefined) return isErrorResult(entry.payload);
	return isKeptObservation(observation, ctx.index);
}
