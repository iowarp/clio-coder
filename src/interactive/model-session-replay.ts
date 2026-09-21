import { foldWorkingSet } from "../domains/context/working-set/fold.js";
import { projectWorkingSet } from "../domains/context/working-set/project.js";
import {
	type ContinuityForkBinding,
	type ContinuityProjection,
	continuityReplayBlocks,
	resolveContinuityProjection,
} from "../domains/session/continuity/projection.js";
import type { SessionContract } from "../domains/session/contract.js";
import type { SessionEntry } from "../domains/session/entries.js";
import type { AgentMessage } from "../engine/types.js";
import {
	activeEntriesBeforeCompactionCut,
	buildReplayAgentMessagesFromTurns,
	type RehydrateChatPanelOptions,
} from "./chat-renderer.js";

/**
 * The session-ownership facts continuity needs, which a renderer does not have.
 *
 * Supplying this is what separates a fork's own transactions from the ones it
 * inherited. Without it a reader owns nothing: inherited recall still projects,
 * because losing the note is the one outcome that is never safe, but no
 * transaction can reach execution authority.
 */
export interface ContinuityReplayContext {
	/** The opened session's actual id, from `session.current()`. */
	sessionId?: string;
	/** `meta.parentSessionId` / `meta.parentTurnId`, when this session is a fork. */
	fork?: ContinuityForkBinding;
	/**
	 * True only for a genuine historical cut of this session's own transactions.
	 * A live `/tree` selection is not one, even though the renderer passes
	 * `uptoTurnId` for both.
	 */
	historical?: boolean;
	/** Parse failures the reader counted, so a torn record cannot become permission. */
	unreadableRecords?: number;
	nowMs?: number;
}

export interface ModelReplayOptions extends RehydrateChatPanelOptions {
	continuity?: ContinuityReplayContext;
}

/**
 * Derive replay ownership from the open session.
 *
 * `meta.parentSessionId` and `meta.parentTurnId` are what `enrichForkMeta`
 * stamps on a child, and together they are the fork binding. The header's
 * `parentSession` is a path to the parent's ledger, a different fact, and is
 * deliberately not used as a session id. A session with no fork pointers
 * publishes no binding, so a foreign-origin record in a session that never
 * forked stays unprojected instead of being read as inheritance.
 *
 * `historical` is never set here. A replay is historical only when a caller
 * standing at a past turn says so; deriving it from the renderer's `uptoTurnId`
 * would make an ordinary `/tree` selection permanently surrender this session's
 * ownership of its own transactions.
 */
export function continuityContextFromSession(
	/** Narrowed to the one method this needs, so partial session owners qualify. */
	session: Pick<SessionContract, "current"> | undefined,
): ContinuityReplayContext {
	const meta = session?.current();
	if (!meta) return {};
	const parentSessionId = meta.parentSessionId ?? null;
	const parentTurnId = meta.parentTurnId ?? null;
	return {
		sessionId: meta.id,
		...(parentSessionId !== null && parentTurnId !== null ? { fork: { parentSessionId, parentTurnId } } : {}),
	};
}

/**
 * Resolve the continuity projection for a replay.
 *
 * Folded over the active path **before** the compaction cut and before the
 * working-set projection, because both of those remove records the fold needs:
 * a commit, a pause or an operator control request older than the cut is still
 * the evidence for the state the note describes. `withContinuityReplay` is the
 * exported entry point, so the transcript and the model always render blocks
 * from one resolution rather than two.
 */
function resolveReplayContinuity(
	entries: ReadonlyArray<SessionEntry>,
	options: ModelReplayOptions = {},
): ContinuityProjection {
	const context = options.continuity ?? {};
	return resolveContinuityProjection({
		// The positional cut applies only to a real historical selection. A live
		// /tree switch passes `uptoTurnId` for display and must still see the
		// sidecars anchored after the selected message, because they are part of
		// its own branch's current state.
		entries: activeEntriesBeforeCompactionCut(entries, options, context.historical === true),
		...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
		...(context.fork === undefined ? {} : { fork: context.fork }),
		...(context.historical === undefined ? {} : { historical: context.historical }),
		...(context.unreadableRecords === undefined ? {} : { unreadableRecords: context.unreadableRecords }),
		...(context.nowMs === undefined ? {} : { nowMs: context.nowMs }),
	});
}

/**
 * Resolve continuity once and hand the same finished blocks to both surfaces.
 *
 * The transcript and the model must show byte-identical note text, so the
 * projection is resolved here and the rendered blocks travel on the options
 * object that `rehydrateChatPanelFromTurns` and
 * `buildModelReplayAgentMessagesFromTurns` both receive. Resolving it twice
 * would be two chances to disagree.
 */
export function withContinuityReplay(
	turns: ReadonlyArray<SessionEntry>,
	options: RehydrateChatPanelOptions,
	session: Pick<SessionContract, "current"> | undefined,
): ModelReplayOptions {
	const merged: ModelReplayOptions = { ...options, continuity: continuityContextFromSession(session) };
	return { ...merged, continuityBlocks: continuityReplayBlocks(resolveReplayContinuity(turns, merged)) };
}

/**
 * Build provider-facing replay messages from the durable session ledger.
 * Projection always honors existing eviction and recall entries; the enabled
 * setting gates creation of new evictions, not replay of durable state.
 * Visible transcript and export callers intentionally keep using the raw
 * rehydration helpers so eviction remains a model projection, not data loss.
 *
 * Continuity is resolved first, from the complete pre-cut ledger, so the
 * accepted note survives both the working-set projection and the compaction
 * cut. It is carried as labelled data and never becomes a synthetic operator
 * instruction.
 */
export function buildModelReplayAgentMessagesFromTurns(
	entries: ReadonlyArray<SessionEntry>,
	options: ModelReplayOptions = {},
): AgentMessage[] {
	const activeLeafTurnId = options.activeLeafTurnId ?? options.uptoTurnId;
	// A caller that already resolved the projection passes its blocks through,
	// so the transcript beside this replay renders the identical bytes.
	const blocks = options.continuityBlocks ?? continuityReplayBlocks(resolveReplayContinuity(entries, options));
	const projected = projectWorkingSet(entries, foldWorkingSet(entries, activeLeafTurnId), activeLeafTurnId);
	return buildReplayAgentMessagesFromTurns(projected, {
		...options,
		skillContextEntries: entries,
		continuityBlocks: blocks,
	});
}
