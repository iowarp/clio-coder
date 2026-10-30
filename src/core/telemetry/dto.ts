import type { Static, TSchema } from "typebox";
import { Type } from "typebox";
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
import {
	CallSettledSchema,
	MIDDLEWARE_EFFECTS,
	ObjectRefSchema,
	PricingSchema,
	RunFeedBodySchema,
	SYSTEM_ONE_OUTCOME,
	UtcSchema,
} from "./schemas.js";

/**
 * Read-model DTOs (#434 §11.2). TUI, ACP, CLI `--json` and the GUI serve these shapes unchanged, so one fact has one
 * value and one wording everywhere (R11). Every quantity is `{ fact, display, ref }`: the fact or fold result, the
 * canonical renderer's string, and the reference `explain` resolves. Unions grow additively within a version;
 * readers skip a timeline entry or report section whose kind they do not know (R12).
 */

const closed = { additionalProperties: false };
const count = Type.Integer({ minimum: 0 });
const nonNegative = Type.Number({ minimum: 0 });
const text = Type.String({ maxLength: 4096 });

export const TELEMETRY_DTO_VERSION = 1;
// The optional per-call transport facts, unwrapped for the DTOs that always carry them (null when unrecorded).
const transportFacts = {
	pinReason: vocabulary(["auth_rejection", "transport_failure", "post_stream_or_unknown_failure"]),
	recovery: Type.Object(
		{
			action: vocabulary(["cooldown_reset", "auth_reset"]),
			outcome: vocabulary(["eligible", "recovered", "failed", "unknown"]),
		},
		closed,
	),
};

export const FactSumSchema = Type.Object(
	{
		measured: nonNegative,
		estimated: nonNegative,
		unknownCount: count,
		absentCount: count,
		coverage: Type.Object({ measured: count, estimated: count, unknown: count }, closed),
	},
	closed,
);

export const FACT_METRICS = [
	"calls",
	"attempts",
	"neverSent",
	"sentUnsettled",
	"settledNoUsage",
	"settled",
	"incomplete",
	"input",
	"output",
	"cacheRead",
	"cacheWrite",
	"cacheWrite1h",
	"reasoning",
	"prompt",
	"total",
	"usd",
	"apiCalls",
	"missingTokenCalls",
	"ttft",
	"modelTime",
	"settle",
	"admissionWait",
	"requestBytes",
	"websocketFailures",
	"sseFallbacks",
	"rePrefilled",
	"uncachedPrefill",
	"breakUsd",
	"repairRounds",
	"runs",
	"harnessTime",
	"networkTime",
	"toolTime",
	"bookkeepingRounds",
	"roundTripTax",
] as const;
export type FactMetric = (typeof FACT_METRICS)[number];
/** `cause` selects a closed failure cause, `wait` an admission hold, `cold` an expected cold reason. */
export const FACT_GROUPS = ["label", "model", "turn", "run", "cause", "wait", "cold"] as const;
export type FactGroup = (typeof FACT_GROUPS)[number];
export const FACT_SCOPES = ["own", "runs", "session", "lineage", "run", "repo"] as const;
export type FactScope = (typeof FACT_SCOPES)[number];

/**
 * `<scope>:<owner>[/attempt:<attemptId>]#<metric>[@<group>=<key>]`, the key URI-encoded. Scopes: `own` is the calls a
 * session's journal owns; `runs` the worker runs it referenced; `session` both, what the account was charged; `lineage`
 * a session with its fork ancestors; `run` one run journal; `repo` a repository's sessions and runs over a window, owned
 * as `<cwdHash>-<days>d` or `all-<days>d`. `own` and `runs` also take a `repo` owner, splitting its window into the
 * sessions' own calls and the worker runs. An attempt narrows `own` or `run` to one attempt.
 */
const REF_PATTERN = new RegExp(
	`^(${FACT_SCOPES.join("|")}):([A-Za-z0-9_-]{1,128})(?:/attempt:(att_[0-9a-f-]{36}))?#(${FACT_METRICS.join("|")})(?:@(${FACT_GROUPS.join("|")})=([^\\s#@/]{1,512}))?$`,
);
export const FactRefSchema = Type.String({ pattern: REF_PATTERN.source, maxLength: 1024 });
export type FactRef = string;
export interface ParsedFactRef {
	scope: FactScope;
	owner: string;
	attemptId?: string;
	metric: FactMetric;
	group?: { by: FactGroup; key: string };
}

export function factRef(parts: ParsedFactRef): FactRef {
	return `${parts.scope}:${parts.owner}${parts.attemptId ? `/attempt:${parts.attemptId}` : ""}#${parts.metric}${
		parts.group ? `@${parts.group.by}=${encodeURIComponent(parts.group.key)}` : ""
	}`;
}

export function parseFactRef(ref: string): ParsedFactRef | null {
	const match = REF_PATTERN.exec(ref);
	if (!match) return null;
	const [, scope, owner, attemptId, metric, by, key] = match;
	let decoded: string | undefined;
	try {
		decoded = key === undefined ? undefined : decodeURIComponent(key);
	} catch {
		// A malformed escape cannot name a group.
		return null;
	}
	return {
		scope: scope as ParsedFactRef["scope"],
		owner: owner as string,
		...(attemptId ? { attemptId } : {}),
		metric: metric as FactMetric,
		...(by && decoded !== undefined ? { group: { by: by as FactGroup, key: decoded } } : {}),
	};
}

