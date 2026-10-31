import type { Static, TSchema } from "typebox";
import { Type } from "typebox";
import {
	ConfigChangeScope,
	ConfigChangeSource,
	Disposition,
	FailureCause,
	RoundKind,
	RunBoundKind,
	RunOutcome,
	RunOutcomeCode,
	RunTerminalReason,
	StopReason,
	TransportKind,
	vocabulary,
} from "./enums.js";
import { EstimateMethod, factSchema } from "./fact.js";
import { AttemptIdSchema, CallIdSchema, ExistingId } from "./id-schemas.js";
import { RUN_HASH_CANONICALIZATIONS, RUN_HASH_SUBJECTS } from "./run-vocabulary.js";
import {
	EVIDENCE_TAGS,
	TRUST_ABSENCE_REASONS,
	TRUST_ARTIFACT_KINDS,
	TRUST_STATUS_AUTHORITY_KINDS,
	TRUST_STATUS_SOURCE_KINDS,
	TRUST_STATUS_STATES,
} from "./trust-vocabulary.js";

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
			"system-one-sample",
			"run-result",
			"evidence-findings",
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
		label: Type.Optional(text),
		scope: Type.Optional(text),
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
		source: vocabulary(["claude-sdk", "external-cli", "acp"]),
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
		sourceId: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
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
		sourceId: Type.String({ pattern: "^sha256:[0-9a-f]{64}$" }),
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
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
/** Diagnostic text a finished run states about itself, clipped and redacted where it is built (#434). */
const diagnostic = Type.String({ maxLength: 1024 });
const digest = Type.String({ minLength: 1, maxLength: 256 });
/** One R7-labelled hash a finished run carries, named by the field it was computed for (`receipt-hashes.ts`, #434). */
export const RunHashSchema = Type.Object(
	{
		field: Type.String({ minLength: 1, maxLength: 256 }),
		label: vocabulary(["commitment", "resolvable"]),
		function: Type.Literal("sha256"),
		canonicalization: vocabulary(RUN_HASH_CANONICALIZATIONS),
		subject: vocabulary(RUN_HASH_SUBJECTS),
		store: Type.Optional(vocabulary(["run-receipts", "context-seeds"])),
		hash: digest,
	},
	closed,
);
export type RunHash = Static<typeof RunHashSchema>;
/**
 * A finished run's one persisted record (#434). Version 1. What the run delivered (its output, failure text, worktree
 * and check commands) is content, kept in the run scope's `run-result` object that `result` names, so the seal covers
 * it and a share profile can drop it.
 */
