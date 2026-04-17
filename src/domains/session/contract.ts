import type { ClioSessionMeta, ClioTurnRecord } from "../../engine/session.js";

/**
 * Domain-level session metadata. Extends the engine's on-disk meta with
 * optional fork pointers and checkpoint bookkeeping. The extra fields live
 * alongside the engine's keys in the same meta.json; readers that only know
 * about ClioSessionMeta simply ignore them.
 */
export type ClioSessionMetaExtension = {
	parentSessionId?: string | null;
	parentTurnId?: string | null;
	lastCheckpointAt?: string | null;
	lastCheckpointReason?: string | null;
};

export type SessionMeta = ClioSessionMeta & ClioSessionMetaExtension;

export type TurnInput = Omit<ClioTurnRecord, "id" | "at"> & { id?: string; at?: string };

export interface SessionContract {
	current(): SessionMeta | null;
	/** Create a new session for the given cwd. */
	create(input?: { cwd?: string; model?: string; provider?: string }): SessionMeta;
	/** Append a turn to the current session. */
	append(turn: TurnInput): ClioTurnRecord;
	/** Write atomic checkpoint (current.jsonl flush, tree.json persist, meta update). */
	checkpoint(reason?: string): Promise<void>;
	/** Load an existing session and make it current. */
	resume(sessionId: string): SessionMeta;
	/** Fork from a parent turn, producing a new session with parentId pointer. */
	fork(parentTurnId: string, input?: { cwd?: string }): SessionMeta;
	/** List sessions for current cwd (most-recent first). */
	history(): ReadonlyArray<SessionMeta>;
	/** End current session. */
	close(): Promise<void>;
}
