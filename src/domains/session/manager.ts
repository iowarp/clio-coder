import { v7 as uuidv7 } from "uuid";
import {
	atomicWrite,
	type ClioSessionWriter,
	type ClioTurnRecord,
	createSession as engineCreateSession,
	openSession as engineOpenSession,
	resumeSession as engineResumeSession,
	type SessionTreeNode,
	sessionPaths,
} from "../../engine/session.js";
import type { SessionEntryInput, SessionMeta, TurnInput } from "./contract.js";
import { isSessionEntry, type SessionEntry } from "./entries.js";
import { runMigrations } from "./migrations/index.js";

/**
 * Wraps engine/session.ts so the session domain can track the single in-memory
 * current writer + meta. Turn writes go through the engine writer (`append` /
 * `appendEntry`); metadata-only updates use `persistSessionMeta` so domain
 * extensions can make newly attached metadata durable without closing.
 */

export interface SessionManagerState {
	meta: SessionMeta;
	writer: ClioSessionWriter;
}

/**
 * Generate a v7 UUID for session and turn ids. RFC 9562 § 5.7 defines a 48-bit
 * unix-ms timestamp prefix makes the ids time-sortable, which lets
 * history()/tree() order by creation without a separate timestamp index.
 */
export function newTurnId(): string {
	return uuidv7();
}

export function startSession(input: {
	cwd: string;
	model?: string | null;
	target?: string | null;
	initialEntries?: ReadonlyArray<unknown>;
	initialTree?: ReadonlyArray<SessionTreeNode>;
	parentSession?: string;
	parentTurnId?: string;
}): SessionManagerState {
	const { meta, writer } = engineCreateSession({
		cwd: input.cwd,
		model: input.model ?? null,
		target: input.target ?? null,
		...(input.initialEntries !== undefined ? { initialEntries: input.initialEntries } : {}),
		...(input.initialTree !== undefined ? { initialTree: input.initialTree } : {}),
		...(input.parentSession !== undefined ? { parentSession: input.parentSession } : {}),
		...(input.parentTurnId !== undefined ? { parentTurnId: input.parentTurnId } : {}),
	});
	return { meta: meta as SessionMeta, writer };
}

export function persistSessionMeta(state: SessionManagerState): void {
	atomicWrite(sessionPaths(state.meta).meta, JSON.stringify(state.meta, null, 2));
}

export function resumeSessionState(sessionId: string): SessionManagerState {
	const sessionMeta = engineOpenSession(sessionId).meta() as SessionMeta;
	const paths = sessionPaths(sessionMeta);
	runMigrations(sessionMeta, paths.meta);
	const { writer } = engineResumeSession(sessionId);
	return { meta: sessionMeta, writer };
}

export function appendTurn(state: SessionManagerState, input: TurnInput): ClioTurnRecord {
	const record: ClioTurnRecord = {
		id: input.id ?? newTurnId(),
		parentId: input.parentId,
		at: input.at ?? new Date().toISOString(),
		kind: input.kind,
		payload: input.payload,
	};
	const entry: SessionEntry = {
		kind: "message",
		turnId: record.id,
		parentTurnId: record.parentId,
		timestamp: record.at,
		role: record.kind,
		payload: record.payload,
	};
	state.writer.appendEntry(entry, {
		treeNode: {
			id: record.id,
			parentId: record.parentId,
			at: record.at,
			kind: record.kind,
		},
	});
	return record;
}

/**
 * Append a rich SessionEntry via the engine writer. Non-message kinds are
 * written as JSON lines to current.jsonl; they do not project into tree.json
 * in slice 12a. Slice 12b extends the tree model so /fork can pick non-message
 * branch points too.
 */
export function appendEntry(state: SessionManagerState, input: SessionEntryInput): SessionEntry {
	const turnId = input.turnId ?? newTurnId();
	const timestamp = input.timestamp ?? new Date().toISOString();
	// Re-assemble the entry with canonical turnId + timestamp. The caller's
	// kind-specific fields pass through via the spread; the union's structural
	// shape is preserved because `input` is SessionEntryInput (distributed).
	const entry = { ...input, turnId, timestamp } as SessionEntry;
	if (!isSessionEntry(entry)) throw new Error(`session.appendEntry: invalid ${String(input.kind)} entry`);
	state.writer.appendEntry(entry);
	return entry;
}

export function replaceEntries(state: SessionManagerState, entries: ReadonlyArray<SessionEntry>): void {
	for (const entry of entries) {
		if (!isSessionEntry(entry)) throw new Error("session.replaceEntries: invalid entry");
	}
	state.writer.replaceEntries(entries);
}
