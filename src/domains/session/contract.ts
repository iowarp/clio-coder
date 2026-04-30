import type { ClioSessionMeta, ClioTurnRecord } from "../../engine/session.js";
import type { SessionEntry } from "./entries.js";
import type { TreeSnapshot } from "./tree/navigator.js";
import type { WorkspaceSnapshot } from "./workspace/index.js";

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
	/** Latest display name discovered from sessionInfo entries. */
	name?: string;
	/** Latest non-empty turn labels discovered from sessionInfo entries. */
	labels?: string[];
	/**
	 * First user-message text discovered while scanning current.jsonl. Used
	 * by the /resume picker as the row's primary identifier so users can
	 * recognize a session by its opening prompt instead of by uuid prefix.
	 * Whitespace-collapsed but otherwise unmodified; the renderer truncates.
	 */
	firstMessagePreview?: string;
	/**
	 * Count of user-role message entries (legacy or v2). Approximates "how
	 * many things did I ask?" for the picker; tool calls and bookkeeping
	 * entries do not contribute. Discovered alongside firstMessagePreview.
	 */
	messageCount?: number;
	/**
	 * Latest entry timestamp seen in current.jsonl, falling back to the
	 * file's mtime. Lets the picker rank sessions by last-activity rather
	 * than creation time so a long-running session moves up after each
	 * turn.
	 */
	lastActivityAt?: string;
	/**
	 * Workspace snapshot captured at session bind. Populated by probeWorkspace
	 * during create(); read-only thereafter. Omitted on resumed sessions that
	 * pre-date this field; the workspace_context tool lazy-fills then.
	 */
	workspace?: WorkspaceSnapshot;
};

export type SessionMeta = ClioSessionMeta & ClioSessionMetaExtension;

export type TurnInput = Omit<ClioTurnRecord, "id" | "at"> & { id?: string; at?: string };

/**
 * Rich entry input: caller may omit turnId and timestamp so the manager can
 * fill them with a uuid v7 + now(). parentTurnId still has to be supplied
 * (or null for the first entry in a branch). Distributes across the union
 * so every kind keeps its discriminant + kind-specific fields.
 */
export type SessionEntryInput = SessionEntry extends infer T
	? T extends SessionEntry
		? Omit<T, "turnId" | "timestamp"> & { turnId?: string; timestamp?: string }
		: never
	: never;

/** Options for SessionContract.deleteSession. */
export interface DeleteSessionOptions {
	/**
	 * When true, retain current.jsonl + tree.json on disk and only tombstone
	 * the meta.json (renamed to meta.deleted.json) so `history()` drops the
	 * session from listings without destroying the transcript. Default false
	 * wipes the entire session directory.
	 */
	keepFiles?: boolean;
}

export interface SessionContract {
	current(): SessionMeta | null;
	/** Create a new session for the given cwd. */
	create(input?: { cwd?: string; model?: string; endpoint?: string }): SessionMeta;
	/** Append a turn to the current session. */
	append(turn: TurnInput): ClioTurnRecord;
	/**
	 * Append a rich SessionEntry to the current session. Complements
	 * `append(turn)` for Phase 12+ entry kinds (compactionSummary,
	 * branchSummary, modelChange, etc.). Old callers keep using `append`.
	 */
	appendEntry(entry: SessionEntryInput): SessionEntry;
	/** Write atomic checkpoint (current.jsonl flush, tree.json persist, meta update). */
	checkpoint(reason?: string): Promise<void>;
	/** Load an existing session and make it current. */
	resume(sessionId: string): SessionMeta;
	/** Fork from a parent turn, producing a new session with parentId pointer. */
	fork(parentTurnId: string, input?: { cwd?: string }): SessionMeta;
	/**
	 * Return a serializable snapshot of the tree for a given session (defaults
	 * to the current session). Built from `tree.json` + resolved labels via
	 * `tree/navigator.ts`; the underlying on-disk artifacts stay engine-owned.
	 */
	tree(sessionId?: string): TreeSnapshot;
	/**
	 * Switch the active session to `sessionId`. Semantically mirrors `resume`:
	 * the /tree overlay uses this to rewire the chat-loop when the user picks
	 * a different branch. Returns the new SessionMeta.
	 */
	switchBranch(sessionId: string): SessionMeta;
	/**
	 * Persist a display-only label for `turnId`. The marker is a
	 * SessionInfoEntry with `targetTurnId` + `label` written to the target
	 * session's current.jsonl. Empty `label` clears the marker. If the target
	 * session is the current one, writes flow through the live writer;
	 * otherwise the helper appends directly to that session's transcript.
	 */
	editLabel(turnId: string, label: string, sessionId?: string): void;
	/**
	 * Remove the given session. By default, wipes the session directory.
	 * `opts.keepFiles` preserves the transcript and only tombstones meta.json.
	 * Refuses to delete a session that is currently open; call `close()` first
	 * or target a different id.
	 */
	deleteSession(id: string, opts?: DeleteSessionOptions): void;
	/** List sessions for current cwd (most-recent first). */
	history(): ReadonlyArray<SessionMeta>;
	/** End current session. */
	close(): Promise<void>;
}
