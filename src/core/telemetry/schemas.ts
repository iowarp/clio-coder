import type { Static, TSchema } from "typebox";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { CaptureFlag } from "./capture.js";
import type { ContentClass, Tier } from "./enums.js";
import {
	CallLabel,
	Disposition,
	FailureCause,
	RoundKind,
	RunBoundKind,
	RunTerminalReason,
	StopReason,
	TransportKind,
	vocabulary,
} from "./enums.js";
import { factSchema } from "./fact.js";
import { AttemptIdSchema, CallIdSchema, ExistingId } from "./id-schemas.js";

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
		/** The provider's total, kept only when it exceeds the breakdown it reported (#434). */
		total: Type.Optional(factSchema(count)),
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
	// The compiled prompt and attached tool surface; wire transformations are separate facts (#434).
	objects: Type.Optional(
		Type.Object(
			{
				promptStructure: Type.Optional(ObjectRefSchema),
				toolSchemas: Type.Optional(ObjectRefSchema),
			},
			closed,
		),
	),
	callId: CallIdSchema,
	attemptId: AttemptIdSchema,
	attempt: count,
	label: CallLabel,
	target,
	roundKind: RoundKind,
	toolChoice: Type.Union([
		vocabulary(["auto", "none", "required", "unknown"]),
		Type.Object({ name: ExistingId }, closed),
	]),
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
		// Offsets from the attempt's start. TTFT is firstToken minus send.end; the legacy ledger ttftMs counts from
		// send.start and so includes Clio's request shaping (#434).
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
				settle: Type.Union([duration, Type.Null()]),
			},
			closed,
		),
		transport: Type.Object(
			{
				kind: TransportKind,
				continuation: factSchema(vocabulary(["delta", "full"])),
				requestBytes: factSchema(count),
				sessionPinnedToSse: factSchema(Type.Boolean()),
				/** Present only when the call's own connection counters were attributable to it (#434). */
				connectionReused: Type.Optional(factSchema(Type.Boolean())),
				/** WebSocket failures and SSE fallbacks inside this call, from the same attributable counters (#423). */
				websocketFailures: Type.Optional(factSchema(count)),
				sseFallbacks: Type.Optional(factSchema(count)),
				/** Why the session is pinned to SSE after this call, when it is (#423, #427). */
				pinReason: Type.Optional(vocabulary(["auth_rejection", "transport_failure", "post_stream_or_unknown_failure"])),
				recovery: Type.Optional(
					Type.Object(
						{
							action: vocabulary(["cooldown_reset", "auth_reset"]),
							outcome: vocabulary(["eligible", "recovered", "failed", "unknown"]),
						},
						closed,
					),
				),
				promptCacheKey: Type.Optional(ObjectRefSchema),
			},
			closed,
		),
		cache: Type.Object(
			{
				promptManifestRef: Type.Optional(ObjectRefSchema),
				/**
				 * Where this request first departs from the previous one on its cache key: a compiled prompt section id,
				 * "system-prompt" when no section can be named, "tools" or "messages". Null when it only extends it (#434).
				 */
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
						"input_changed",
						"tool_choice_change",
					]),
				),
				rePrefilledTokens: factSchema(count),
				uncachedPrefillTokens: factSchema(count),
				/** rePrefilledTokens priced at the input rate less the cache-read rate, fixed at settle (#434). */
				bill: Type.Optional(PricingSchema),
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

/** Aggregate snapshots describe a delegated scope, never an invented provider call (#434). */
export const RunUsageSchema = Type.Object(
	{
		source: vocabulary(["claude-sdk", "external-cli", "acp", "legacy-import"]),
		scope: vocabulary(["run", "peer-session"]),
		/** Disjoint contribution within the scope; omission denotes its whole-scope snapshot (#434). */
		partId: Type.Optional(text),
		revision: count,
		coverage: vocabulary(["complete", "partial", "unknown"]),
		pricingCoverage: vocabulary(["complete", "partial", "unknown"]),
		callCountCoverage: vocabulary(["complete", "partial", "unknown"]),
		target,
		usage: UsageSchema,
		totalTokens: factSchema(count),
		apiCalls: factSchema(count),
		missingTokenCalls: factSchema(count),
		pricing: PricingSchema,
	},
	closed,
);
export type RunUsage = Static<typeof RunUsageSchema>;

