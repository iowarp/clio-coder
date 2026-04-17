import { randomBytes } from "node:crypto";
import {
	type ClioSessionWriter,
	type ClioTurnRecord,
	createSession as engineCreateSession,
	resumeSession as engineResumeSession,
} from "../../engine/session.js";
import type { SessionMeta, TurnInput } from "./contract.js";

/**
 * Wraps engine/session.ts so the session domain can track the single in-memory
 * current writer + meta. The manager never persists on its own — writes go
 * through the engine writer (`append`) or through the helpers in
 * checkpoint.ts which call writer.persistTree and atomicWrite.
 */

export interface SessionManagerState {
	meta: SessionMeta;
	writer: ClioSessionWriter;
}

export function newTurnId(): string {
	const n = BigInt(`0x${randomBytes(8).toString("hex")}`);
	const raw = n.toString(36);
	if (raw.length >= 12) return raw.slice(0, 12);
	return raw.padStart(12, "0");
}

export function startSession(input: {
	cwd: string;
	model?: string | null;
	provider?: string | null;
}): SessionManagerState {
	const { meta, writer } = engineCreateSession({
		cwd: input.cwd,
		model: input.model ?? null,
		provider: input.provider ?? null,
	});
	return { meta: meta as SessionMeta, writer };
}

export function resumeSessionState(sessionId: string): SessionManagerState {
	const { meta, writer } = engineResumeSession(sessionId);
	return { meta: meta as SessionMeta, writer };
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