export const RunSettledSchema = Type.Object(
	{
		version: Type.Literal(1),
		agentId: ExistingId,
		executionRole: vocabulary(["builder", "reviewer", "judge", "researcher", "verifier", "recovery"]),
		requestOrigin: nullable(vocabulary(["user", "agent", "internal", "harness"])),
		identity: nullable(
			Type.Object({ host: Type.String({ maxLength: 256 }), user: Type.String({ maxLength: 256 }) }, closed),
		),
		route: Type.Object(
			{
				targetId: ExistingId,
				wireModelId: ExistingId,
				runtimeId: ExistingId,
				runtimeKind: vocabulary(["http", "sdk", "subprocess", "acp-delegation"]),
			},
			closed,
		),
		node: nullable(Type.Object({ id: ExistingId, kind: vocabulary(["local", "ssh"]) }, closed)),
		/**
		 * The route decision the run executed under, as route history and readiness fold it; null when none was observed.
		 * `executed` is the executed route's whole identity, hashes only, so the fold keys and drift-checks it from this
		 * record alone (#434).
		 */
		routeDecision: nullable(
			Type.Object(
				{
					decisionHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
					mode: vocabulary(["fixed", "shadow", "active"]),
					durationMs: duration,
					constraintsValid: Type.Boolean(),
					executed: Type.Object(
						{
							agentId: ExistingId,
							specFingerprint: digest,
							executionRole: vocabulary(["builder", "reviewer", "judge", "researcher", "verifier", "recovery"]),
							targetId: ExistingId,
							modelId: ExistingId,
							runtimeId: ExistingId,
							nodeId: ExistingId,
							thinkingLevel: nullable(ExistingId),
							toolSignature: digest,
							promptCompositionHash: digest,
							endpointIdentityHash: digest,
							settingsFingerprint: digest,
						},
						closed,
					),
				},
				closed,
			),
		),
		/** The run's retry attempt within its assignment, 0 for the first (`RunLineage.attempt`). */
		attempt: count,
		/** Queue wait and user-observed end-to-end time from the run's phase marks; null where a mark is missing. */
		phaseTiming: Type.Object({ queueWaitMs: nullable(duration), totalEndToEndMs: nullable(duration) }, closed),
		/** The routing request the run was admitted under, which a continuation it seeds inherits. */
		routingIntent: Type.Object(
			{
				posture: vocabulary(["manual", "quality", "balanced", "latency", "economy"]),
				maxCostUsd: nullable(Type.Number({ minimum: 0 })),
				deadlineMs: nullable(duration),
				minimumQuality: nullable(Type.Number()),
				requiredCapabilities: Type.Array(ExistingId, { maxItems: 64 }),
				locality: vocabulary(["local-only", "prefer-local", "any"]),
				failover: vocabulary(["none", "approved"]),
			},
			closed,
		),
		startedAt: utc,
		endedAt: utc,
		outcome: RunOutcome,
		outcomeCode: nullable(RunOutcomeCode),
		/** Null when the host settled a run whose worker never reported an exit. */
		exitCode: nullable(Type.Integer()),
		outcomeDetail: nullable(diagnostic),
		failureMessage: nullable(diagnostic),
		terminalReason: RunTerminalReason,
		/** Null when no call telemetry reached the host: unknown, never zero calls (R1, #434). */
		callIds: Type.Union([Type.Array(CallIdSchema), Type.Null()]),
		processExitCode: Type.Union([Type.Integer(), Type.Null()]),
		boundKind: Type.Optional(RunBoundKind),
		/** Only the worker's repair loop can count its rounds; the host never infers zero (#425). */
		repairRounds: factSchema(count),
		frameType: Type.Union([text, Type.Null()]),
		/** The run's own spend as one fact per quantity; the read model folds the calls for coverage (#434). */
		usage: UsageSchema,
		totalTokens: factSchema(count),
		apiCalls: factSchema(count),
		pricing: PricingSchema,
		toolCalls: count,
		/** Calls per tool and how they ended, by tool name; a tool's arguments and results are never kept here. */
		tools: Type.Array(Type.Object({ tool: ExistingId, calls: count, ok: count, errors: count, blocked: count }, closed), {
			maxItems: 256,
		}),
		/** The skills the run loaded, in activation order, and who asked for each; never a skill's path or body. */
		skills: Type.Array(
			Type.Object({ name: ExistingId, requestSource: nullable(vocabulary(["recipe", "model", "operator"])) }, closed),
			{ maxItems: 256 },
		),
		/** The run's tool calls as the finalizer classified them; null for a run with no tool telemetry. */
		toolActivity: nullable(
			Type.Object(
				{ calls: count, succeeded: count, failed: count, blocked: count, mutatingSucceeded: Type.Boolean() },
				closed,
			),
		),
		/** A read-only recipe admitted against a task that needs a write; null when the pairing was sound. */
		capabilityMismatch: nullable(
			Type.Object(
				{ agentId: ExistingId, capabilityClass: ExistingId, taskType: ExistingId, suggestedAgentId: nullable(ExistingId) },
				closed,
			),
		),
		/** The tool budget the run ran under, worded as dispatch words it; null when it had none. */
		budget: nullable(Type.Object({ policy: text, requested: text, effective: text, reasons: text }, closed)),
		/** What context the run was sent, by size; the hashes are in `hashes`, the content is never kept. */
		context: Type.Object(
			{
				briefingBytes: nullable(count),
				worker: nullable(
					Type.Object({ mode: vocabulary(["fork", "splice"]), estimatedTokens: count, omittedMessages: count }, closed),
				),
				project: nullable(
					Type.Object(
						{
							tier: vocabulary(["none", "bounded"]),
							chars: nullable(count),
							sections: Type.Array(ExistingId, { maxItems: 64 }),
						},
						closed,
					),
				),
			},
			closed,
		),
		/** What the provider reported about the model and gateway route of the run's calls, each distinct one once. */
		upstream: Type.Object({ responseModelIds: nullable(text), gatewayRoutes: nullable(text) }, closed),
		/** Tool calls safety refused, by tool, class and rule; the call's arguments and reason prose are not kept. */
		blockedAttempts: Type.Array(
			Type.Object(
				{
					tool: ExistingId,
					actionClass: nullable(ExistingId),
					ruleId: nullable(ExistingId),
					reasonCode: nullable(ExistingId),
				},
				closed,
			),
			{ maxItems: 64 },
		),
		/** Permission escalations the run asked for and how they ended; null when none was asked. */
		escalations: nullable(Type.Object({ requested: count, approved: count, denied: count, timedOut: count }, closed)),
		/** Information-flow restrictions the run's context carried, which its consumers must keep (`flow-restrictions.ts`). */
		flowRestrictions: nullable(
			Type.Object(
				{
					version: Type.Literal(1),
					restrictions: Type.Array(
						Type.Object(
							{
								ruleId: ExistingId,
								policyHash: Type.String({ maxLength: 256 }),
								sourceRef: text,
								recipients: Type.Array(ExistingId, { maxItems: 256 }),
							},
							closed,
						),
						{ maxItems: 256 },
					),
					advisory: Type.Optional(Type.Array(text, { maxItems: 64 })),
				},
				closed,
			),
		),
		/** Who governed an external peer's tools; null for a run Clio's own tool loop drove. */
		toolGovernance: nullable(vocabulary(["clio-coder-policy", "agent-managed", "deny-all"])),
		verification: Type.Object(
			{
				state: vocabulary(["verified", "unverified", "not_applicable", "unknown"]),
				basis: vocabulary([
					"validation-tool",
					"read-only-agent",
					"no-validation-tool",
					"acp-external-unobserved",
					"receipt-unavailable",
				]),
			},
			closed,
		),
		/** Null when the run settled before its result could be judged. */
		quality: nullable(
			Type.Object(
				{
					typedValidations: Type.Array(
						Type.Object({ sourceId: text, validatorDigest: digest, passed: Type.Boolean() }, closed),
						{ maxItems: 256 },
					),
					responseSchema: Type.Object(
						{
							sourceId: nullable(text),
							schemaDigest: nullable(digest),
							runtimeEnforceable: Type.Boolean(),
							enforcementPassed: nullable(Type.Boolean()),
						},
						closed,
					),
					resultContract: nullable(
						Type.Object(
							{
								sourceId: text,
								validatorDigest: digest,
								conformance: vocabulary(["pass", "fail", "not-reached"]),
								quality: vocabulary(["pass", "fail", "unmeasured"]),
							},
							closed,
						),
					),
				},
				closed,
			),
		),
		validationGrounding: nullable(
			Type.Object(
				{
					claimed: count,
					grounded: count,
					ungrounded: Type.Array(text, { maxItems: 64 }),
					basis: vocabulary(["no-command-executed", "unmatched-command"]),
				},
				closed,
			),
		),
		findings: nullable(
			Type.Object(
				{
					tags: Type.Array(ExistingId, { maxItems: 64 }),
					firstPassSuccess: Type.Boolean(),
					findingCount: count,
				},
				closed,
			),
		),
		/** The isolated writer checkout's verdict; its path, branch and changed paths are in the result object. */
		worktree: nullable(
			Type.Object(
				{
					apply: vocabulary(["merge", "preserve"]),
					applied: Type.Boolean(),
					snapshot: nullable(vocabulary(["working-tree", "unavailable"])),
				},
				closed,
			),
		),
		/** Orchestrator-run declared checks; their commands and output tails are in the result object. */
		hostVerification: nullable(
			Type.Object(
				{
					status: vocabulary(["verified", "rejected", "skipped", "not_implicated"]),
					strategy: vocabulary(["single", "batch-settled"]),
					checks: count,
					failed: count,
					/** Failing checks that also failed on the task base, so they cannot show the change caused them. */
					failedOnBase: count,
				},
				closed,
			),
		),
		/**
		 * Whether the briefing, worker context and project context the run was sent were recorded consistently, judged
		 * when the run settled; their hashes are in `hashes`, their text is never kept.
		 */
		contextProvenance: vocabulary(["recorded", "invalid", "not_applicable", "unknown"]),
		hashes: Type.Array(RunHashSchema, { maxItems: 512 }),
		result: ObjectRefSchema,
	},
	closed,
);
export type RunSettled = Static<typeof RunSettledSchema>;

