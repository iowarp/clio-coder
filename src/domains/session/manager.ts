import { v7 as uuidv7 } from "uuid";
import {
	atomicWrite,
	type ClioSessionWriter,
	type ClioTurnRecord,
	createSession as engineCreateSession,
	resumeSession as engineResumeSession,
	readSessionFileEntries,
	type SessionTreeNode,
	sessionPaths,
} from "../../engine/session.js";
import type { SessionEntryInput, SessionMeta, TurnInput } from "./contract.js";
import { isSessionEntry, type SessionEntry } from "./entries.js";
import { runMigrations, stripV2PromptArtifacts } from "./migrations/index.js";

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
	const { meta, writer } = engineResumeSession(sessionId);
	const sessionMeta = meta as SessionMeta;
	// Migration runs on every resume so older sessions opt into the current
	// vocabulary transparently. Meta mutation is in place; ledger-shape
	// migrations rewrite current.jsonl through the writer exactly once.
	const result = runMigrations(sessionMeta);
	const state = { meta: sessionMeta, writer };
	if (result.migrated) {
		if (result.from < 3) {
			const entries = readSessionFileEntries(sessionPaths(sessionMeta).current);
			writer.replaceEntries(entries.map(stripV2PromptArtifacts));
		}
		persistSessionMeta(state);
	}
	return state;
}

export function appendTurn(state: SessionManagerState, input: TurnInput): ClioTurnRecord {
	const record: ClioTurnRecord = {
		id: input.id ?? newTurnId(),
		parentId: input.parentId,
		at: input.at ?? new Date().toISOString(),
		kind: input.kind,
		payload: input.payload,
	};
	state.writer.append(record);
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