export const QuantitySchema = Type.Object(
	{ fact: Type.Union([factSchema(nonNegative), FactSumSchema]), display: Type.String(), ref: FactRefSchema },
	closed,
);
export type Quantity = Static<typeof QuantitySchema>;
/** A non-numeric fact (a reported model, a transport mode); explained through its call's ref. */
export const FactTextSchema = Type.Object(
	{ fact: factSchema(Type.Union([text, Type.Boolean(), Type.Null()])), display: Type.String() },
	closed,
);

const tokens = Type.Object(
	{
		input: QuantitySchema,
		output: QuantitySchema,
		cacheRead: QuantitySchema,
		cacheWrite: QuantitySchema,
		cacheWrite1h: QuantitySchema,
		reasoning: QuantitySchema,
		prompt: QuantitySchema,
		total: QuantitySchema,
	},
	closed,
);
const pricedBy = Type.Object(
	{ provider: count, "target-rates": count, catalog: count, free: count, none: count },
	closed,
);
const cost = Type.Object({ usd: QuantitySchema, pricedBy }, closed);
const dispositions = Type.Object(
	{
		neverSent: QuantitySchema,
		sentUnsettled: QuantitySchema,
		settledNoUsage: QuantitySchema,
		settled: QuantitySchema,
		incomplete: QuantitySchema,
	},
	closed,
);
const callCounts = Type.Object({ calls: QuantitySchema, attempts: QuantitySchema, dispositions }, closed);
/** How much of the source the fold could read; any gap marks the totals it touched as partial. */
export const JournalCoverageSchema = Type.Object(
	{
		present: Type.Boolean(),
		/** The live model is still merging its cold read; every sum this journal feeds is partial meanwhile. */
		seeding: Type.Boolean(),
		records: count,
		skipped: count,
		damaged: count,
		gapRecords: count,
		droppedRecords: count,
		duplicateRecords: count,
		conflictingAttempts: count,
		/** Legacy rows whose spend names no call: checkpoint aggregates, and rows the importer could not rebuild (#434). */
		unattributedAggregates: count,
	},
	closed,
);
const header = {
	v: Type.Literal(TELEMETRY_DTO_VERSION),
	foldVersion: Type.Integer({ minimum: 1 }),
	generatedAt: UtcSchema,
};
const mode = vocabulary(["standard", "research"]);

export const RunRowSchema = Type.Object(
	{
		runId: ExistingId,
		sessionId: Type.Union([ExistingId, Type.Null()]),
		firstAt: Type.Union([UtcSchema, Type.Null()]),
		lastAt: Type.Union([UtcSchema, Type.Null()]),
		/** Null while the run has not settled or its journal is unreadable. */
		terminalReason: Type.Union([RunTerminalReason, Type.Null()]),
		source: vocabulary(["calls", "aggregate", "parts", "conflict", "unavailable"]),
		apiCalls: QuantitySchema,
		tokens: QuantitySchema,
		usd: QuantitySchema,
	},
	closed,
);
export type RunRowV1 = Static<typeof RunRowSchema>;

const labelRow = Type.Object(
	{ label: CallLabel, calls: QuantitySchema, tokens: QuantitySchema, usd: QuantitySchema },
	closed,
);
const totals = Type.Object({ tokens: QuantitySchema, usd: QuantitySchema }, closed);

export const SessionTelemetrySchema = Type.Object(
	{
		...header,
		kind: Type.Literal("session"),
		sessionId: ExistingId,
		/** Every distinct segment mode, oldest first; a mid-session change shows both (#434 §9). */
		modes: Type.Array(mode),
		journal: JournalCoverageSchema,
		lifetime: Type.Object(
			{
				firstRecordAt: Type.Union([UtcSchema, Type.Null()]),
				lastRecordAt: Type.Union([UtcSchema, Type.Null()]),
				/**
				 * `open` while the process that last wrote the session is alive, `ended-abnormally` once it is gone without a
				 * close, `unverifiable` when it ran on another host, and `unknown` with no journal writer or ledger owner to
				 * check (#434 §6.1). `lastRecordAt` dates the last fact either way.
				 */
				state: vocabulary(["open", "closed", "ended-abnormally", "unverifiable", "unknown"]),
				/** Set only when `state` is `closed`; the reason is null for a close only the ledger recorded. */
				closed: Type.Union([
					Type.Object(
						{ at: UtcSchema, reason: Type.Union([vocabulary(["completed", "cancelled", "error"]), Type.Null()]) },
						closed,
					),
					Type.Null(),
				]),
			},
			closed,
		),
		lineage: Type.Object(
			{
				parent: Type.Union([Type.Object({ sessionId: ExistingId, turnId: ExistingId, at: text }, closed), Type.Null()]),
				/** Ancestors plus this session, each call once; null for a session with no parent. */
				totals: Type.Union([totals, Type.Null()]),
				unreadableAncestors: count,
			},
			closed,
		),
		/** Calls this session's journal owns: main loop and side calls, every branch (decision A, #434). */
		own: Type.Object({ counts: callCounts, tokens, cost }, closed),
		byLabel: Type.Array(labelRow),
		runs: Type.Object(
			{ count: count, unresolved: count, apiCalls: QuantitySchema, tokens: QuantitySchema, usd: QuantitySchema },
			closed,
		),
		/** Own calls plus referenced runs: what the account was charged for this session. */
		totals,
		/**
		 * The main loop's wall time split into the harness's own work, network, model and tools, and its bookkeeping-only
		 * rounds with the prompt tokens they re-read beside the main loop's whole prompt (#434 §12.3, §12.4).
		 */
		overhead: Type.Object(
			{
				harness: QuantitySchema,
				network: QuantitySchema,
				model: QuantitySchema,
				tool: QuantitySchema,
				bookkeepingRounds: QuantitySchema,
				roundTripTax: QuantitySchema,
				prompt: QuantitySchema,
			},
			closed,
		),
		/**
		 * The latest sent main-loop call's transport facts, with the session's WebSocket failures and SSE fallbacks.
		 * Transitions are per-call facts, not a record kind (#434).
		 */
		transport: Type.Union([
			Type.Object(
				{
					attemptId: AttemptIdSchema,
					at: UtcSchema,
					kind: TransportKind,
					continuation: FactTextSchema,
					sessionPinnedToSse: FactTextSchema,
					pinReason: Type.Union([transportFacts.pinReason, Type.Null()]),
					recovery: Type.Union([transportFacts.recovery, Type.Null()]),
					websocketFailures: QuantitySchema,
					sseFallbacks: QuantitySchema,
				},
				closed,
			),
			Type.Null(),
		]),
	},
	closed,
);
export type SessionTelemetryV1 = Static<typeof SessionTelemetrySchema>;