/** The `run-result` object a run.settled names: what the run delivered, redacted when it is stored (#434). */
export const RunResultObjectSchema = Type.Object(
	{
		version: Type.Literal(1),
		output: nullable(
			Type.Object(
				{
					state: vocabulary(["final", "partial"]),
					text: Type.String(),
					bytes: count,
					truncated: Type.Boolean(),
					/** The host-validated internal handoff; `text` holds the same payload as canonical JSON. */
					structured: Type.Optional(
						Type.Object(
							{ version: Type.Literal(1), kind: ExistingId, data: Type.Record(Type.String(), Type.Unknown()) },
							closed,
						),
					),
				},
				closed,
			),
		),
		failureMessage: nullable(Type.String()),
		outcomeDetail: nullable(Type.String()),
		worktree: nullable(
			Type.Object(
				{
					path: Type.String(),
					branch: Type.String(),
					diffHash: nullable(Type.String()),
					changedPaths: Type.Optional(Type.Array(Type.String())),
					commit: Type.Optional(Type.String()),
					reason: Type.Optional(Type.String()),
					detail: Type.Optional(Type.String()),
				},
				closed,
			),
		),
		checkoutChanges: nullable(
			Type.Object(
				{ cwd: Type.String(), changedPaths: Type.Array(Type.String()), attribution: Type.Literal("observed-delta") },
				closed,
			),
		),
		hostVerification: nullable(
			Type.Object(
				{
					reason: nullable(Type.String()),
					checks: Type.Array(
						Type.Object(
							{
								check: Type.String(),
								argv: Type.Array(Type.String()),
								cwd: Type.String(),
								exitCode: Type.Integer(),
								durationMs: duration,
								memo: Type.Boolean(),
								outputTail: Type.String(),
								evidenceRunId: nullable(Type.String()),
								/** The same check replayed on the task base; null when it was not compared. */
								baseComparison: nullable(
									Type.Object(
										{
											status: vocabulary(["passed", "failed", "not_compared"]),
											base: Type.Optional(Type.String()),
											exitCode: Type.Optional(Type.Integer()),
											reason: Type.Optional(Type.String()),
										},
										closed,
									),
								),
							},
							closed,
						),
					),
				},
				closed,
			),
		),
	},
	closed,
);
export type RunResultObject = Static<typeof RunResultObjectSchema>;

