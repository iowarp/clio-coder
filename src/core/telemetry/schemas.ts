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
		subject: vocabulary([
			"prompt-structure",
			"tool-schemas",
			"config",
			"briefing",
			"steering",
			"request",
			"prompt-text",
			"memory-trace",
			"observation-trace",
		]),
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
const sha256Hex = Type.String({ pattern: "^[0-9a-f]{64}$" });
const QuotaWindowSchema = Type.Object(
	{
		key: ExistingId,
		usedPct: factSchema(Type.Number({ minimum: 0, maximum: 100 })),
		resetsAt: Type.Optional(utc),
	},
	closed,
);
const quotaSource = vocabulary(["response-headers", "stream-event", "poll"]);
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
			Type.Object({ provider: ExistingId, windows: Type.Array(QuotaWindowSchema), source: quotaSource }, closed),
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

/** Upper bounds of the inter-delta gap histogram; one more bucket counts the gaps past the last (#434). */
export const DELTA_GAP_BOUNDS_MS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192] as const;
/**
 * The response headers research capture may keep: rate-limit and quota windows, request ids and server timing.
 * Anything else, cookies and auth echoes included, never reaches the journal (#434, §12.5).
 */
export const PROVIDER_HEADER_PATTERN =
	"^(?:x-codex-(?:primary|secondary|credits)-[a-z0-9-]{1,48}|x-ratelimit-[a-z0-9-]{1,48}|anthropic-ratelimit-[a-z0-9-]{1,48}|retry-after|retry-after-ms|openai-processing-ms|openai-version|x-request-id|request-id|cf-ray)$";