export const CallRowSchema = Type.Object(
	{
		callId: CallIdSchema,
		attemptId: AttemptIdSchema,
		attempt: count,
		label: CallLabel,
		owner: Type.Object(
			{
				sessionId: Type.Union([ExistingId, Type.Null()]),
				runId: Type.Optional(ExistingId),
				turnId: Type.Optional(ExistingId),
			},
			closed,
		),
		startedAt: UtcSchema,
		settledAt: Type.Union([UtcSchema, Type.Null()]),
		target: Type.Object(
			{
				targetId: ExistingId,
				runtimeId: ExistingId,
				api: ExistingId,
				requestedModel: ExistingId,
				reportedModel: FactTextSchema,
			},
			closed,
		),
		roundKind: RoundKind,
		toolChoice: text,
		/** `incomplete` when no trustworthy settlement exists; that never asserts a request was sent. */
		disposition: Type.Union([Disposition, Type.Literal("incomplete")]),
		stop: Type.Union([
			Type.Object({ reason: StopReason, failure: Type.Optional(FailureCause), detail: Type.Optional(text) }, closed),
			Type.Null(),
		]),
		/** Null for a never-sent call: no usage and no estimate (R2). */
		usage: Type.Union([tokens, Type.Null()]),
		usd: QuantitySchema,
		pricedBy: PricingSchema.properties.pricedBy,
		/** Offsets from the attempt's start in ms, on the clock of the process that sent it. */
		stages: Type.Union([CallSettledSchema.properties.stages, Type.Null()]),
		timing: Type.Object(
			{
				ttft: QuantitySchema,
				modelTime: QuantitySchema,
				settle: QuantitySchema,
				admissionWait: QuantitySchema,
				/** The harness's own work before sending, admission holds excluded (#434 §12.3). */
				harness: QuantitySchema,
				/** Unknown unless the call recorded its connect span and first byte. */
				network: QuantitySchema,
				/** The tools this call asked for, approval parks excluded. */
				tool: QuantitySchema,
			},
			closed,
		),
		admission: Type.Union([vocabulary(["budget", "capacity", "steering"]), Type.Null()]),
		transport: Type.Object(
			{
				kind: TransportKind,
				continuation: FactTextSchema,
				requestBytes: QuantitySchema,
				sessionPinnedToSse: FactTextSchema,
				connectionReused: FactTextSchema,
				websocketFailures: QuantitySchema,
				sseFallbacks: QuantitySchema,
				pinReason: Type.Union([transportFacts.pinReason, Type.Null()]),
				recovery: Type.Union([transportFacts.recovery, Type.Null()]),
			},
			closed,
		),
		cache: Type.Object(
			{
				verdict: CallSettledSchema.properties.cache.properties.verdict,
				expectedColdReasons: CallSettledSchema.properties.cache.properties.expectedColdReasons,
				firstDivergentSection: FactTextSchema,
				rePrefilled: QuantitySchema,
				uncachedPrefill: QuantitySchema,
				/** rePrefilled × (input rate − cache-read rate), once a call records it (#434 §12). */
				breakUsd: QuantitySchema,
			},
			closed,
		),
		quota: Type.Union([CallSettledSchema.properties.quota, Type.Null()]),
		responseId: Type.Union([text, Type.Null()]),
	},
	closed,
);
export type CallRowV1 = Static<typeof CallRowSchema>;

export const CallFilterSchema = Type.Object(
	{
		labels: Type.Optional(Type.Array(CallLabel)),
		dispositions: Type.Optional(Type.Array(Type.Union([Disposition, Type.Literal("incomplete")]))),
		/** The active path's user turns, for a branch view; whole-session spend ignores branches (#434). */
		turnIds: Type.Optional(Type.Array(ExistingId)),
		runId: Type.Optional(ExistingId),
		from: Type.Optional(UtcSchema),
		to: Type.Optional(UtcSchema),
		limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100_000 })),
	},
	closed,
);
export type CallFilter = Static<typeof CallFilterSchema>;