const trustIdentifier = Type.String({ minLength: 1, maxLength: 512 });
const trustArtifact = Type.Object(
	{
		kind: vocabulary(TRUST_ARTIFACT_KINDS),
		id: trustIdentifier,
		digest: Type.Optional(
			Type.Object({ algorithm: Type.Literal("sha256"), value: Type.String({ pattern: "^[0-9a-f]{64}$" }) }, closed),
		),
	},
	closed,
);
/** One trust axis: an attributed state, or an absence and its reason (`domains/evidence/trust-status.ts`). */
function trustAxisSchema<const T extends readonly string[]>(states: T) {
	return Type.Union([
		Type.Object(
			{
				state: vocabulary(states.filter((state) => state !== "absent")),
				source: Type.Object({ kind: vocabulary(TRUST_STATUS_SOURCE_KINDS), id: trustIdentifier }, closed),
				authority: Type.Object({ kind: vocabulary(TRUST_STATUS_AUTHORITY_KINDS), id: trustIdentifier }, closed),
				artifacts: Type.Array(trustArtifact, { maxItems: 16 }),
			},
			closed,
		),
		Type.Object({ state: Type.Literal("absent"), reason: vocabulary(TRUST_ABSENCE_REASONS) }, closed),
	]);
}
export const TrustStatusSchema = Type.Object(
	{
		version: Type.Literal(1),
		artifactIntegrity: trustAxisSchema(TRUST_STATUS_STATES.artifactIntegrity),
		validationGrounding: trustAxisSchema(TRUST_STATUS_STATES.validationGrounding),
		independentReview: trustAxisSchema(TRUST_STATUS_STATES.independentReview),
		contextProvenance: trustAxisSchema(TRUST_STATUS_STATES.contextProvenance),
		completionEvidence: trustAxisSchema(TRUST_STATUS_STATES.completionEvidence),
	},
	closed,
);
const findingId = Type.String({ pattern: "^finding-[0-9]{3}$" });
/**
 * A finished run's assessment, journaled after its run.settled and before its seal, so the seal covers it and the
 * sealed run scope is the run's evidence (#434). Version 1. The trust status is the producer's: its integrity axis
 * says the producer held the record, and a reader replaces it with the seal's own verdict. Finding prose and the
 * decision records the run cited are content, kept in the `evidence-findings` object `text` names.
 */
