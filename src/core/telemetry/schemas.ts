import type { Static } from "typebox";
import { Type } from "typebox";
import {
	CallLabel,
	ConfigChangeScope,
	ConfigChangeSource,
	Disposition,
	FailureCause,
	RoundKind,
	RunBoundKind,
	RunTerminalReason,
	StopReason,
	TransportKind,
	vocabulary,
} from "./enums.js";
import { EstimateMethod, factSchema } from "./fact.js";
import { AttemptIdSchema, CallIdSchema, ExistingId } from "./id-schemas.js";

const closed = { additionalProperties: false };
const count = Type.Integer({ minimum: 0 });
const estimatedCount = Type.Object({ kind: Type.Literal("estimated"), value: count, method: EstimateMethod }, closed);
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

/**
 * The settings digest worker specs and route decisions carry, declared as R7 asks and as the receipt hash set declares
 * it. A commitment: it confirms the settings document a config record's object reference stores, but resolves through
 * no store of its own, because that copy is canonicalized without the domain prefix this digest covers (#434).
 */
export const SettingsFingerprintSchema = Type.Object(
	{
		label: Type.Literal("commitment"),
		function: Type.Literal("sha256"),
		/** `clio-coder.settings:` followed by the sorted-key JSON of the effective settings (settings-fingerprint.ts). */
		canonicalization: Type.Literal("json-sorted-prefixed-v1"),
		subject: Type.Literal("settings"),
		hash: sha256Hex,
	},
	closed,
);
export type SettingsFingerprint = Static<typeof SettingsFingerprintSchema>;