export const RUN_FEED_EVENTS = [
	"agent_start",
	"agent_end",
	"attempt_start",
	"message_end",
	"thinking",
	"route_warning",
	"clio_coder_tool_start",
	"clio_coder_tool_finish",
	"clio_coder_tool_observation",
	"clio_coder_permission_escalated",
	"clio_coder_permission_resolved",
	"clio_coder_run_outcome",
	"clio_coder_steer_received",
	"unknown",
] as const;
export const RUN_FEED_OUTCOMES = [
	"succeeded",
	"failed",
	"timed_out",
	"stalled",
	"canceled",
	"denied_by_policy",
	"spawn_failed",
	"unknown",
] as const;
const runFeedOutcome = vocabulary(RUN_FEED_OUTCOMES);
const RunFeedBodySchema = Type.Union([
	Type.Object({ kind: Type.Literal("open"), runId: ExistingId, agentId: ExistingId }, closed),
	Type.Object(
		{
			kind: Type.Literal("event"),
			type: vocabulary(RUN_FEED_EVENTS),
			tool: Type.Optional(ExistingId),
			callId: Type.Optional(ExistingId),
			outcome: Type.Optional(vocabulary(["ok", "error", "blocked"])),
			durationMs: Type.Optional(duration),
		},
		closed,
	),
	Type.Object(
		{
			kind: Type.Literal("journal_truncated"),
			reason: Type.Literal("per-run size cap"),
			droppedFromSeq: Type.Integer({ minimum: 1 }),
		},
		closed,
	),
	Type.Object(
		{
			kind: Type.Literal("receipt"),
			outcome: runFeedOutcome,
			exitCode: Type.Union([Type.Integer(), Type.Null()]),
			attemptRunId: Type.Optional(ExistingId),
		},
		closed,
	),
	Type.Object({ kind: Type.Literal("terminal"), outcome: runFeedOutcome }, closed),
]);
export type StructuralRunFeedBody = Static<typeof RunFeedBodySchema>;

