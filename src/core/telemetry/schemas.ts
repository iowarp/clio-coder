import type { Static, TSchema } from "typebox";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { AttemptIdSchema, CallIdSchema, ExistingId } from "./context.js";
import type { ContentClass, Tier } from "./enums.js";
import {
	CallLabel,
	Disposition,
	FailureCause,
	RoundKind,
	RunTerminalReason,
	StopReason,
	TransportKind,
	vocabulary,
} from "./enums.js";
import { factSchema } from "./fact.js";

const closed = { additionalProperties: false };
const count = Type.Integer({ minimum: 0 });
const duration = Type.Number({ minimum: 0 });
const text = Type.String({ maxLength: 4096 });
const utc = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
export const ObjectRefSchema = Type.Object(
	{
		label: vocabulary(["resolvable", "commitment"]),
		function: Type.Literal("sha256"),
		canonicalization: Type.Literal("json-sorted-v1"),
		subject: vocabulary(["prompt-structure", "tool-schemas", "config", "briefing", "steering", "request", "prompt-text"]),
		id: Type.String({ pattern: "^obj_[0-9a-f]{64}$" }),
	},
	closed,
);
export type ObjectRef = Static<typeof ObjectRefSchema>;

export const UsageSchema = Type.Object(
	{
		input: factSchema(count),
		cacheRead: factSchema(count),
		cacheWrite: factSchema(count),
		cacheWrite1h: factSchema(count),
		output: factSchema(count),
		reasoning: factSchema(count),
	},
	closed,
);
export type CallUsage = Static<typeof UsageSchema>;
export const PricingSchema = Type.Object(
	{
		usd: factSchema(duration),
		pricedBy: vocabulary(["provider", "target-rates", "catalog", "free", "none"]),
		rateRef: Type.Optional(ObjectRefSchema),
	},
	closed,
);
const target = Type.Object(
	{
		targetId: ExistingId,
		runtimeId: ExistingId,
		api: ExistingId,
		requestedModel: ExistingId,
		reportedModel: factSchema(text),
	},
	closed,
);
const call = {
	callId: CallIdSchema,
	attemptId: AttemptIdSchema,
	attempt: count,
	label: CallLabel,
	target,
	roundKind: RoundKind,
	toolChoice: Type.Union([vocabulary(["auto", "none", "required"]), Type.Object({ name: ExistingId }, closed)]),
};
const span = { start: duration, end: duration };
const stop = Type.Object(
	{ reason: StopReason, failure: Type.Optional(FailureCause), detail: Type.Optional(text) },
	closed,
);
export const CallStartedSchema = Type.Object(call, closed);
export type CallStarted = Static<typeof CallStartedSchema>;
export const CallSettledSchema = Type.Object(
	{
		...call,
		disposition: Disposition,
		stop,
		usage: Type.Union([UsageSchema, Type.Null()]),
		pricing: PricingSchema,
		stages: Type.Object(
			{
				admission: Type.Optional(
					Type.Object({ ...span, waitedOn: Type.Optional(vocabulary(["budget", "capacity", "steering"])) }, closed),
				),
				auth: Type.Optional(Type.Object({ ...span, refreshed: Type.Optional(Type.Boolean()) }, closed)),
				transform: Type.Optional(Type.Object(span, closed)),
				connect: Type.Optional(Type.Object({ ...span, reused: Type.Optional(Type.Boolean()) }, closed)),
				send: Type.Optional(Type.Object(span, closed)),
				firstByte: Type.Optional(duration),
				firstToken: Type.Optional(duration),
				settle: duration,
			},
			closed,
		),
		transport: Type.Object(
			{
				kind: TransportKind,
				continuation: factSchema(vocabulary(["delta", "full"])),
				requestBytes: factSchema(count),
				sessionPinnedToSse: factSchema(Type.Boolean()),
				promptCacheKey: Type.Optional(ObjectRefSchema),
			},
			closed,
		),
		cache: Type.Object(
			{
				promptManifestRef: Type.Optional(ObjectRefSchema),
				firstDivergentSection: factSchema(Type.Union([text, Type.Null()])),
				expectedColdReasons: Type.Array(
					vocabulary([
						"working_set_evict",
						"compaction",
						"dispatch",
						"residency",
						"thinking_change",
						"tool_surface_change",
						"prompt_recompiled",
						"background_memory",
						"model_changed",
						"transport_reset",
					]),
				),
				rePrefilledTokens: factSchema(count),
				uncachedPrefillTokens: factSchema(count),
				verdict: vocabulary(["hot", "partial", "cold", "small", "unknown"]),
			},
			closed,
		),
		quota: Type.Optional(
			Type.Object(
				{
					provider: ExistingId,
					windows: Type.Array(
						Type.Object(
							{
								key: ExistingId,
								usedPct: factSchema(Type.Number({ minimum: 0, maximum: 100 })),
								resetsAt: Type.Optional(utc),
							},
							closed,
						),
					),
					source: vocabulary(["response-headers", "stream-event", "poll"]),
				},
				closed,
			),
		),
		responseId: Type.Optional(text),
	},
	closed,
);
export type CallSettled = Static<typeof CallSettledSchema>;