export function settingsFingerprintCommitment(hash: string): SettingsFingerprint {
	return {
		label: "commitment",
		function: "sha256",
		canonicalization: "json-sorted-prefixed-v1",
		subject: "settings",
		hash,
	};
}

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
		/**
		 * What an interrupted call the provider never reported on is estimated to have spent: the prompt side from the
		 * turn's context accounting and the output from the text that arrived. A transcript shows it; no fold sums it,
		 * so the usage above stays the measured lower bound (#423, #430, #434).
		 */
		interruptedEstimate: Type.Optional(Type.Object({ input: estimatedCount, output: estimatedCount }, closed)),
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
export const RunFeedBodySchema = Type.Union([
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
export const MIDDLEWARE_EFFECTS = vocabulary([
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
export const SYSTEM_ONE_OUTCOME = vocabulary([
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

/**
 * session.opened and session.resumed are written when the session itself opens or resumes, beside meta.json's
 * reopen, and never when a writer reopens after an idle close: the read model reads either one newer than a ledger
 * close as the session reopening (#434 §6.1).
 */
export const EmptySchema = Type.Object({}, closed);
/** One context reduction: which stage ran, the tokens it moved, and what it removed (#434). */
export const ContextPrunedSchema = Type.Object(
	{
		stage: vocabulary(["mask_observations", "working_set", "llm_summary"]),
		tokensBefore: count,
		tokensAfter: count,
		trigger: vocabulary(["auto", "force", "overflow"]),
		snapshotIdBefore: Type.Union([ExistingId, Type.Null()]),
		snapshotIdAfter: ExistingId,
		at: duration,
		/** Used/window ratio at trigger time; working-set and legacy-mask stages only. */
		pressure: Type.Optional(Type.Union([Type.Number({ minimum: 0 }), Type.Null()])),
		/** Legacy destructive-mask count. */
		maskedObservations: Type.Optional(count),
		/** Thinking blocks stripped from stale assistant messages; legacy mask only. */
		maskedThinkingBlocks: Type.Optional(count),
		maskedThinkingChars: Type.Optional(count),
		/** Working-set policy that selected an applied eviction event. */
		policyId: Type.Optional(ExistingId),
		/** Number of working-set units evicted by the event. */
		evictedItems: Type.Optional(count),
	},
	closed,
);
/** One working-set unit readmitted to context, by its unit ref (#434). */
export const ContextRecalledSchema = Type.Object(
	{
		ref: ExistingId,
		trigger: vocabulary(["tool", "operator", "reread"]),
		tokensReadmitted: count,
		at: duration,
	},
	closed,
);
export const DomainLoadedSchema = Type.Object({ name: ExistingId }, closed);
/** One user or extension hook execution, under the session, run and turn it ran for (#434). */
export const HookRanSchema = Type.Object(
	{
		hookId: ExistingId,
		origin: vocabulary(["extension", "user", "project", "project.local"]),
		sourcePath: text,
		hash: ExistingId,
		hook: vocabulary(["before_tool", "after_tool", "turn_start", "turn_end", "on_compaction", "prompt_submit"]),
		kind: vocabulary(["command", "prompt", "effect", "runtime"]),
		outcome: vocabulary([
			"emitted",
			"command-ok",
			"command-failed",
			"command-timeout",
			"skipped",
			"runtime-ok",
			"runtime-failed",
			"runtime-timeout",
		]),
		effectKinds: Type.Optional(Type.Array(ExistingId, { maxItems: 32 })),
		durationMs: Type.Optional(duration),
		exitCode: Type.Optional(Type.Integer()),
		outputChars: Type.Optional(count),
		tool: Type.Optional(ExistingId),
		extension: Type.Optional(
			Type.Object(
				{
					id: ExistingId,
					version: Type.Optional(ExistingId),
					scope: ExistingId,
					contentDigest: ExistingId,
					generation: count,
				},
				closed,
			),
		),
	},
	closed,
);
/** One Library lifecycle operation on a package: what changed, at which digests, and who confirmed it (#434). */
export const LibraryLifecycleSchema = Type.Object(
	{
		operationId: ExistingId,
		kind: ExistingId,
		id: ExistingId,
		version: Type.Union([ExistingId, Type.Null()]),
		contentDigest: Type.Union([ExistingId, Type.Null()]),
		envelopeDigest: Type.Union([ExistingId, Type.Null()]),
		scope: ExistingId,
		source: text,
		actor: vocabulary(["operator", "model-confirmed", "upgrade"]),
	},
	closed,
);
export const DomainFailedSchema = Type.Object({ name: ExistingId }, closed);
/** A settings reload the watcher rejected, keeping the last good settings, or the reload that ended the rejection. */
export const ConfigReloadFailedSchema = Type.Object({ state: vocabulary(["rejected", "recovered"]) }, closed);
/** The route's context-window warning starting or ending; its text stays on the live notice (#434). */
export const ContextWarningRaisedSchema = Type.Object({ state: vocabulary(["raised", "cleared"]) }, closed);
/** A middleware hook that threw, overran its budget, or lost its id to another registration (#434). */
export const MiddlewareHookFailedSchema = Type.Object(
	{
		kind: vocabulary(["hook_failed", "budget_exceeded", "registration_conflict"]),
		registrationId: ExistingId,
		hook: vocabulary(["before_tool", "after_tool", "turn_start", "turn_end", "on_compaction"]),
		elapsedMs: Type.Optional(duration),
		budgetMs: Type.Optional(duration),
		steadyStateWarn: Type.Optional(Type.Boolean()),
		p50Ms: Type.Optional(duration),
		p95Ms: Type.Optional(duration),
		overCount: Type.Optional(count),
		windowSamples: Type.Optional(count),
	},
	closed,
);
/** A plugin resource reload: the generation it committed and the snapshot's content identity (#434). */
export const PluginReloadedSchema = Type.Object(
	{ generation: count, previousGeneration: count, changed: Type.Boolean(), digest: ExistingId },
	closed,
);
export const ShutdownRequestedSchema = Type.Object(
	{ phase: vocabulary(["idle", "draining", "terminating", "persisting", "exiting"]) },
	closed,
);

export const CallLinkedSchema = Type.Object({ runId: ExistingId, callId: CallIdSchema }, closed);
export const CompactionSettledSchema = Type.Object(
	{
		callIds: Type.Array(CallIdSchema, { minItems: 1, uniqueItems: true }),
		outcome: vocabulary(["committed", "discarded", "failed", "unresolved"]),
		checkpointTurnId: Type.Union([ExistingId, Type.Null()]),
	},
	closed,
);
export const JournalGapSchema = Type.Object(
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
);
export const SessionForkedSchema = Type.Object(
	{
		parentSessionId: ExistingId,
		parentCwdHash: ExistingId,
		parentTurnId: ExistingId,
		parentTurnAt: text,
	},
	closed,
);
/** Why the session stopped being current: the park reason, or `shutdown` when the process ended with it open (#434). */
export const SessionCloseReason = vocabulary([
	"create_new",
	"resume_other",
	"fork",
	"switch_branch",
	"close",
	"shutdown",
]);
export const SessionClosedSchema = Type.Object({ reason: SessionCloseReason }, closed);
export const SessionResumedSchema = Type.Object({ via: vocabulary(["resume", "switch_branch"]) }, closed);
export const JournalSegmentClosedSchema = Type.Object(
	{ reason: vocabulary(["rotation", "mode-change", "shutdown"]) },
	closed,
);
export const TurnSettledSchema = Type.Object(
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
);
export const RunSettledSchema = Type.Object(
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
);
export const RunFeedAppendedSchema = Type.Object(
	{ seq: Type.Integer({ minimum: 1 }), body: RunFeedBodySchema },
	closed,
);
export const RunLinkedSchema = Type.Object({ runId: ExistingId }, closed);
export const ProcessExitedSchema = Type.Object({ exitCode: Type.Integer() }, closed);
/** The compiled system prompt's redacted text, linked to calls by the structure ref they carry (#434). */
export const PromptTextCapturedSchema = Type.Object(
	{ structure: Type.Optional(ObjectRefSchema), text: ObjectRefSchema, bytes: count },
	closed,
);
// One provider's quota windows, journaled at a turn's first reading and whenever they change (#434).
export const QuotaReadSchema = Type.Object(
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
);
// Admission found the session's priced spend at or over a ceiling, once per ceiling; ctx names the call it held (#424).
export const BudgetCrossedSchema = Type.Object(
	{
		level: vocabulary(["at", "over"]),
		spendUsd: duration,
		ceilingUsd: duration,
		/** Estimated input tokens of the held request, which is what each further call re-sends (#423). */
		contextTokens: Type.Optional(count),
	},
	closed,
);
// One paid request held at the ceiling, recorded when the hold ends; ctx names the held call (#424).
export const BudgetHeldSchema = Type.Object(
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
		raisedBy: Type.Optional(ConfigChangeSource),
	},
	closed,
);
// The effective settings when a session's writer opens, so every later record reads against known settings (#434).
export const ConfigSnapshottedSchema = Type.Object(
	{ settings: ObjectRefSchema, settingsFingerprint: SettingsFingerprintSchema },
	closed,
);
// One settings change: the paths it touched by when they take effect, and both documents (#434).
export const ConfigChangedSchema = Type.Object(
	{
		source: ConfigChangeSource,
		/** The layer the change landed in; absent for a file reload, which cannot tell which file changed. */
		scope: Type.Optional(ConfigChangeScope),
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
		settingsFingerprint: SettingsFingerprintSchema,
	},
	closed,
);
/** A task-memory step's prompt and reply in a consented research object (#434). */
export const MemoryTracedSchema = Type.Object(
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
);
/** One memory or compaction observation event and its facts in a consented research object (#434). */
export const MemoryObservedSchema = Type.Object(
	{ event: Type.String({ minLength: 1, maxLength: 64 }), content: ObjectRefSchema, bytes: count },
	closed,
);
// One window of this process's health, written to each open session writer, so the loop-lag budget is measured
// in the field and not only in tests (#428, #434).
export const HealthSampledSchema = Type.Object(
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
);
/** The same window's full lag distribution and heap, which research mode keeps beside health.sampled (#428, #434). */
export const HealthSamplesCapturedSchema = Type.Object(
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
);
/**
 * One tool call as the model's tool wrapper settled it; ctx names the session or run, turn, tool call and the model
 * call that asked for it. The safety audit keeps the decision itself (#434).
 */
export const ToolSettledSchema = Type.Object(
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
);
/**
 * One safety decision about a tool call, from classification to the final autonomy or budget disposition. A
 * `classified` record is a net pass that a later axis still decides; the command, arguments and policy prose stay
 * out of the journal (#434).
 */
export const ToolDecidedSchema = Type.Object(
	{
		tool: ExistingId,
		actionClass: ExistingId,
		decision: vocabulary(["allowed", "blocked", "permission_requested", "classified", "denied"]),
		exposure: Type.Optional(Type.Literal("outward")),
		posture: Type.Optional(ExistingId),
		requestId: Type.Optional(ExistingId),
		ruleId: Type.Optional(ExistingId),
		reasonCode: Type.Optional(ExistingId),
		policySource: Type.Optional(ExistingId),
		policyHash: Type.Optional(ExistingId),
	},
	closed,
);
/** A parked call's approval ask. The card's summary, target, consequence and rejection text are live only (#434). */
export const ApprovalRequestedSchema = Type.Object(
	{
		tool: ExistingId,
		actionClass: ExistingId,
		requestId: Type.Optional(ExistingId),
		origin: Type.Optional(ExistingId),
		/** The worker run that asked; absent for a main-session ask. */
		requestedBy: Type.Optional(ExistingId),
		agentId: Type.Optional(ExistingId),
		axis: Type.Optional(ExistingId),
		posture: Type.Optional(ExistingId),
		ruleId: Type.Optional(ExistingId),
		reasonCode: Type.Optional(ExistingId),
		policySource: Type.Optional(ExistingId),
		timeoutMs: Type.Optional(duration),
		fallback: Type.Optional(vocabulary(["deny", "fail"])),
		escalation: Type.Optional(Type.Boolean()),
		approvalAuthority: Type.Optional(vocabulary(["main", "operator"])),
		forwardedByMain: Type.Optional(Type.Boolean()),
	},
	closed,
);
export const ApprovalResolvedSchema = Type.Object(
	{
		status: vocabulary(["granted", "denied", "expired"]),
		requestId: Type.Optional(ExistingId),
		origin: Type.Optional(ExistingId),
		decidedBy: Type.Optional(ExistingId),
		tool: Type.Optional(ExistingId),
		actionClass: Type.Optional(ExistingId),
		requestedBy: Type.Optional(ExistingId),
		fallback: Type.Optional(vocabulary(["deny", "fail"])),
		grant: Type.Optional(
			Type.Object(
				{
					attempt: count,
					authority: vocabulary(["main", "operator"]),
					issuer: Type.Optional(vocabulary(["main", "operator"])),
					execution: vocabulary(["not_executed", "executing", "executed", "unknown"]),
					state: ExistingId,
				},
				closed,
			),
		),
	},
	closed,
);
/** A dispatch run cancelled or drained. `runId` names the target, which a queued run's own journal may not hold. */
export const RunAbortedSchema = Type.Object(
	{
		source: vocabulary(["dispatch_abort", "dispatch_drain"]),
		runId: ExistingId,
		startedAt: Type.Union([Type.String({ maxLength: 64 }), Type.Null()]),
		elapsedMs: Type.Union([duration, Type.Null()]),
	},
	closed,
);
/** A main turn's stream stopped by the operator or by the loop guard; no dispatch run is involved (#434). */
export const TurnAbortedSchema = Type.Object({ source: vocabulary(["stream_cancel", "loop_guard"]) }, closed);
export const StatusPhase = vocabulary([
	"idle",
	"preparing",
	"waiting_model",
	"thinking",
	"writing",
	"tool_running",
	"tool_blocked",
	"retrying",
	"compacting",
	"dispatching",
	"stuck",
	"ended",
]);
export const AgentStatusChangedSchema = Type.Object(
	{
		phase: StatusPhase,
		prevPhase: StatusPhase,
		elapsedFromStart: duration,
		watchdogTier: Type.Integer({ minimum: 0, maximum: 4 }),
		toolName: Type.Optional(ExistingId),
		attempt: Type.Optional(count),
		agentName: Type.Optional(ExistingId),
		stopReason: Type.Optional(ExistingId),
	},
	closed,
);
/** The finish contract's decision at turn end. Paths and finding prose are counted, never copied (#434). */
export const CompletionEvaluatedSchema = Type.Object(
	{
		decision: vocabulary(["ok", "engage"]),
		reason: vocabulary([
			"no_mutation",
			"no_net_mutation",
			"deletion_only",
			"prose_only",
			"validation_evidence",
			"explicit_limitation",
			"unvalidated_mutation",
		]),
		rigor: vocabulary(["normal", "high"]),
		mutatedPaths: count,
		evidenceKinds: Type.Array(ExistingId),
		quality: Type.Optional(
			Type.Array(
				Type.Object(
					{
						rule: ExistingId,
						check: ExistingId,
						state: vocabulary(["passed", "failed", "stale", "missing", "limited", "unavailable"]),
					},
					closed,
				),
			),
		),
		/** The checks the decision counted as passed and the operator's acceptance per check; limitations stay out. */
		verification: Type.Optional(
			Type.Object(
				{
					passedChecks: Type.Array(ExistingId),
					acceptance: Type.Array(
						Type.Object({ check: ExistingId, state: vocabulary(["passed", "limited", "unverified"]) }, closed),
					),
				},
				closed,
			),
		),
	},
	closed,
);
/** The safety judge's review of a call that would have parked; its reason and detail prose stay out (#434). */
export const SafetyJudgedSchema = Type.Object(
	{
		tool: ExistingId,
		actionClass: ExistingId,
		verdict: vocabulary(["allow", "block", "none", "escalated"]),
		latencyMs: duration,
		workerRunId: Type.Optional(ExistingId),
		askRule: Type.Optional(ExistingId),
		rule: Type.Optional(ExistingId),
		target: Type.Optional(ExistingId),
		model: Type.Optional(ExistingId),
		noVerdict: Type.Optional(ExistingId),
		operatorMessages: Type.Optional(count),
	},
	closed,
);
/**
 * The first request of this writer to cite a compiled prompt structure; ctx names that call. The structure object
 * holds the compile metadata, preload accounting, section ids and fragment hashes (#434).
 */
export const PromptCompiledSchema = Type.Object(
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
);
/**
 * The persisted context snapshot's token split. ctx carries the real session and turn, and the call the snapshot was
 * reconciled against when it was (#434).
 */
export const ContextSnapshottedSchema = Type.Object(
	{
		snapshotId: ExistingId,
		providerId: Type.Union([ExistingId, Type.Null()]),
		runtimeId: Type.Union([ExistingId, Type.Null()]),
		modelId: Type.Union([ExistingId, Type.Null()]),
		promptSegments: Type.Optional(Type.Array(Type.Object({ id: ExistingId, tokenEstimate: count }, closed))),
		splits: Type.Record(Type.String(), vocabulary(["estimated", "exact", "reconciled"])),
		promptHash: Type.Optional(sha256Hex),
		toolSignature: Type.Optional(Type.String()),
		messageRange: Type.Optional(Type.Object({ start: count, end: count }, closed)),
		divergenceRatio: Type.Optional(Type.Number({ minimum: 0 })),
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
);
/** One call's inter-delta gaps as a histogram, never a row per delta; ctx names the call (#428, #434). */
export const CallTimingCapturedSchema = Type.Object(
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
);
/**
 * The request's prefix as a list of block hashes, so a cache break can be placed on the block that moved. Each
 * hash commits to text the journal does not keep (#423, #434).
 */
export const PromptPrefixCapturedSchema = Type.Object(
	{
		label: Type.Literal("commitment"),
		function: Type.Literal("sha256"),
		/** A system section hashes its trimmed UTF-8 text; the tool set and each message hash their JSON. */
		canonicalization: Type.Literal("clio-prefix-v1"),
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
);
/** One OAuth credential refresh under the storage lock; no token material is ever recorded (#427). */
export const AuthRefreshedSchema = Type.Object(
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
);
/** One middleware rule that emitted effects at a hook; ctx names the session or run, turn and tool call (#431). */
export const MiddlewareFiredSchema = Type.Object(
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
);
/** One System One decision: what each engine answered, against which deadline, and its breaker (#429). */
export const SystemOneDecidedSchema = Type.Object(
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
);
/** A worker channel failure as the host saw it, in the run's journal (#425). */
export const WorkerChannelFailedSchema = Type.Object(
	{
		/** stdin carries control frames to the worker; stdout is the worker's NDJSON lane. */
		lane: vocabulary(["stdin", "stdout"]),
		/** The control frame whose write failed; null when no frame was being written. */
		frameType: Type.Union([Type.String({ pattern: "^[a-z][a-z0-9_]{0,63}$" }), Type.Null()]),
		/** The system error code, such as EPIPE; null when the failure was not a system error. */
		errno: Type.Union([Type.String({ pattern: "^E[A-Z0-9]{1,31}$" }), Type.Null()]),
		/** The worker process had already exited when the failure happened. */
		afterExit: Type.Boolean(),
		failure: vocabulary([
			"write-failed",
			"oversize-frame",
			"unserializable-frame",
			"backlog-full",
			"undrained",
			"invalid-frame",
		]),
	},
	closed,
);
/** The redacted request body a call sent, stored as a `request` object under content capture (#434, P4). */
export const RequestCapturedSchema = Type.Object(
	{
		/** UTF-8 bytes of the serialized body before the cap. */
		bodyBytes: count,
		truncated: Type.Boolean(),
		content: ObjectRefSchema,
		bytes: count,
	},
	closed,
);
/** The allowlisted headers of the call's last 2xx response (#434, §12.5). */
export const ProviderHeadersCapturedSchema = Type.Object(
	{
		status: Type.Integer({ minimum: 200, maximum: 299 }),
		headers: Type.Record(Type.String({ pattern: PROVIDER_HEADER_PATTERN }), Type.String({ maxLength: 256 }), {
			additionalProperties: false,
		}),
	},
	closed,
);
export { utc as UtcSchema };

/**
 * Closed routing vocabularies (#434). The dispatch domain maps its decision onto them, and a code or filter it does
 * not know reads as `unknown`, so a renamed reason surfaces instead of passing as free text.
 */
export const ROUTE_HARD_FILTERS = [
	"manual-pins",
	"approved-envelope",
	"audience",
	"authority",
	"required-tools",
	"required-skills",
	"result-contract",
	"response-schema-support",
	"locality",
	"authentication",
	"network-policy",
	"endpoint-reachability",
	"model-context",
	"resource-fit",
	"capacity-lease-availability",
	"budget",
	"deadline",
	"cooldown",
	"routing-intent",
	"fixed-executed-route",
	"unknown",
] as const;
export const ROUTE_REASONS = [
	"hard-filter-rejected",
	"active-readiness-excluded",
	"posture-floor-excluded",
	"posture-floors-unsatisfiable",
	"manual-posture-exact-route",
	"no-admissible-candidate",
	"executed-route-not-admissible",
	"shadow-advisory-only",
	"shadow-differs-from-executed",
	"observer-failure-fixed-route",
	"unknown",
] as const;
export const EXECUTION_ROLE_VOCABULARY = [
	"builder",
	"reviewer",
	"judge",
	"researcher",
	"verifier",
	"recovery",
] as const;
const routeTuple = Type.Object(
	{
		agentId: ExistingId,
		executionRole: vocabulary(EXECUTION_ROLE_VOCABULARY),
		targetId: ExistingId,
		modelId: ExistingId,
		runtimeId: ExistingId,
		nodeId: ExistingId,
	},
	closed,
);
const finiteOrNull = Type.Union([Type.Number(), Type.Null()]);
/**
 * One routing decision, in the journal of the session or run that asked (#434). Candidates, verdicts and reasons
 * are the decision's own; prompts, specs and settings appear only through the decision hash.
 */
export const RouteDecidedSchema = Type.Object(
	{
		policyVersion: ExistingId,
		mode: vocabulary(["fixed", "shadow", "active"]),
		posture: vocabulary(["manual", "quality", "balanced", "latency", "economy"]),
		decisionHash: ExistingId,
		decisionDurationMs: duration,
		confidence: finiteOrNull,
		selected: routeTuple,
		executed: routeTuple,
		fallbacks: Type.Array(routeTuple),
		recommendedAgentId: ExistingId,
		candidates: Type.Array(
			Type.Object(
				{
					route: routeTuple,
					rejection: Type.Union([vocabulary(ROUTE_HARD_FILTERS), Type.Null()]),
					/** Null for a rejected candidate, which is never scored. */
					score: finiteOrNull,
					dominated: Type.Boolean(),
					samples: count,
					ready: Type.Boolean(),
				},
				closed,
			),
		),
		reasons: Type.Array(Type.Object({ code: vocabulary(ROUTE_REASONS), count: Type.Optional(count) }, closed)),
		/** Whether the policy would have run another route, and whether the route that ran passed every hard filter. */
		verdict: Type.Object({ differs: Type.Boolean(), executedAdmissible: Type.Boolean() }, closed),
	},
	closed,
);
const sha256OrNull = Type.Union([sha256Hex, Type.Null()]);
const gateSubject = Type.Object({ runId: ExistingId, digest: sha256OrNull }, closed);
/** A decided review or compete gate, in the journal of the run the gate's group belongs to (#434). */
export const GateDecidedSchema = Type.Object(
	{
		decisionId: ExistingId,
		group: ExistingId,
		topology: vocabulary(["review", "compete"]),
		cycle: count,
		outcome: vocabulary([
			"pass",
			"fail",
			"revise",
			"exhausted",
			"winner",
			"no-winner",
			"operator-confirmed",
			"yolo-applied",
		]),
		subjects: Type.Array(gateSubject),
		decider: Type.Optional(gateSubject),
		winner: Type.Optional(Type.Object({ index: count, runId: ExistingId }, closed)),
		confirms: Type.Optional(ExistingId),
		digest: sha256Hex,
	},
	closed,
);
/** A settled deterministic code step of a fleet run; its output stays in the step's artifact log (#434). */
export const CodeStepSettledSchema = Type.Object(
	{
		runId: ExistingId,
		stepId: ExistingId,
		commandId: ExistingId,
		startedAt: utc,
		durationMs: duration,
		timeoutMs: duration,
		exitCode: Type.Integer(),
		signal: Type.Union([Type.String({ maxLength: 32 }), Type.Null()]),
		timedOut: Type.Boolean(),
		commands: Type.Array(Type.Object({ exitCode: Type.Integer(), durationMs: duration }, closed)),
		outputBytes: count,
		outputTruncated: Type.Boolean(),
		outputDigest: sha256Hex,
		reportDigest: sha256Hex,
	},
	closed,
);
const runtimeKind = vocabulary(["http", "sdk", "subprocess", "acp-delegation"]);
/**
 * A run admitted to dispatch. It lands in the run's journal when the run already has one (a retry or fleet step at
 * spawn), else in the asker's, which is why it names its run (#434).
 */
export const RunEnqueuedSchema = Type.Object(
	{
		runId: ExistingId,
		agentId: ExistingId,
		requestOrigin: Type.Union([vocabulary(["user", "agent", "internal", "harness"]), Type.Null()]),
		targetId: ExistingId,
		wireModelId: ExistingId,
		runtimeId: ExistingId,
		runtimeKind,
		node: Type.Optional(ExistingId),
		endpointLimit: Type.Optional(count),
		gate: Type.Optional(Type.Object({ role: ExistingId, cycle: count }, closed)),
		rerouteCount: Type.Optional(count),
	},
	closed,
);
/** A run's worker is live; the run's journal holds it, so the envelope names the run (#434). */
export const RunStartedSchema = Type.Object(
	{
		pid: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
		assignmentId: ExistingId,
		attempt: count,
	},
	closed,
);

// Memory outcomes are structural; raw prompts and replies use the research object events (#434).
const memoryClassDelta = Type.Object({ added: count, updated: count, deleted: count }, closed);
const memoryRoute = Type.Object({ targetId: ExistingId, modelId: ExistingId }, closed);
export const MemoryStepDecidedSchema = Type.Object(
	{
		triggerReasons: Type.Array(
			vocabulary([
				"interval",
				"tool_error_streak",
				"loop_signal",
				"repeated_failure",
				"durable_lesson",
				"durable_lesson_variant",
				"durable_lesson_verify",
				"durable_lesson_subject",
				"turn_end",
				"post_compaction",
				"idle_review",
				"manual",
			]),
			{ minItems: 1, uniqueItems: true },
		),
		tier: vocabulary(["rules", "llm"]),
		bankDelta: Type.Object(
			{ status: memoryClassDelta, knowledge: memoryClassDelta, procedural: memoryClassDelta },
			closed,
		),
		decision: vocabulary(["silent", "injected", "gated", "timeout", "malformed", "dropped"]),
		reason: vocabulary([
			"intervened",
			"model_silent",
			"duplicate_reminder",
			"suppressed",
			"uncited",
			"invalid_path",
			"resolved_failure",
			"no_lost_context",
			"over_budget",
			"invalid_reminder",
			"unparseable",
			"all_operations_invalid",
			"deadline",
			"timed_out",
			"endpoint_busy",
			"endpoint_preempted",
			"cost_ceiling",
			"quota_unknown",
			"quota_window",
			"quota_retry",
			"time_budget",
			"client_error",
			"information_flow_blocked",
			"no_client",
			"no_consumer",
			"step_in_flight",
			"llm_timeout_backoff",
			"no_repeated_failure",
			"bank_empty",
			"scope_changed",
		]),
		bankOperations: count,
		droppedOperations: count,
		citedEntries: count,
		inputTokens: factSchema(count),
		outputTokens: factSchema(count),
		latencyMs: factSchema(duration),
		missingTokenCalls: Type.Optional(count),
		calls: Type.Optional(Type.Array(Type.Object({ callId: CallIdSchema, attemptId: AttemptIdSchema }, closed))),
		route: Type.Optional(memoryRoute),
		resumeAt: Type.Optional(utc),
	},
	closed,
);
export const MemoryStepCompletedSchema = Type.Object({ endpointKey: text, targetId: ExistingId }, closed);
export const MemoryGuardianChangedSchema = Type.Object(
	{ state: vocabulary(["off", "idle", "reviewing", "waiting-capacity", "unavailable"]) },
	closed,
);
export const MemoryObservationRecordedSchema = Type.Object(
	{
		event: vocabulary([
			"artifacts-retired",
			"batch-ready",
			"checkpoint-committed",
			"consumption-recovered",
			"durable-lessons-held",
			"durable-lessons-submitted",
			"history-candidates-replayed",
			"history-lessons-filed",
			"invalidated",
			"lesson-approved",
			"lesson-candidates-rejected",
			"lesson-candidates-restored",
			"lesson-candidates-revalidated",
			"lesson-demoted",
			"lesson-extraction-abstained",
			"lesson-extraction-completed",
			"lesson-extraction-deferred",
			"lesson-extraction-settled",
			"lesson-extraction-skipped",
			"lesson-extraction-started",
			"lesson-judgment",
			"lesson-judgment-gated",
			"lesson-retention-deferred",
			"lesson-retention-orphan",
			"lesson-retention-restored",
			"lessons-retained",
			"memory-recall-results",
			"memory-reminders-submitted",
			"memory-section-submitted",
			"notes-rejected",
			"offer-declined",
			"offer-used",
			"preparation-failed",
			"preparation-settled",
			"reflection-ready",
			"reminder-entries-submitted",
			"reminder-outcomes",
			"restoration-delivered",
		]),
		facts: Type.Object(
			{
				count: Type.Optional(count),
				grounded: Type.Optional(count),
				ungrounded: Type.Optional(count),
				rejected: Type.Optional(count),
				offered: Type.Optional(count),
				offerable: Type.Optional(count),
				units: Type.Optional(count),
				incompleteUnits: Type.Optional(count),
				attempts: Type.Optional(count),
				timeoutMs: Type.Optional(count),
				operations: Type.Optional(count),
				dropped: Type.Optional(count),
				extracted: Type.Optional(count),
				candidates: Type.Optional(count),
				accepted: Type.Optional(count),
				entries: Type.Optional(count),
				splitEntries: Type.Optional(count),
				revision: Type.Optional(Type.Union([text, Type.Null()])),
				priorObservationRevision: Type.Optional(Type.Union([text, Type.Null()])),
				batchId: Type.Optional(Type.Union([text, Type.Null()])),
				digest: Type.Optional(Type.Union([text, Type.Null()])),
				sourceDigest: Type.Optional(Type.Union([text, Type.Null()])),
				sourceSessionId: Type.Optional(Type.Union([text, Type.Null()])),
				commitId: Type.Optional(Type.Union([text, Type.Null()])),
				reason: Type.Optional(Type.Union([text, Type.Null()])),
				phase: Type.Optional(Type.Union([text, Type.Null()])),
				id: Type.Optional(Type.Union([text, Type.Null()])),
				by: Type.Optional(Type.Union([text, Type.Null()])),
				filing: Type.Optional(Type.Union([text, Type.Null()])),
				final: Type.Optional(Type.Boolean()),
				answered: Type.Optional(Type.Boolean()),
				unavailable: Type.Optional(Type.Boolean()),
				split: Type.Optional(Type.Boolean()),
				ids: Type.Optional(Type.Array(ExistingId)),
				retainedIds: Type.Optional(Type.Array(ExistingId)),

				sourceTokens: Type.Optional(factSchema(count)),
				noteTokens: Type.Optional(factSchema(count)),
				originalInputTokens: Type.Optional(factSchema(count)),
				substitutedInputTokens: Type.Optional(factSchema(count)),
				proposed: Type.Optional(factSchema(count)),
				raw: Type.Optional(factSchema(count)),
				window: Type.Optional(count),
				durationMs: Type.Optional(factSchema(duration)),
				route: Type.Optional(Type.Union([memoryRoute, Type.Null()])),
				outcomes: Type.Optional(
					Type.Array(
						Type.Object({ kind: vocabulary(["held", "contradicted", "unresolved"]), ids: Type.Array(ExistingId) }, closed),
					),
				),
				offerId: Type.Optional(ExistingId),
				batchIds: Type.Optional(Type.Array(ExistingId)),
				inputIds: Type.Optional(Type.Array(ExistingId)),
				offerIds: Type.Optional(Type.Array(ExistingId)),
				decision: Type.Optional(vocabulary(["silent", "injected", "gated", "timeout", "malformed"])),
				proven: Type.Optional(Type.Array(vocabulary(["trap_fix", "read_run"]))),
				usage: Type.Optional(UsageSchema),
				call: Type.Optional(Type.Object({ callId: CallIdSchema, attemptId: AttemptIdSchema }, closed)),
			},
			closed,
		),
	},
	closed,
);
export type MemoryObservationRecorded = Static<typeof MemoryObservationRecordedSchema>;