export const EvidenceAssessedSchema = Type.Object(
	{
		version: Type.Literal(1),
		/** The dispatch lineage attempt the run ran as; null for a run dispatched without a lineage. */
		attempt: nullable(count),
		/** Succeeded on its first attempt with validation evidence. */
		firstPassSuccess: Type.Boolean(),
		/** What a non-zero exit is attributed to, from termination facts only; null for a run that exited 0. */
		failureCause: nullable(vocabulary(EVIDENCE_TAGS)),
		trust: TrustStatusSchema,
		findings: Type.Array(
			Type.Object({ id: findingId, severity: vocabulary(["info", "warn"]), tag: vocabulary(EVIDENCE_TAGS) }, closed),
			{ maxItems: 128 },
		),
		/** The gate decisions that judged the run by the time it settled, as the independent-review axis read them. */
		verdicts: Type.Array(
			Type.Object(
				{
					decisionId: ExistingId,
					digest: sha256Hex,
					outcome: ExistingId,
					review: vocabulary(TRUST_STATUS_STATES.independentReview),
				},
				closed,
			),
			{ maxItems: 64 },
		),
		/**
		 * Where the run came from as dispatch recorded it: the decisions it cited and whether each resolved on its
		 * session's board, the pipeline step it ran as, and the persona override that composed its prompt. Null when the
		 * run was sealed by recovery after its owner died, which no longer holds them.
		 */
		provenance: nullable(
			Type.Object(
				{
					decisionRefs: Type.Array(Type.Object({ ref: ExistingId, resolved: Type.Boolean() }, closed), {
						maxItems: 256,
					}),
					pipeline: nullable(
						Type.Object(
							{
								fromRunId: nullable(ExistingId),
								position: Type.Integer({ minimum: 1 }),
								inputBytes: count,
								inputTruncated: Type.Boolean(),
							},
							closed,
						),
					),
					personaOverride: nullable(Type.Object({ promptHash: ExistingId }, closed)),
				},
				closed,
			),
		),
		text: ObjectRefSchema,
	},
	closed,
);
export type EvidenceAssessed = Static<typeof EvidenceAssessedSchema>;
/** The `evidence-findings` object an evidence.assessed names: each finding's sentence and the decisions it resolved. */
export const EvidenceFindingsObjectSchema = Type.Object(
	{
		version: Type.Literal(1),
		findings: Type.Array(Type.Object({ id: findingId, message: Type.String() }, closed)),
		decisions: Type.Array(
			Type.Object({ ref: ExistingId, sessionId: ExistingId, record: Type.Record(Type.String(), Type.Unknown()) }, closed),
		),
	},
	closed,
);
export type EvidenceFindingsObject = Static<typeof EvidenceFindingsObjectSchema>;
export const RunFeedAppendedSchema = Type.Object(
	{ seq: Type.Integer({ minimum: 1 }), body: RunFeedBodySchema },
	closed,
);
export const RunLinkedSchema = Type.Object({ runId: ExistingId }, closed);
export const ProcessExitedSchema = Type.Object({ exitCode: Type.Integer() }, closed);
/**
 * What the one-time removal of the pre-#434 telemetry stores did on an existing home: regular files and directories
 * removed, session metas rewritten without usage, entries left because they were not a regular file or directory,
 * and removals that failed.
 */
export const OldTelemetryRemovedSchema = Type.Object(
	{ files: count, directories: count, rewritten: count, skipped: count, failed: count },
	closed,
);
/**
 * One boot, once its surface answers: the boot timer's phases as offsets from the timer's start, and on the TUI how
 * long the Stage 0 shell could not answer input. The writer header already names the build (#434).
 */
export const ProcessBootedSchema = Type.Object(
	{
		surface: vocabulary(["tui", "run", "acp"]),
		node: Type.String({ minLength: 1, maxLength: 64 }),
		platform: Type.String({ minLength: 1, maxLength: 64 }),
		totalMs: duration,
		phases: Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 128 }), atMs: duration }, closed), {
			maxItems: 64,
		}),
		interactivity: Type.Optional(
			Type.Object({ stage0Ms: duration, hydratedMs: duration, inputBlockedMaxMs: duration }, closed),
		),
	},
	closed,
);
/**
 * One System One dataset sample: a decision with its redacted state and question specs, or an outcome that followed
 * one, joined by `ref`. The sample itself is research content in `objects/` (#434).
 */