export const CallsReportSchema = Type.Object(
	{
		...header,
		kind: Type.Literal("calls"),
		sessionId: Type.Union([ExistingId, Type.Null()]),
		runId: Type.Union([ExistingId, Type.Null()]),
		filter: CallFilterSchema,
		calls: Type.Array(CallRowSchema),
		/** Rows the filter matched before `limit` cut them. */
		matched: count,
	},
	closed,
);
export type CallsReportV1 = Static<typeof CallsReportSchema>;

const audienceShare = Type.Object({ calls: QuantitySchema, tokens: QuantitySchema, usd: QuantitySchema }, closed);
const costGroup = Type.Object(
	{
		key: text,
		calls: QuantitySchema,
		tokens: QuantitySchema,
		usd: QuantitySchema,
		pricedBy,
		/**
		 * The group split by who spent it: the sessions' own calls (`own` refs) and the worker runs (`runs` refs). Null
		 * when grouped by label, whose `worker` row already is the split, and for one run, which is all worker spend.
		 */
		audience: Type.Union([Type.Object({ session: audienceShare, worker: audienceShare }, closed), Type.Null()]),
	},
	closed,
);
export const CostReportSchema = Type.Object(
	{
		...header,
		kind: Type.Literal("cost"),
		scope: Type.Union([
			Type.Object({ sessionId: ExistingId }, closed),
			Type.Object({ runId: ExistingId }, closed),
			Type.Object({ repo: text, days: Type.Integer({ minimum: 1 }) }, closed),
		]),
		groupBy: vocabulary(["label", "model", "turn"]),
		total: Type.Object({ calls: QuantitySchema, tokens: QuantitySchema, usd: QuantitySchema, pricedBy }, closed),
		groups: Type.Array(costGroup),
	},
	closed,
);
export type CostReportV1 = Static<typeof CostReportSchema>;

const cacheBreak = Type.Object(
	{
		callId: CallIdSchema,
		attemptId: AttemptIdSchema,
		at: UtcSchema,
		verdict: CallSettledSchema.properties.cache.properties.verdict,
		expectedColdReasons: CallSettledSchema.properties.cache.properties.expectedColdReasons,
		firstDivergentSection: FactTextSchema,
		rePrefilled: QuantitySchema,
		uncachedPrefill: QuantitySchema,
		breakUsd: QuantitySchema,
	},
	closed,
);
export const CacheReportSchema = Type.Object(
	{
		...header,
		kind: Type.Literal("cache"),
		sessionId: ExistingId,
		verdicts: Type.Object({ hot: count, partial: count, cold: count, small: count, unknown: count }, closed),
		cacheRead: QuantitySchema,
		cacheWrite: QuantitySchema,
		uncachedPrefill: QuantitySchema,
		rePrefilled: QuantitySchema,
		breakUsd: QuantitySchema,
		/** Calls whose re-prefill is measured above zero or whose verdict is cold or partial. */
		breaks: Type.Array(cacheBreak),
		byCause: Type.Array(
			Type.Object({ cause: text, breaks: count, rePrefilled: QuantitySchema, breakUsd: QuantitySchema }, closed),
		),
	},
	closed,
);
export type CacheReportV1 = Static<typeof CacheReportSchema>;

const at = { at: UtcSchema };
const callTiming = Type.Object(
	{ ttft: QuantitySchema, modelTime: QuantitySchema, settle: QuantitySchema, admissionWait: QuantitySchema },
	closed,
);
const callEntry = Type.Object(
	{
		kind: Type.Literal("call"),
		...at,
		endAt: Type.Union([UtcSchema, Type.Null()]),
		callId: CallIdSchema,
		attemptId: AttemptIdSchema,
		label: CallLabel,
		turnId: Type.Union([ExistingId, Type.Null()]),
		runId: Type.Union([ExistingId, Type.Null()]),
		disposition: Type.Union([Disposition, Type.Literal("incomplete")]),
		failure: Type.Union([FailureCause, Type.Null()]),
		stages: Type.Union([CallSettledSchema.properties.stages, Type.Null()]),
		/** The stage spans as quantities, so a surface labels a stage bar with the renderer's wording (#434). */
		timing: callTiming,
		tokens: QuantitySchema,
		usd: QuantitySchema,
		cacheVerdict: CallSettledSchema.properties.cache.properties.verdict,
	},
	closed,
);
const runEntry = Type.Object(
	{
		kind: Type.Literal("run"),
		...at,
		runId: ExistingId,
		event: vocabulary(["referenced", "settled"]),
		terminalReason: Type.Union([RunTerminalReason, Type.Null()]),
	},
	closed,
);
const gapEntry = Type.Object(
	{ kind: Type.Literal("gap"), ...at, sink: ExistingId, reason: text, count: count },
	closed,
);
/** A value a record carries rather than a fold; explained through its record, so it names no reference. */
const shown = Type.Object(
	{ fact: Type.Union([factSchema(nonNegative), FactSumSchema]), display: Type.String() },
	closed,
);
/** A configured amount such as a ceiling: a setting, not spend, so it carries no provenance. */
const limit = Type.Object({ usd: nonNegative, display: Type.String() }, closed);
const settingsSource = vocabulary(["file", "settings-ui", "cli", "session-override", "slash-command", "unattributed"]);
/**
 * Priced spend reaching a ceiling (`crossing`), or a paid request held there until the hold ended (`wait`). `spend`
 * is what admission saw, marked estimated when any call settled before it was, with the unpriced calls beside it.
 */
