import type { Static } from "typebox";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { TelemetryContext } from "./context.js";
import { TelemetryContextSchema } from "./context.js";
import { ContentClass, Tier, vocabulary } from "./enums.js";
import { newRecordId, UUID_V7_PATTERN } from "./ids.js";
import type { Kind, Payload } from "./schemas.js";
import { isKind, KIND_REGISTRY, UtcSchema, upcastPayload, validPayload } from "./schemas.js";

const closed = { additionalProperties: false };
export const ClockOriginSchema = Type.Object(
	{
		host: Type.String({ minLength: 1 }),
		pid: Type.Integer({ minimum: 1 }),
		birthToken: Type.Union([Type.String(), Type.Null()]),
		monoEpochWallMs: Type.Number({ minimum: 0 }),
	},
	closed,
);
export type ClockOrigin = Static<typeof ClockOriginSchema>;
export const SegmentHeaderSchema = Type.Object(
	{
		v: Type.Literal(1),
		k: Type.Literal("segment.open"),
		schemaSet: Type.String({ minLength: 1 }),
		mode: vocabulary(["standard", "research"]),
		capture: Type.Object(
			{
				content: Type.Boolean(),
				deltas: Type.Boolean(),
				providerHeaders: Type.Boolean(),
				systemOneDataset: Type.Boolean(),
				busTrace: Type.Boolean(),
			},
			closed,
		),
		clockOrigin: ClockOriginSchema,
		writer: Type.Object({ clioVersion: Type.String(), piVersion: Type.String() }, closed),
	},
	closed,
);
export type SegmentHeader = Static<typeof SegmentHeaderSchema>;

export const EnvelopeSchema = Type.Object(
	{
		v: Type.Literal(1),
		k: Type.String(),
		kv: Type.Integer({ minimum: 1 }),
		id: Type.String({ pattern: `^rec_${UUID_V7_PATTERN}$` }),
		t: UtcSchema,
		mono: Type.Number({ minimum: 0 }),
		ctx: TelemetryContextSchema,
		tier: Tier,
		cc: ContentClass,
		data: Type.Unknown(),
	},
	closed,
);
export type TelemetryRecord<K extends Kind = Kind> = K extends Kind
	? Omit<Static<typeof EnvelopeSchema>, "k" | "data"> & { k: K; data: Payload<K> }
	: never;

/** Called by the writer after dequeue; producers do not allocate ids or serialize per record (#434). */
export function makeTelemetryRecord<K extends Kind>(
	kind: K,
	data: Payload<K>,
	ctx: TelemetryContext,
	clock: { t: string; mono: number },
): TelemetryRecord<K> {
	const definition = KIND_REGISTRY[kind];
	return {
		v: 1,
		k: kind,
		kv: definition.version,
		id: newRecordId(),
		...clock,
		ctx,
		tier: definition.tier,
		cc: definition.cc,
		data,
	} as unknown as TelemetryRecord<K>;
}

export type RecordRead =
	| { kind: "record"; record: TelemetryRecord }
	| { kind: "header"; header: SegmentHeader }
	| { kind: "skipped"; reason: "unknown-kind" | "unknown-version" | "invalid-record" };

/** Readers never retire future records; even a newer envelope is counted, not rewritten (#434). */
export function readTelemetryRecord(value: unknown): RecordRead {
	if (!value || typeof value !== "object") return { kind: "skipped", reason: "invalid-record" };
	const raw = value as Record<string, unknown>;
	if (typeof raw.v === "number" && raw.v > 1) return { kind: "skipped", reason: "unknown-version" };
	if (raw.k === "segment.open") {
		return Value.Check(SegmentHeaderSchema, value)
			? { kind: "header", header: value }
			: { kind: "skipped", reason: "invalid-record" };
	}
	if (!Value.Check(EnvelopeSchema, value)) return { kind: "skipped", reason: "invalid-record" };
	if (!isKind(value.k)) return { kind: "skipped", reason: "unknown-kind" };
	const definition = KIND_REGISTRY[value.k];
	if (value.kv > definition.version) return { kind: "skipped", reason: "unknown-version" };
	let data: unknown;
	try {
		data = upcastPayload(value.k, value.kv, value.data);
	} catch {
		// Bad historical payloads are counted just like a failed current-schema check (#434).
		return { kind: "skipped", reason: "invalid-record" };
	}
	if (data === undefined) return { kind: "skipped", reason: "unknown-version" };
	if (value.tier !== definition.tier || value.cc !== definition.cc || !validPayload(value.k, data)) {
		return { kind: "skipped", reason: "invalid-record" };
	}
	if (value.k === "call.started" || value.k === "call.settled") {
		const call = data as Payload<"call.started">;
		if (value.ctx.callId !== call.callId || value.ctx.attemptId !== call.attemptId || value.ctx.label !== call.label) {
			return { kind: "skipped", reason: "invalid-record" };
		}
	}
	return { kind: "record", record: { ...value, kv: definition.version, data } as TelemetryRecord };
}

/** A monotonic value only has meaning under its own segment origin (#434). */
export function monotonicSpan(
	start: { origin: ClockOrigin; mono: number },
	end: { origin: ClockOrigin; mono: number },
): number | null {
	if (
		start.origin.host !== end.origin.host ||
		start.origin.pid !== end.origin.pid ||
		start.origin.birthToken !== end.origin.birthToken ||
		start.origin.monoEpochWallMs !== end.origin.monoEpochWallMs ||
		!Number.isFinite(start.mono) ||
		!Number.isFinite(end.mono) ||
		end.mono < start.mono
	)
		return null;
	return end.mono - start.mono;
}