export const SystemOneSampleCapturedSchema = Type.Object(
	{
		sample: vocabulary(["decision", "outcome"]),
		decisionId: Type.Optional(ExistingId),
		site: Type.Optional(ExistingId),
		ref: Type.Optional(ExistingId),
		content: ObjectRefSchema,
		bytes: count,
	},
	closed,
);
/** A live event the hub delivered, journaled only under research mode's bus-trace flag: its name, never its payload (#434). */
export const BusTracedSchema = Type.Object({ event: Type.String({ minLength: 1, maxLength: 128 }) }, closed);
const prewarmLabel = Type.String({ minLength: 1, maxLength: 128 });
/**
 * Whether a cache pre-warm was admitted: the chat route's prompt warm on a latency surface, or a startup worker warm
 * that its deployment refused. A run that went ahead settles as prewarm.settled (#434).
 */
export const PrewarmDecidedSchema = Type.Object(
	{
		round: vocabulary(["prompt", "worker"]),
		trigger: Type.Optional(prewarmLabel),
		targetId: Type.Optional(ExistingId),
		model: Type.Optional(ExistingId),
		ran: Type.Boolean(),
		reason: Type.Optional(prewarmLabel),
		detail: Type.Optional(prewarmLabel),
		durationMs: Type.Optional(duration),
	},
	closed,
);
/** One pre-warm round that reached its provider; its spend, when any, is the call it journaled (#434). */
export const PrewarmSettledSchema = Type.Object(
	{
		round: vocabulary(["prompt", "model-wake", "worker"]),
		targetId: ExistingId,
		model: ExistingId,
		trigger: Type.Optional(prewarmLabel),
		ttftMs: Type.Union([duration, Type.Null()]),
		apiMs: duration,
		promptTokens: Type.Optional(count),
		aborted: Type.Boolean(),
		detached: Type.Optional(Type.Boolean()),
		failed: Type.Boolean(),
	},
	closed,
);
/**
 * A scope's seal (#434): `head` is the journal's hash chain head before the seal line, `records` the number of chained
 * lines (segment headers included) that head covers, and the file lists name every journal segment and object of the
 * scope at that moment. The live segment's entry covers its bytes before the seal line.
 */
export const ScopeSealedSchema = Type.Object(
	{
		head: sha256Hex,
		records: count,
		segments: Type.Array(
			Type.Object(
				{ name: Type.String({ pattern: "^journal(\\.[0-9]{10})?\\.jsonl$" }), sha256: sha256Hex, bytes: count },
				closed,
			),
		),
		objects: Type.Array(
			Type.Object({ id: Type.String({ pattern: "^obj_[0-9a-f]{64}$" }), sha256: sha256Hex, bytes: count }, closed),
		),
	},
	closed,
);
export type ScopeSealed = Static<typeof ScopeSealedSchema>;
/** The share profiles an operator picks from; what each admits is declared in src/domains/telemetry/share.ts (#434). */
export const ShareProfileSchema = vocabulary(["content-free", "structural", "research"]);
/**
 * The seal of a shared scope (#434): a scope's seal over the filtered journal a share archive carries, naming the
 * profile that filtered it. Its fields mean what a scope seal's do, over the shared bytes instead of the source's.
 */
export const ShareSealedSchema = Type.Object({ ...ScopeSealedSchema.properties, profile: ShareProfileSchema }, closed);
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
		windows: Type.Array(QuotaWindowSchema),
		displayName: text,
		status: vocabulary(["ok", "no_credentials", "expired", "error", "loading"]),
		plan: Type.Optional(text),
		credits: Type.Optional(
			Type.Object({ display: text, usedPct: factSchema(Type.Number({ minimum: 0, maximum: 100 })) }, closed),
		),
		message: Type.Optional(text),
		retryAfterSeconds: Type.Optional(duration),
		stale: Type.Optional(Type.Boolean()),
		/** The provider reported that this account cannot send now. */
		limitReached: Type.Optional(Type.Boolean()),
	},
	closed,
);
// Admission found the session's priced spend at or over a ceiling, once per ceiling; ctx names the call it held (#424).
export const BudgetCrossedSchema = Type.Object(
	{
		level: vocabulary(["at", "over"]),
		/** Spend so far; the cost admission counted ahead of its settlement is `projectedUsd` (#434). */
		spendUsd: duration,
		projectedUsd: Type.Optional(duration),
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
		projectedUsd: Type.Optional(duration),
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
		/** Every journal writer the process holds open: records queued now, and records they dropped since opening. */
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
 * One final safety disposition at a tool decision point, carrying its classification and policy facts. Commands,
 * arguments and policy prose stay out of the journal (#434).
 */
export const ToolDecidedSchema = Type.Object(
	{
		tool: ExistingId,
		actionClass: ExistingId,
		decision: vocabulary(["allowed", "blocked", "permission_requested", "denied"]),
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