export const BudgetEntrySchema = Type.Object(
	{
		kind: Type.Literal("budget"),
		...at,
		event: vocabulary(["crossing", "wait"]),
		level: vocabulary(["at", "over"]),
		callId: Type.Union([CallIdSchema, Type.Null()]),
		attemptId: Type.Union([AttemptIdSchema, Type.Null()]),
		spend: shown,
		ceiling: limit,
		contextTokens: Type.Union([shown, Type.Null()]),
		outcome: Type.Union([vocabulary(["raised", "removed", "cleared", "refused", "aborted"]), Type.Null()]),
		waited: Type.Union([shown, Type.Null()]),
		raisedTo: Type.Union([limit, Type.Null()]),
		raisedBy: Type.Union([settingsSource, Type.Null()]),
	},
	closed,
);
/** A provider's quota windows as one reading saw them; journaled at a turn's first reading and on change. */
export const QuotaEntrySchema = Type.Object(
	{
		kind: Type.Literal("quota"),
		...at,
		provider: ExistingId,
		targetId: ExistingId,
		source: vocabulary(["response-headers", "stream-event", "poll"]),
		observedAt: UtcSchema,
		/** Null when the reading did not say. */
		limitReached: Type.Union([Type.Boolean(), Type.Null()]),
		windows: Type.Array(
			Type.Object(
				{
					key: ExistingId,
					usedPct: Type.Object(
						{ fact: factSchema(Type.Number({ minimum: 0, maximum: 100 })), display: Type.String() },
						closed,
					),
					resetsAt: Type.Union([UtcSchema, Type.Null()]),
				},
				closed,
			),
		),
	},
	closed,
);
export const TimelineEntrySchema = Type.Union([
	callEntry,
	Type.Object(
		{
			kind: Type.Literal("turn"),
			...at,
			turnId: Type.Union([ExistingId, Type.Null()]),
			stopReason: StopReason,
			cause: Type.Union([FailureCause, Type.Null()]),
			stage: Type.Union([text, Type.Null()]),
			retries: count,
			callIds: Type.Array(CallIdSchema),
		},
		closed,
	),
	runEntry,
	Type.Object(
		{
			kind: Type.Literal("compaction"),
			...at,
			callIds: Type.Array(CallIdSchema),
			outcome: vocabulary(["committed", "discarded", "failed", "unresolved"]),
		},
		closed,
	),
	Type.Object(
		{
			kind: Type.Literal("session"),
			...at,
			event: vocabulary(["opened", "resumed", "forked_from", "closed"]),
			detail: Type.Union([text, Type.Null()]),
		},
		closed,
	),
	gapEntry,
	/** The effective settings when the writer opened (`snapshot`), or one change with the paths it touched (#434 §8). */
	Type.Object(
		{
			kind: Type.Literal("config"),
			...at,
			event: vocabulary(["snapshot", "changed"]),
			source: Type.Union([settingsSource, Type.Null()]),
			paths: Type.Union([
				Type.Object({ hotReload: Type.Array(text), nextTurn: Type.Array(text), restartRequired: Type.Array(text) }, closed),
				Type.Null(),
			]),
			settings: ObjectRefSchema,
			previous: Type.Union([ObjectRefSchema, Type.Null()]),
			settingsFingerprint: text,
		},
		closed,
	),
	BudgetEntrySchema,
	QuotaEntrySchema,
	/** One tool call as the model's tool wrapper settled it; its own time excludes any wait for approval. */
	Type.Object(
		{
			kind: Type.Literal("tool"),
			...at,
			tool: ExistingId,
			outcome: vocabulary(["ok", "error", "blocked"]),
			blocked: Type.Union([vocabulary(["refused", "denied-park", "redundant-repeat"]), Type.Null()]),
			toolCallId: Type.Union([ExistingId, Type.Null()]),
			/** The model call that asked for the tool. */
			callId: Type.Union([CallIdSchema, Type.Null()]),
			turnId: Type.Union([ExistingId, Type.Null()]),
			runId: Type.Union([ExistingId, Type.Null()]),
			duration: shown,
			parked: Type.Union([shown, Type.Null()]),
			resultBytes: Type.Union([shown, Type.Null()]),
		},
		closed,
	),
	/** One middleware rule that emitted effects at a hook, with the evidence class it matched (#431). */
	Type.Object(
		{
			kind: Type.Literal("middleware"),
			...at,
			hook: vocabulary(["before_tool", "after_tool", "turn_start", "turn_end", "on_compaction"]),
			phase: vocabulary(["sync", "async", "awaited"]),
			ruleId: ExistingId,
			effects: Type.Array(MIDDLEWARE_EFFECTS),
			severity: Type.Union([vocabulary(["info", "advisory", "warn", "hard-block"]), Type.Null()]),
			evidence: Type.Union([text, Type.Null()]),
			tool: Type.Union([ExistingId, Type.Null()]),
			turnId: Type.Union([ExistingId, Type.Null()]),
		},
		closed,
	),
	/** One OAuth credential refresh under the storage lock (#427). */
	Type.Object(
		{
			kind: Type.Literal("auth"),
			...at,
			provider: ExistingId,
			trigger: vocabulary(["expiry", "rejected"]),
			attempted: Type.Boolean(),
			outcome: vocabulary(["refreshed", "adopted", "failed", "cancelled"]),
			/** True when this session's process wrote the credential now in use; false when another process did. */
			wroteCredential: Type.Boolean(),
			duration: shown,
		},
		closed,
	),
	/** The first request to cite a compiled prompt structure; the structure object resolves its sections. */
	Type.Object(
		{
			kind: Type.Literal("prompt"),
			...at,
			structure: ObjectRefSchema,
			layoutVersion: Type.Integer({ minimum: 1 }),
			sections: count,
			/** The structure's own chars/4 estimate. */
			tokens: shown,
			callId: Type.Union([CallIdSchema, Type.Null()]),
		},
		closed,
	),
	/** One persisted context snapshot: its window, and its prompt-side estimate beside the provider's count when reconciled. */
	Type.Object(
		{
			kind: Type.Literal("context"),
			...at,
			snapshotId: ExistingId,
			source: vocabulary(["estimated", "exact", "reconciled", "streaming"]),
			window: Type.Object({ desired: count, effective: count, source: ExistingId }, closed),
			estimated: Type.Union([shown, Type.Null()]),
			reconciled: Type.Union([shown, Type.Null()]),
			turnId: Type.Union([ExistingId, Type.Null()]),
			callId: Type.Union([CallIdSchema, Type.Null()]),
		},
		closed,
	),
	/** One System One decision: each engine's answer against the deadline, and its breaker transitions (#429). */
	Type.Object(
		{
			kind: Type.Literal("system-one"),
			...at,
			site: ExistingId,
			moment: Type.Union([ExistingId, Type.Null()]),
			outcome: SYSTEM_ONE_OUTCOME,
			latency: shown,
			deadline: shown,
			fitted: Type.Union([Type.Boolean(), Type.Null()]),
			routes: Type.Array(
				Type.Object(
					{
						engine: ExistingId,
						kind: ExistingId,
						outcome: SYSTEM_ONE_OUTCOME,
						roundTrip: Type.Union([shown, Type.Null()]),
						breaker: Type.Union([vocabulary(["opened", "probe", "closed", "disabled"]), Type.Null()]),
					},
					closed,
				),
			),
			callIds: Type.Array(CallIdSchema),
		},
		closed,
	),
	/** A referenced worker run's channel failure as its host saw it (#425). */
	Type.Object(
		{
			kind: Type.Literal("worker-channel"),
			...at,
			runId: ExistingId,
			lane: vocabulary(["stdin", "stdout"]),
			frameType: Type.Union([text, Type.Null()]),
			errno: Type.Union([text, Type.Null()]),
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
	),
]);
export type TimelineEntry = Static<typeof TimelineEntrySchema>;
export const TimelineSchema = Type.Object(
	{
		...header,
		kind: Type.Literal("timeline"),
		sessionId: ExistingId,
		range: Type.Union([Type.Object({ from: UtcSchema, to: UtcSchema }, closed), Type.Null()]),
		entries: Type.Array(TimelineEntrySchema),
	},
	closed,
);
export type TimelineV1 = Static<typeof TimelineSchema>;

/** A display with its fact and no reference: a span one record states, not a fold `explain` resolves. */
const spanDisplay = Type.Object({ fact: factSchema(nonNegative), display: Type.String() }, closed);
/**
 * One run journal in time order (#434 §11.3): its call attempts, the bounded run feed, the worker process's start
 * and exit, gaps, and the settlement. A run's own entry union, so the session timeline's kinds stay as they are.
 */
export const RunTimelineEntrySchema = Type.Union([
	callEntry,
	runEntry,
	gapEntry,
	Type.Object(
		{
			kind: Type.Literal("feed"),
			...at,
			seq: Type.Integer({ minimum: 1 }),
			body: RunFeedBodySchema,
			/** An event body's `durationMs` as a display; null when the body carries none. */
			duration: Type.Union([spanDisplay, Type.Null()]),
		},
		closed,
	),
	Type.Object(
		{
			kind: Type.Literal("process"),
			...at,
			event: vocabulary(["started", "exited"]),
			exitCode: Type.Union([Type.Integer(), Type.Null()]),
		},
		closed,
	),
]);
export type RunTimelineEntry = Static<typeof RunTimelineEntrySchema>;
export const RunTimelineSchema = Type.Object(
	{
		...header,
		kind: Type.Literal("run-timeline"),
		runId: ExistingId,
		sessionId: Type.Union([ExistingId, Type.Null()]),
		entries: Type.Array(RunTimelineEntrySchema),
	},
	closed,
);
export type RunTimelineV1 = Static<typeof RunTimelineSchema>;

const trustAxis = (states: readonly string[]) =>
	Type.Object(
		{
			state: vocabulary(states),
			/** The canonical trust word for the state, as the TUI footer prints it. */
			display: Type.String(),
			/** Who stands behind the state, e.g. `receipt_integrity_verification`; null for an absent axis. */
			authority: Type.Union([text, Type.Null()]),
		},
		closed,
	);
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const digestText = Type.String({ maxLength: 256 });

/**
 * A dispatched run's sealed receipt read through its integrity check (#434 §5.3, §11.3). Trust comes from the canonical
 * projection, and the checks the receipt sealed appear only under a seal that verified, so a claim the seal does not
 * vouch for never reads as a check that ran (L1, L6). The receipt file itself stays a document; nothing here is a raw
 * seal field.
 */
export const ReceiptEvidenceSchema = Type.Object(
	{
		...header,
		kind: Type.Literal("receipt-evidence"),
		runId: ExistingId,
		/**
		 * `unsealed` is this run's receipt with no integrity block, `unreadable` is a file that is not JSON or not a receipt,
		 * and `missing` is no file at all.
		 */
		receipt: vocabulary(["sealed", "unsealed", "missing", "unreadable"]),
		integrity: Type.Object(
			{
				/**
				 * `verified-ledger-evicted` checked the seal alone because the ledger row it was sealed from is gone;
				 * `retired-format` is a seal version this build no longer verifies.
				 */
				state: vocabulary(["verified", "verified-ledger-evicted", "failed", "retired-format", "unavailable"]),
				display: Type.String(),
				/** The verifier's own reason when the seal did not verify. */
				detail: nullable(text),
			},
			closed,
		),
		trust: Type.Object(
			{
				artifactIntegrity: trustAxis(["verified", "failed", "absent", "unknown", "not_applicable"]),
				validationGrounding: trustAxis(["validated", "failed", "ungrounded", "absent", "unknown", "not_applicable"]),
				independentReview: trustAxis([
					"passed",
					"failed",
					"inconclusive",
					"not_independent",
					"absent",
					"unknown",
					"not_applicable",
				]),
				contextProvenance: trustAxis(["recorded", "invalid", "absent", "unknown", "not_applicable"]),
				completionEvidence: trustAxis(["evidenced", "incomplete", "limited", "absent", "unknown", "not_applicable"]),
				/** The validation clause the footer prints beside the integrity word. */
				validation: Type.String(),
			},
			closed,
		),
		/** What the verified seal states; null unless `integrity.state` is `verified` or `verified-ledger-evicted`. */
		sealed: nullable(
			Type.Object(
				{
					outcome: text,
					outcomeCode: nullable(text),
					exitCode: nullable(Type.Integer()),
					failureMessage: nullable(text),
					verification: nullable(
						Type.Object(
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
					),
					/** Null when the receipt sealed no quality block; empty when it sealed one with no typed check. */
					typedValidations: nullable(
						Type.Array(Type.Object({ sourceId: text, validatorDigest: digestText, passed: Type.Boolean() }, closed)),
					),
					hostVerification: nullable(
						Type.Object(
							{
								status: vocabulary(["verified", "rejected", "skipped", "not_implicated"]),
								reason: nullable(text),
								strategy: vocabulary(["single", "batch-settled"]),
								checks: Type.Array(
									Type.Object(
										{
											check: text,
											exitCode: Type.Integer(),
											durationMs: nonNegative,
											memo: Type.Boolean(),
											outputTail: Type.String({ maxLength: 16_384 }),
											evidenceRunId: nullable(ExistingId),
										},
										closed,
									),
								),
							},
							closed,
						),
					),
					/** `unmeasured` when the run had no typed result contract; null when the receipt sealed no quality block. */
					resultContract: Type.Union([
						Type.Object(
							{
								sourceId: text,
								validatorDigest: digestText,
								kind: nullable(text),
								conformance: vocabulary(["pass", "fail", "not-reached"]),
								quality: vocabulary(["pass", "fail", "unmeasured"]),
							},
							closed,
						),
						Type.Literal("unmeasured"),
						Type.Null(),
					]),
					responseSchema: nullable(
						Type.Object(
							{
								sourceId: nullable(text),
								schemaDigest: nullable(digestText),
								runtimeEnforceable: Type.Boolean(),
								enforcementPassed: nullable(Type.Boolean()),
							},
							closed,
						),
					),
					validationGrounding: nullable(
						Type.Object(
							{
								claimed: count,
								grounded: count,
								ungrounded: Type.Array(text),
								basis: vocabulary(["no-command-executed", "unmatched-command"]),
							},
							closed,
						),
					),
				},
				closed,
			),
		),
		/** The evidence bundle the run was filed under, from the evidence index; null when none names it. */
		evidence: nullable(
			Type.Object(
				{ evidenceId: ExistingId, findingCount: count, succeeded: nullable(Type.Boolean()), filedAt: UtcSchema },
				closed,
			),
		),
	},
	closed,
);
export type ReceiptEvidenceV1 = Static<typeof ReceiptEvidenceSchema>;

export const RunTelemetrySchema = Type.Object(
	{
		...header,
		kind: Type.Literal("run"),
		row: RunRowSchema,
		journal: JournalCoverageSchema,
		counts: callCounts,
		tokens,
		missingTokenCalls: QuantitySchema,
		settled: Type.Union([
			Type.Object(
				{
					at: UtcSchema,
					terminalReason: RunTerminalReason,
					processExitCode: Type.Union([Type.Integer(), Type.Null()]),
					boundKind: Type.Union([RunBoundKind, Type.Null()]),
					repairRounds: QuantitySchema,
					frameType: Type.Union([text, Type.Null()]),
					callIds: Type.Union([Type.Array(CallIdSchema), Type.Null()]),
				},
				closed,
			),
			Type.Null(),
		]),
		/** The run's sealed receipt through its integrity check; null when the reader was given no receipt to check. */
		receipt: Type.Union([ReceiptEvidenceSchema, Type.Null()]),
	},
	closed,
);
export type RunTelemetryV1 = Static<typeof RunTelemetrySchema>;

export const WhyStoppedSchema = Type.Object(
	{
		...header,
		kind: Type.Literal("why-stopped"),
		sessionId: ExistingId,
		state: vocabulary(["no-turns", "turn-completed", "turn-failed", "turn-cancelled", "closed"]),
		lastTurn: Type.Union([
			Type.Object(
				{
					at: UtcSchema,
					turnId: Type.Union([ExistingId, Type.Null()]),
					stopReason: StopReason,
					cause: Type.Union([FailureCause, Type.Null()]),
					stage: Type.Union([text, Type.Null()]),
					retries: count,
					callIds: Type.Array(CallIdSchema),
				},
				closed,
			),
			Type.Null(),
		]),
		/** The settled attempts the last turn named, in settlement order. */
		lastCalls: Type.Array(CallRowSchema),
		causes: Type.Array(Type.Object({ cause: FailureCause, calls: QuantitySchema, lastAt: UtcSchema }, closed)),
		waits: Type.Array(
			Type.Object(
				{ on: vocabulary(["budget", "capacity", "steering"]), calls: QuantitySchema, waited: QuantitySchema },
				closed,
			),
		),
		cache: Type.Object({ rePrefilled: QuantitySchema, breakUsd: QuantitySchema }, closed),
		/** Main-loop rounds whose only tools were bookkeeping, and the prompt tokens they re-read (#434 §12.4). */
		roundTrips: Type.Object({ rounds: QuantitySchema, tax: QuantitySchema }, closed),
		spend: totals,
		/** Every ceiling crossing and held request the journal recorded, oldest first (#434 §12.6). */
		budget: Type.Array(BudgetEntrySchema),
		/** Each account's latest journaled quota reading, the ones that reported a limit first. */
		quota: Type.Array(QuotaEntrySchema),
		/** Rendered findings, most decisive first; every number in them also appears above. */
		findings: Type.Array(Type.String()),
	},
	closed,
);
export type WhyStoppedV1 = Static<typeof WhyStoppedSchema>;

export const ExplanationSchema = Type.Object(
	{
		...header,
		kind: Type.Literal("explanation"),
		ref: FactRefSchema,
		value: QuantitySchema,
		/** How the value's contributions split by fact kind, in the canonical renderer's wording. */
		coverage: Type.String(),
		/** The fold rule, e.g. `sum(call.usage.input) over attempts where disposition≠never_sent`. */
		rule: Type.String(),
		from: Type.Object(
			{
				callIds: Type.Array(CallIdSchema),
				attemptIds: Type.Array(AttemptIdSchema),
				runIds: Type.Array(ExistingId),
				recordIds: Type.Array(Type.String()),
				/** Contributors beyond the cap are counted, not listed. */
				omitted: count,
			},
			closed,
		),
	},
	closed,
);
export type ExplanationV1 = Static<typeof ExplanationSchema>;

export const QuotaStateSchema = Type.Object(
	{
		...header,
		kind: Type.Literal("quota"),
		providers: Type.Array(
			Type.Object(
				{
					provider: ExistingId,
					source: vocabulary(["response-headers", "stream-event", "poll", "unknown"]),
					observedAt: Type.Union([UtcSchema, Type.Null()]),
					stale: Type.Boolean(),
					windows: Type.Array(
						Type.Object(
							{
								key: ExistingId,
								label: Type.Union([text, Type.Null()]),
								usedPct: Type.Object(
									{ fact: factSchema(Type.Number({ minimum: 0, maximum: 100 })), display: Type.String() },
									closed,
								),
								resetsAt: Type.Union([UtcSchema, Type.Null()]),
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
export type QuotaStateV1 = Static<typeof QuotaStateSchema>;

const liveCount = Type.Object({ fact: factSchema(nonNegative), display: Type.String() }, closed);
export const HealthSchema = Type.Object(
	{
		...header,
		kind: Type.Literal("health"),
		journals: Type.Array(
			Type.Object(
				{
					owner: text,
					queueDepth: liveCount,
					persisted: liveCount,
					dropped: liveCount,
					invalid: liveCount,
					filtered: liveCount,
					writeErrors: liveCount,
				},
				closed,
			),
		),
		producer: Type.Object({ unownedRecords: liveCount, sinkFailures: liveCount }, closed),
		/** Event-loop delay over the latest health window; unknown until a window is observed. */
		loopLag: Type.Object({ p50: liveCount, p99: liveCount, max: liveCount }, closed),
	},
	closed,
);
export type HealthV1 = Static<typeof HealthSchema>;

export const TELEMETRY_TOPICS = ["session", "calls", "cost", "cache", "timeline", "runs", "quota", "health"] as const;
export type TelemetryTopic = (typeof TELEMETRY_TOPICS)[number];
/** Coalesced change notice; readers fetch the topics they show. Never per token. */
export const TelemetryUpdateSchema = Type.Object(
	{
		v: Type.Literal(TELEMETRY_DTO_VERSION),
		kind: Type.Literal("telemetry_update"),
		sessionId: Type.Union([ExistingId, Type.Null()]),
		seq: count,
		generatedAt: UtcSchema,
		topics: Type.Array(vocabulary(TELEMETRY_TOPICS)),
	},
	closed,
);
export type TelemetryUpdateV1 = Static<typeof TelemetryUpdateSchema>;

/** Every DTO schema, for the GUI contract export and the lie-detector walk. */
export const TELEMETRY_DTO_SCHEMAS = {
	session: SessionTelemetrySchema,
	calls: CallsReportSchema,
	cost: CostReportSchema,
	cache: CacheReportSchema,
	timeline: TimelineSchema,
	run: RunTelemetrySchema,
	runTimeline: RunTimelineSchema,
	runs: Type.Array(RunRowSchema),
	receiptEvidence: ReceiptEvidenceSchema,
	whyStopped: WhyStoppedSchema,
	explanation: ExplanationSchema,
	quota: QuotaStateSchema,
	health: HealthSchema,
	update: TelemetryUpdateSchema,
} satisfies Record<string, TSchema>;