const MIDDLEWARE_EFFECTS = vocabulary([
	"inject_reminder",
	"annotate_tool_result",
	"block_tool",
	"protect_path",
	"request_continuation",
	"require_tool",
	"lock_tools",
	"notify_operator",
	"rewrite_tool_input",
]);
const SYSTEM_ONE_OUTCOME = vocabulary([
	"answered",
	"failed",
	"timeout",
	"canceled",
	"overflow",
	"breaker-open",
	"unsupported",
	"flow-denied",
]);
const lagPercentiles = Type.Array(Type.Object({ p: Type.Number({ minimum: 0, maximum: 100 }), ms: duration }, closed), {
	maxItems: 64,
});

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
	"quota.reading",
	"budget.crossing",
	"budget.wait",
	"config.snapshot",
	"config.changed",
	"memory.trace",
	"memory.observation",
	"health.window",
	"health.samples",
	"tool.settled",
	"prompt.compiled",
	"context.snapshot",
	"call.timing.deltas",
	"prefix.blocks",
	"auth.event",
	"middleware.fired",
	"system_one.decision",
	"worker.channel",
	"request.capture",
	"provider.headers",
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
	// One provider's quota windows, journaled at a turn's first reading and whenever they change (#434).
	"quota.reading": {
		version: 1,
		tier: "operational",
		cc: "content-free",
		schema: Type.Object(
			{
				provider: ExistingId,
				targetId: ExistingId,
				source: quotaSource,
				/** When the provider took the reading, which can precede the record by a stream's length. */
				observedAt: utc,
				windows: Type.Array(QuotaWindowSchema, { minItems: 1 }),
				/** The provider reported that this account cannot send now. */
				limitReached: Type.Optional(Type.Boolean()),
			},
			closed,
		),
	},
	// Admission found the session's priced spend at or over a ceiling, once per ceiling; ctx names the call it held (#424).
	"budget.crossing": accountability(
		Type.Object(
			{
				level: vocabulary(["at", "over"]),
				spendUsd: duration,
				ceilingUsd: duration,
				/** Estimated input tokens of the held request, which is what each further call re-sends (#423). */
				contextTokens: Type.Optional(count),
			},
			closed,
		),
	),
	// One paid request held at the ceiling, recorded when the hold ends; ctx names the held call (#424).
	"budget.wait": accountability(
		Type.Object(
			{
				level: vocabulary(["at", "over"]),
				spendUsd: duration,
				ceilingUsd: duration,
				contextTokens: Type.Optional(count),
				/**
				 * raised: a higher ceiling released it. removed: the ceiling was cleared to none. cleared: spend fell under
				 * the ceiling it held at. refused: the caller could not wait. aborted: the request was cancelled first.
				 */
				outcome: vocabulary(["raised", "removed", "cleared", "refused", "aborted"]),
				waitedMs: duration,
				raisedToUsd: Type.Optional(duration),
				/** Who changed the ceiling, when a settings change during the wait set the one that released it. */
				raisedBy: Type.Optional(
					vocabulary(["file", "settings-ui", "cli", "session-override", "slash-command", "unattributed"]),
				),
			},
			closed,
		),
	),
	// The effective settings when a session's writer opens, so every later record reads against known settings (#434).
	"config.snapshot": {
		version: 1,
		tier: "operational",
		cc: "structural",
		schema: Type.Object({ settings: ObjectRefSchema, settingsFingerprint: sha256Hex }, closed),
	},
	// One settings change: the paths it touched by when they take effect, and both documents (#434).
	"config.changed": {
		version: 1,
		tier: "operational",
		cc: "structural",
		schema: Type.Object(
			{
				source: vocabulary(["file", "settings-ui", "cli", "session-override", "slash-command", "unattributed"]),
				paths: Type.Object(
					{
						hotReload: Type.Array(text),
						nextTurn: Type.Array(text),
						restartRequired: Type.Array(text),
					},
					closed,
				),
				before: ObjectRefSchema,
				after: ObjectRefSchema,
				/** The digest a worker spec and route decision carry for the new settings, so they resolve here. */
				settingsFingerprint: sha256Hex,
			},
			closed,
		),
	},
	/** A task-memory step's prompt and reply beside its content-free step row; replaces CLIO_CODER_MEMORY_TRACE (#434). */
	"memory.trace": {
		version: 1,
		tier: "research",
		cc: "content-bearing",
		capture: "content",
		schema: Type.Object(
			{
				decision: Type.String({ minLength: 1, maxLength: 64 }),
				reason: Type.String({ minLength: 1, maxLength: 64 }),
				bankOperations: count,
				droppedOperations: count,
				responseChars: count,
				userPromptChars: count,
				systemPromptChars: count,
				content: ObjectRefSchema,
				bytes: count,
			},
			closed,
		),
	},
	/** One memory or compaction observation event and its facts; replaces CLIO_CODER_OBSERVATION_TRACE (#434). */
	"memory.observation": {
		version: 1,
		tier: "research",
		cc: "content-bearing",
		capture: "content",
		schema: Type.Object(
			{ event: Type.String({ minLength: 1, maxLength: 64 }), content: ObjectRefSchema, bytes: count },
			closed,
		),
	},
	// One window of this process's health, written to each open session writer, so the loop-lag budget is measured
	// in the field and not only in tests (#428, #434).
	"health.window": {
		version: 1,
		tier: "operational",
		cc: "content-free",
		schema: Type.Object(
			{
				/** The span the lag samples cover; the first window after the sampler starts is shorter. */
				windowMs: duration,
				/** Event-loop delay past the sampler's resolution; absent when no sample landed in the window. */
				loopLag: Type.Optional(
					Type.Object({ samples: Type.Integer({ minimum: 1 }), p50Ms: duration, p99Ms: duration, maxMs: duration }, closed),
				),
				rssBytes: count,
				/** This session's writer: records queued now, and records it dropped since it opened. */
				writer: Type.Object({ queueDepth: count, dropped: count }, closed),
			},
			closed,
		),
	},
	/** The same window's full lag distribution and heap, which research mode keeps beside health.window (#428, #434). */
	"health.samples": {
		version: 1,
		tier: "research",
		cc: "content-free",
		schema: Type.Object(
			{
				windowMs: duration,
				/** The lag sampler's percentile curve; empty when no sample landed in the window. */
				lagPercentiles,
				/** The share of the window the event loop spent running callbacks, 0 to 1. */
				eventLoopUtilization: Type.Number({ minimum: 0, maximum: 1 }),
				heapUsedBytes: count,
				externalBytes: count,
			},
			closed,
		),
	},
	/**
	 * One tool call as the model's tool wrapper settled it; ctx names the session or run, turn, tool call and the model
	 * call that asked for it. The safety audit keeps the decision itself (#434).
	 */
	"tool.settled": {
		version: 1,
		tier: "operational",
		cc: "content-free",
		schema: Type.Object(
			{
				tool: ExistingId,
				outcome: vocabulary(["ok", "error", "blocked"]),
				/** The tool's own time on the local clock, without any wait for an operator's approval. */
				durationMs: duration,
				/** Present only when the call parked for approval. */
				parkedMs: Type.Optional(duration),
				/** UTF-8 bytes of the result text the model receives; absent when nothing ran. */
				resultBytes: Type.Optional(count),
				images: Type.Optional(Type.Integer({ minimum: 1 })),
				terminate: Type.Optional(Type.Literal(true)),
				/** Which refusal blocked it: a policy, an unapproved park, or a withheld duplicate of a succeeded call. */
				blocked: Type.Optional(vocabulary(["refused", "denied-park", "redundant-repeat"])),
			},
			closed,
		),
	},
	/**
	 * The first request of this writer to cite a compiled prompt structure; ctx names that call. The structure object
	 * holds the section ids, fragment hashes and token estimates prompt-manifest.jsonl records (#434).
	 */
	"prompt.compiled": {
		version: 1,
		tier: "operational",
		cc: "structural",
		schema: Type.Object(
			{
				structure: ObjectRefSchema,
				/** PROMPT_MANIFEST_VERSION: the prompt's layout version. */
				layoutVersion: Type.Integer({ minimum: 1 }),
				tokenEstimate: count,
				sections: count,
				thinkingLevel: Type.Optional(ExistingId),
				contextWindow: Type.Optional(count),
				contextWindowSource: Type.Optional(ExistingId),
			},
			closed,
		),
	},
	/**
	 * The persisted context snapshot's token split. ctx carries the real session and turn, and the call the snapshot was
	 * reconciled against when it was (#434).
	 */
	"context.snapshot": {
		version: 1,
		tier: "operational",
		cc: "content-free",
		schema: Type.Object(
			{
				snapshotId: ExistingId,
				categories: Type.Object(
					{
						system: count,
						tools: count,
						toolResults: Type.Optional(count),
						agents: count,
						skills: count,
						memory: count,
						project: count,
						messages: count,
						reserve: count,
						free: count,
						streaming: count,
					},
					closed,
				),
				window: Type.Object({ desired: count, effective: count, source: ExistingId }, closed),
				source: vocabulary(["estimated", "exact", "reconciled", "streaming"]),
				/** The chars/4 prompt-side total the snapshot was captured with. */
				estimatedTokens: Type.Optional(count),
				/** The provider's prompt tokens for the call it was reconciled against. */
				reconciledTokens: Type.Optional(count),
			},
			closed,
		),
	},
	/** One call's inter-delta gaps as a histogram, never a row per delta; ctx names the call (#428, #434). */
	"call.timing.deltas": {
		version: 1,
		tier: "research",
		cc: "content-free",
		capture: "deltas",
		schema: Type.Object(
			{
				deltas: Type.Integer({ minimum: 1 }),
				/** Counts per DELTA_GAP_BOUNDS_MS bucket, then the gaps past the last bound. */
				gapCounts: Type.Array(count, {
					minItems: DELTA_GAP_BOUNDS_MS.length + 1,
					maxItems: DELTA_GAP_BOUNDS_MS.length + 1,
				}),
				maxGapMs: duration,
				/** First delta to last, on the local monotonic clock. */
				spanMs: duration,
			},
			closed,
		),
	},
	/**
	 * The request's prefix as a list of block hashes, so a cache break can be placed on the block that moved. Each
	 * hash commits to text the journal does not keep (#423, #434).
	 */
	"prefix.blocks": {
		version: 1,
		tier: "research",
		cc: "structural",
		schema: Type.Object(
			{
				label: Type.Literal("commitment"),
				function: Type.Literal("sha256"),
				canonicalization: Type.Literal("utf8-text-v1"),
				blocks: Type.Array(
					Type.Object(
						{
							kind: vocabulary(["system-section", "tools", "message"]),
							/** The section id or message role; absent for the tool set. */
							id: Type.Optional(ExistingId),
							hash: sha256Hex,
							tokens: count,
						},
						closed,
					),
					{ minItems: 1, maxItems: 4096 },
				),
				/** Blocks past the cap, which the list does not name. */
				omitted: Type.Optional(Type.Integer({ minimum: 1 })),
			},
			closed,
		),
	},
	/** One OAuth credential refresh under the storage lock; no token material is ever recorded (#427). */
	"auth.event": {
		version: 1,
		tier: "operational",
		cc: "content-free",
		schema: Type.Object(
			{
				provider: ExistingId,
				/** expiry: the stored token was inside the skew margin. rejected: the provider refused the key in use. */
				trigger: vocabulary(["expiry", "rejected"]),
				/** Whether this process called the provider's refresh endpoint. */
				attempted: Type.Boolean(),
				/**
				 * refreshed: this process minted the new credential. adopted: another writer had already replaced it under
				 * the lock. failed: no usable credential came back. cancelled: the request ended first.
				 */
				outcome: vocabulary(["refreshed", "adopted", "failed", "cancelled"]),
				/** The process that wrote the credential now in use; null when another process wrote it. */
				writerPid: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
				/** The stored credential's updatedAt when this process read it, and after the refresh. */
				updatedAtBefore: Type.Optional(utc),
				updatedAtAfter: Type.Optional(utc),
				durationMs: duration,
			},
			closed,
		),
	},
	/** One middleware rule that emitted effects at a hook; ctx names the session or run, turn and tool call (#431). */
	"middleware.fired": {
		version: 1,
		tier: "operational",
		cc: "content-free",
		schema: Type.Object(
			{
				hook: vocabulary(["before_tool", "after_tool", "turn_start", "turn_end", "on_compaction"]),
				phase: vocabulary(["sync", "async", "awaited"]),
				ruleId: ExistingId,
				effects: Type.Array(MIDDLEWARE_EFFECTS, { minItems: 1, maxItems: 32 }),
				/** The strongest severity among its reminders. */
				severity: Type.Optional(vocabulary(["info", "advisory", "warn", "hard-block"])),
				/** What the rule matched, as `matcher:subject@scope`, for example `regex:PLAN_REQUEST@operator-request`. */
				evidence: Type.Optional(
					Type.String({ pattern: "^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9_.-]{1,64}(?:@[a-z][a-z0-9-]{0,31})?$" }),
				),
				tool: Type.Optional(ExistingId),
			},
			closed,
		),
	},
	/** One System One decision: what each engine answered, against which deadline, and its breaker (#429). */
	"system_one.decision": {
		version: 1,
		tier: "operational",
		cc: "content-free",
		schema: Type.Object(
			{
				site: ExistingId,
				moment: Type.Optional(ExistingId),
				outcome: SYSTEM_ONE_OUTCOME,
				latencyMs: duration,
				deadlineMs: duration,
				fitted: Type.Optional(Type.Boolean()),
				routes: Type.Array(
					Type.Object(
						{
							engine: ExistingId,
							kind: ExistingId,
							outcome: SYSTEM_ONE_OUTCOME,
							roundTripMs: Type.Optional(duration),
							/**
							 * opened: this timeout opened the cooldown. probe: the half-open probe went out. closed: an answer
							 * reset a counting breaker. disabled: a derived engine was disabled for the session.
							 */
							breaker: Type.Optional(vocabulary(["opened", "probe", "closed", "disabled"])),
						},
						closed,
					),
					{ minItems: 1, maxItems: 16 },
				),
				/** The journal calls the decision's model requests opened. */
				callIds: Type.Array(CallIdSchema, { uniqueItems: true }),
			},
			closed,
		),
	},
	/** A worker channel failure as the host saw it, in the run's journal (#425). */
	"worker.channel": {
		version: 1,
		tier: "operational",
		cc: "content-free",
		schema: Type.Object(
			{
				/** stdin carries control frames to the worker; stdout is the worker's NDJSON lane. */
				lane: vocabulary(["stdin", "stdout"]),
				/** The control frame whose write failed; null when no frame was being written. */
				frameType: Type.Union([Type.String({ pattern: "^[a-z][a-z0-9_]{0,63}$" }), Type.Null()]),
				/** The system error code, such as EPIPE; null when the failure was not a system error. */
				errno: Type.Union([Type.String({ pattern: "^E[A-Z0-9]{1,31}$" }), Type.Null()]),
				/** The worker process had already exited when the failure happened. */
				afterExit: Type.Boolean(),
				failure: vocabulary(["write-failed", "oversize-frame", "unserializable-frame", "undrained", "invalid-frame"]),
			},
			closed,
		),
	},
	/** The redacted request body a call sent, stored as a `request` object under content capture (#434, P4). */
	"request.capture": {
		version: 1,
		tier: "research",
		cc: "content-bearing",
		capture: "content",
		schema: Type.Object(
			{
				/** UTF-8 bytes of the serialized body before the cap. */
				bodyBytes: count,
				truncated: Type.Boolean(),
				content: ObjectRefSchema,
				bytes: count,
			},
			closed,
		),
	},
	/** The allowlisted headers of the call's last 2xx response (#434, §12.5). */
	"provider.headers": {
		version: 1,
		tier: "research",
		cc: "content-free",
		capture: "providerHeaders",
		schema: Type.Object(
			{
				status: Type.Integer({ minimum: 200, maximum: 299 }),
				headers: Type.Record(Type.String({ pattern: PROVIDER_HEADER_PATTERN }), Type.String({ maxLength: 256 }), {
					additionalProperties: false,
				}),
			},
			closed,
		),
	},
} satisfies Record<Kind, KindDefinition>;
/**
 * Kinds whose content the journal writer stores in `objects/` and cites as `content`, with its size as `bytes`,
 * so consent, the research cap, export, prune and GC reach it through the writer alone (#434).
 */