export const KIND_NAMES = [
	"call.started",
	"call.settled",
	"call.ref",
	"compaction.closed",
	"gap",
	"session.opened",
	"session.resumed",
	"session.forked_from",
	"session.closed",
	"segment.closed",
	"turn.settled",
	"run.settled",
	"run.feed",
	"run.usage",
	"run.ref",
	"process.started",
	"process.exited",
	"prompt.text",
] as const;
export type Kind = (typeof KIND_NAMES)[number];
interface KindDefinition {
	version: number;
	schema: TSchema;
	tier: Tier;
	cc: ContentClass;
	/** The research flag that admits a research-tier kind; without one, research mode alone admits it (#434). */
	capture?: CaptureFlag;
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
	"compaction.closed": accountability(
		Type.Object(
			{
				callIds: Type.Array(CallIdSchema, { minItems: 1, uniqueItems: true }),
				outcome: vocabulary(["committed", "discarded", "failed", "unresolved"]),
				checkpointTurnId: Type.Union([ExistingId, Type.Null()]),
			},
			closed,
		),
	),
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
					// The segment's mode or capture flags no longer admitted a record queued before a change (#434).
					"mode-filtered",
					// The session's research capture reached its byte cap; accountability records continue (#434).
					"research-cap",
				]),
				count: Type.Integer({ minimum: 1 }),
			},
			closed,
		),
	),
	"session.opened": accountability(empty),
	"session.resumed": accountability(empty),
	"session.forked_from": accountability(
		Type.Object(
			{
				parentSessionId: ExistingId,
				parentCwdHash: ExistingId,
				parentTurnId: ExistingId,
				parentTurnAt: text,
			},
			closed,
		),
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
						// The last stage the turn's final call completed; nothing has emitted this kind before #434's P2.
						stage: Type.Union([vocabulary(["transform", "auth", "admission", "send", "firstToken"]), Type.Null()]),
						retries: count,
						/**
						 * The turn's calls settled by turn end. A call settling later stays journaled under the same ctx.turnId
						 * and counts in every total; a reader finds it as a matching turn id missing from this list (#434).
						 */
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
				/** Null when no call telemetry reached the host: unknown, never zero calls (R1, #434). */
				callIds: Type.Union([Type.Array(CallIdSchema), Type.Null()]),
				processExitCode: Type.Union([Type.Integer(), Type.Null()]),
				boundKind: Type.Optional(RunBoundKind),
				/** Only the worker's repair loop can count its rounds; the host never infers zero (#425). */
				repairRounds: factSchema(count),
				frameType: Type.Union([text, Type.Null()]),
			},
			closed,
		),
	),
	"run.feed": {
		version: 1,
		tier: "operational",
		cc: "structural",
		schema: Type.Object({ seq: Type.Integer({ minimum: 1 }), body: RunFeedBodySchema }, closed),
	},
	"run.usage": { version: 1, tier: "accountability", cc: "structural", schema: RunUsageSchema },
	"run.ref": accountability(Type.Object({ runId: ExistingId }, closed)),
	"process.started": accountability(empty),
	"process.exited": accountability(Type.Object({ exitCode: Type.Integer() }, closed)),
	/** The compiled system prompt's redacted text, linked to calls by the structure ref they carry (#434). */
	"prompt.text": {
		version: 1,
		tier: "research",
		cc: "content-bearing",
		capture: "content",
		schema: Type.Object({ structure: Type.Optional(ObjectRefSchema), text: ObjectRefSchema, bytes: count }, closed),
	},
} satisfies Record<Kind, KindDefinition>;
export type Payload<K extends Kind> = Static<(typeof KIND_REGISTRY)[K]["schema"]>;
export { utc as UtcSchema };

export function isKind(kind: string): kind is Kind {
	return Object.hasOwn(KIND_REGISTRY, kind);
}

/** Schema validation plus the cross-field invariants that JSON Schema cannot express (#434). */
export function validPayload<K extends Kind>(kind: K, data: unknown): data is Payload<K> {
	if (!Value.Check(KIND_REGISTRY[kind].schema, data)) return false;
	if (kind === "prompt.text") {
		const prompt = data as Payload<"prompt.text">;
		return (
			prompt.text.subject === "prompt-text" &&
			prompt.text.label === "resolvable" &&
			(prompt.structure === undefined || prompt.structure.subject === "prompt-structure")
		);
	}
	if (kind === "compaction.closed") {
		const outcome = data as Payload<"compaction.closed">;
		return outcome.outcome !== "committed" || outcome.checkpointTurnId !== null;
	}
	if (kind !== "call.settled") return true;
	const call = data as CallSettled;
	if ((call.disposition === "never_sent") !== (call.usage === null)) return false;
	if (call.disposition === "never_sent" && (call.pricing.usd.kind !== "absent" || call.pricing.pricedBy !== "none"))
		return false;
	if (call.disposition === "settled" && !Object.values(call.usage ?? {}).some((fact) => fact.kind === "measured"))
		return false;
	// A sent_unsettled call may carry the counts its provider reported before the response ended (#434).
	if (
		call.disposition === "settled_no_usage" &&
		Object.values(call.usage ?? {}).some((fact) => fact.kind === "measured")
	)
		return false;
	const settledAt = call.stages.settle;
	if (settledAt === null) return Object.keys(call.stages).length === 1;
	return Object.values(call.stages).every(
		(value) =>
			value !== null &&
			(typeof value === "number" ? value <= settledAt : value.end >= value.start && value.end <= settledAt),
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