export const KIND_NAMES = [
	"call.started",
	"call.settled",
	"call.ref",
	"gap",
	"session.opened",
	"session.resumed",
	"session.forked_from",
	"session.closed",
	"segment.closed",
	"turn.settled",
	"run.settled",
	"process.started",
	"process.exited",
] as const;
export type Kind = (typeof KIND_NAMES)[number];
interface KindDefinition {
	version: number;
	schema: TSchema;
	tier: Tier;
	cc: ContentClass;
	/** Older kind versions are accepted only through explicit, version-indexed conversions (#434). */
	upcast?: Readonly<Record<number, (data: unknown) => unknown>>;
}
const accountability = <S extends TSchema>(schema: S) =>
	({ version: 1, schema, tier: "accountability", cc: "content-free" }) as const;
const empty = Type.Object({}, closed);
export const KIND_REGISTRY = {
	"call.started": accountability(CallStartedSchema),
	"call.settled": accountability(CallSettledSchema),
	"call.ref": accountability(Type.Object({ runId: ExistingId, callId: CallIdSchema }, closed)),
	gap: accountability(
		Type.Object(
			{
				sink: ExistingId,
				reason: vocabulary([
					"torn-tail",
					"writer-drop",
					"writer-error",
					"unknown-kind",
					"unknown-version",
					"invalid-record",
					"rotation",
				]),
				count: Type.Integer({ minimum: 1 }),
			},
			closed,
		),
	),
	"session.opened": accountability(empty),
	"session.resumed": accountability(empty),
	"session.forked_from": accountability(
		Type.Object({ parentSessionId: ExistingId, throughRecordId: Type.Optional(ExistingId) }, closed),
	),
	"session.closed": accountability(Type.Object({ reason: vocabulary(["completed", "cancelled", "error"]) }, closed)),
	"segment.closed": accountability(Type.Object({ reason: vocabulary(["rotation", "mode-change", "shutdown"]) }, closed)),
	"turn.settled": accountability(
		Type.Object(
			{
				stopReason: StopReason,
				terminal: Type.Object(
					{
						cause: Type.Union([FailureCause, Type.Null()]),
						stage: Type.Union([text, Type.Null()]),
						retries: count,
						callIds: Type.Array(CallIdSchema),
					},
					closed,
				),
			},
			closed,
		),
	),
	"run.settled": accountability(
		Type.Object(
			{
				terminalReason: RunTerminalReason,
				callIds: Type.Array(CallIdSchema),
				processExitCode: Type.Union([Type.Integer(), Type.Null()]),
				boundKind: Type.Optional(vocabulary(["turns", "tokens", "cost", "time", "tools"])),
				repairRounds: count,
				frameType: Type.Union([text, Type.Null()]),
			},
			closed,
		),
	),
	"process.started": accountability(empty),
	"process.exited": accountability(Type.Object({ exitCode: Type.Integer() }, closed)),
} satisfies Record<Kind, KindDefinition>;
export type Payload<K extends Kind> = Static<(typeof KIND_REGISTRY)[K]["schema"]>;
export { utc as UtcSchema };

export function isKind(kind: string): kind is Kind {
	return Object.hasOwn(KIND_REGISTRY, kind);
}

/** Schema validation plus the cross-field invariants that JSON Schema cannot express (#434). */
export function validPayload<K extends Kind>(kind: K, data: unknown): data is Payload<K> {
	if (!Value.Check(KIND_REGISTRY[kind].schema, data)) return false;
	if (kind !== "call.settled") return true;
	const call = data as CallSettled;
	if ((call.disposition === "never_sent") !== (call.usage === null)) return false;
	if (call.disposition === "never_sent" && (call.pricing.usd.kind !== "absent" || call.pricing.pricedBy !== "none"))
		return false;
	if (call.disposition === "settled" && !Object.values(call.usage ?? {}).some((fact) => fact.kind === "measured"))
		return false;
	if (call.disposition === "sent_unsettled" || call.disposition === "settled_no_usage") {
		if (Object.values(call.usage ?? {}).some((fact) => fact.kind === "measured")) return false;
	}
	return Object.values(call.stages).every((value) =>
		typeof value === "number" ? value <= call.stages.settle : value.end >= value.start && value.end <= call.stages.settle,
	);
}

export function upcastPayload(kind: Kind, version: number, data: unknown): unknown {
	const definition: KindDefinition = KIND_REGISTRY[kind];
	let current = data;
	for (let v = version; v < definition.version; v += 1) {
		const upcast = definition.upcast?.[v];
		if (!upcast) return undefined;
		current = upcast(current);
	}
	return current;
}
