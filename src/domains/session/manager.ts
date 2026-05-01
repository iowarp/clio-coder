import { v7 as uuidv7 } from "uuid";
import {
	atomicWrite,
	type ClioSessionWriter,
	type ClioTurnRecord,
	createSession as engineCreateSession,
	resumeSession as engineResumeSession,
	sessionPaths,
} from "../../engine/session.js";
import type { SessionEntryInput, SessionMeta, TurnInput } from "./contract.js";
import type { SessionEntry } from "./entries.js";
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
	endpoint?: string | null;
}): SessionManagerState {
	const { meta, writer } = engineCreateSession({
		cwd: input.cwd,
		model: input.model ?? null,
		endpoint: input.endpoint ?? null,
	});
	return { meta: meta as SessionMeta, writer };
}

export function persistSessionMeta(state: SessionManagerState): void {
	atomicWrite(sessionPaths(state.meta).meta, JSON.stringify(state.meta, null, 2));
}

export function resumeSessionState(sessionId: string): SessionManagerState {
	const { meta, writer } = engineResumeSession(sessionId);
	const sessionMeta = meta as SessionMeta;
	// Migration runs on every resume so pre-v2 sessions opt into the v2
	// vocabulary transparently. Mutation is in place; the next checkpoint
	// persists the bumped sessionFormatVersion to meta.json.
	runMigrations(sessionMeta);
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
	if (input.dynamicInputs !== undefined) record.dynamicInputs = input.dynamicInputs;
	if (input.renderedPromptHash !== undefined) record.renderedPromptHash = input.renderedPromptHash;
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
	state.writer.appendEntry(entry);
	return entry;
}
