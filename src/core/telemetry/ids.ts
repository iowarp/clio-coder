import { createHash, randomBytes } from "node:crypto";

declare const telemetryId: unique symbol;
export type CallId = string & { readonly [telemetryId]: "call" };
export type AttemptId = string & { readonly [telemetryId]: "attempt" };
export type RecordId = string & { readonly [telemetryId]: "record" };

/** RFC 9562 UUIDv7, independent of the provider SDK and existing session/run ids (#434). */
function uuidV7(bytes = randomBytes(16), epochMs = Date.now()): string {
	bytes.writeUIntBE(Math.min(Math.max(0, Math.trunc(epochMs)), 2 ** 48 - 1), 0, 6);
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const newCallId = (): CallId => `cal_${uuidV7()}` as CallId;
export const newAttemptId = (): AttemptId => `att_${uuidV7()}` as AttemptId;
export const newRecordId = (): RecordId => `rec_${uuidV7()}` as RecordId;
/** Minted once per process; names the process journal (#434). */
export const newProcessId = (): string => `prc_${uuidV7()}`;

/**
 * Stable ids for facts rebuilt from records that already carry identity, such as legacy ledger entries: the same
 * seed always yields the same id, so references to an imported call survive every re-read (#434).
 */
export function derivedTelemetryIds(seed: string, epochMs: number) {
	const id = (kind: string) =>
		uuidV7(Buffer.from(createHash("sha256").update(`${kind}\0${seed}`).digest().subarray(0, 16)), epochMs);
	return {
		callId: `cal_${id("call")}` as CallId,
		attemptId: `att_${id("attempt")}` as AttemptId,
		startedRecordId: `rec_${id("call.started")}` as RecordId,
		settledRecordId: `rec_${id("call.settled")}` as RecordId,
		usageRecordId: `rec_${id("run.usage")}` as RecordId,
	};
}

export { UUID_V7_PATTERN } from "./id-schemas.js";