export const PREIMAGE_SUBJECTS = {
	"memory.trace": "memory-trace",
	"memory.observation": "observation-trace",
	"request.capture": "request",
} as const satisfies Partial<Record<Kind, ObjectRef["subject"]>>;
export type PreimageKind = keyof typeof PREIMAGE_SUBJECTS;
export type PreimageData<K extends PreimageKind> = Omit<Payload<K>, "content" | "bytes">;
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
	if (Object.hasOwn(PREIMAGE_SUBJECTS, kind)) {
		const content = (data as Payload<PreimageKind>).content;
		return content.subject === PREIMAGE_SUBJECTS[kind as PreimageKind] && content.label === "resolvable";
	}
	if (kind === "compaction.closed") {
		const outcome = data as Payload<"compaction.closed">;
		return outcome.outcome !== "committed" || outcome.checkpointTurnId !== null;
	}
	if (kind === "tool.settled") {
		const tool = data as Payload<"tool.settled">;
		return (
			(tool.outcome === "blocked") === (tool.blocked !== undefined) &&
			(tool.outcome !== "blocked" || tool.resultBytes === undefined)
		);
	}
	if (kind === "auth.event") {
		const auth = data as Payload<"auth.event">;
		if (auth.outcome === "refreshed") return auth.attempted && auth.writerPid !== null;
		return auth.outcome !== "adopted" || !auth.attempted;
	}
	if (kind === "call.timing.deltas") {
		const timing = data as Payload<"call.timing.deltas">;
		return timing.gapCounts.reduce((sum, value) => sum + value, 0) === timing.deltas - 1;
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
