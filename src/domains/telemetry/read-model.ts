import { processIdentityAlive } from "../../core/process-identity.js";
import { cacheBreakLoss } from "../../core/telemetry/cache-break.js";
import type { TelemetryContext } from "../../core/telemetry/context.js";
import { telemetryOwner } from "../../core/telemetry/context.js";
import type {
	CacheReportV1,
	CallFilter,
	CallRowV1,
	CallsReportV1,
	CostReportV1,
	ExplanationV1,
	FactGroup,
	FactMetric,
	FactRef,
	ParsedFactRef,
	Quantity,
	ReceiptEvidenceV1,
	RunRowV1,
	RunTelemetryV1,
	RunTimelineEntry,
	RunTimelineV1,
	SessionTelemetryV1,
	TimelineEntry,
	TimelineV1,
	WhyStoppedV1,
} from "../../core/telemetry/dto.js";
import { factRef, parseFactRef, TELEMETRY_DTO_VERSION } from "../../core/telemetry/dto.js";
import type { ClockOrigin, SegmentHeader, TelemetryRecord } from "../../core/telemetry/envelope.js";
import type { EventPayload, JournalEventName } from "../../core/telemetry/events.js";
import type { Fact, FactSum } from "../../core/telemetry/fact.js";
import {
	renderCount,
	renderCountSum,
	renderCoverage,
	renderDurationSum,
	renderFact,
	renderTextFact,
	renderUsdFact,
	renderUsdLimit,
	renderUsdSum,
} from "../../core/telemetry/render.js";
import type { CallSettled, CallUsage, ObjectRef } from "../../core/telemetry/schemas.js";
import { ToolNames } from "../../core/tool-names.js";
import type { ContextSnapshot } from "../session/context-accounting.js";
import type { SessionPromptCompileRecord } from "../session/prompt-manifest.js";
import type { CallJournalFolder, CallTotals, FoldedAttempt, FoldOptions, JournalFold } from "./folds.js";
import {
	addCallTotals,
	addGroup,
	callJournalFolder,
	emptyCallTotals,
	emptyFactSum,
	foldCallJournal,
	foldCalls,
	foldFacts,
	foldRunJournal,
	sumFactSums,
	TELEMETRY_FOLD_VERSION,
} from "./folds.js";
import type { telemetryPromptStructure } from "./objects.js";

/**
 * The telemetry read model (#434 §11). Pure: callers hand it journal records (read from disk, or the live writer's
 * persisted batches) and get DTOs back. Every quantity in every DTO comes from {@link measure}, the same function
 * `explain` answers with, so a number and its explanation cannot drift apart, and every display string comes from
 * the canonical renderer. Arithmetic is the telemetry folds'; this module only selects what they fold.
 */

type Mode = SegmentHeader["mode"];
export interface JournalSource {
	/** False when the owner has no journal file at all. */
	present: boolean;
	records: readonly TelemetryRecord[];
	modes: readonly Mode[];
	skipped: number;
	damaged: number;
	/** The live model has not merged this owner's cold read yet; whole-scope sums stay partial until it does (#434). */
	seeding?: boolean;
	/** The process that last owned the journal, from its last segment header (#434 §6.1). */
	writer?: ClockOrigin;
}
/** The process a ledger names; `birthToken` is null where the platform gives none. */
export interface ProcessIdentity {
	host: string;
	pid: number;
	birthToken: string | null;
}
export interface SessionSource {
	sessionId: string;
	journal: JournalSource;
	/** Run journals this session's own records reference, keyed by run id. */
	runs: ReadonlyMap<string, JournalSource>;
	/** The fork parent; `source` is null when it could not be read. */
	parent: { sessionId: string; turnId: string; at: string; source: SessionSource | null } | null;
	/**
	 * The ledger's own lifecycle: `endedAt` is set by a clean close and cleared by a reopen. Sessions that predate the
	 * journal, and every session until the journal records its own close, end only here (#434 §6.1).
	 */
	ledger?: { endedAt: string | null; owner: ProcessIdentity | null };
	/**
	 * The quota readings this host's process journals recorded while the session ran. A quota window belongs to the
	 * account, so the process journal keeps it, and a session reads the account's state from there (#434).
	 */
	accountQuota?: readonly TelemetryRecord[];
}
/** The account window a cold or live session reads, bounded by its own journal lifecycle (#434). */
export function sessionAccountQuotaWindow(records: readonly TelemetryRecord[]): { from: number; to: number } | null {
	let from = Number.POSITIVE_INFINITY;
	let last: TelemetryRecord | undefined;
	for (const record of records) {
		const at = Date.parse(record.t);
		if (Number.isFinite(at) && at < from) from = at;
		if (!last || record.t >= last.t) last = record;
	}
	if (!Number.isFinite(from)) return null;
	return { from, to: last?.k === "session.closed" ? Date.parse(last.t) : Number.POSITIVE_INFINITY };
}

/** Several sessions read as one scope: a repository's sessions over a window, already windowed by the loader (#434). */
export interface RepoSource {
	/** The ref owner, `<cwdHash>-<days>d` or `all-<days>d`; see {@link repoOwner}. */
	owner: string;
	sessions: readonly SessionSource[];
	/** Run journals no session in the scope references, such as a standalone `run --agent`. */
	runs: ReadonlyMap<string, JournalSource>;
}

export function repoOwner(cwdHash: string | null, days: number): string {
	return `${cwdHash ?? "all"}-${days}d`;
}

/** The repository bucket (null for every bucket) and window a `repo` scope owner names, or null when it names none. */
export function parseRepoOwner(owner: string): { cwdHash: string | null; days: number } | null {
	const match = /^([0-9a-f]{16}|all)-([1-9][0-9]{0,5})d$/.exec(owner);
	if (!match) return null;
	return { cwdHash: match[1] === "all" ? null : (match[1] as string), days: Number(match[2]) };
}

export interface ReadOptions {
	now?: Date;
	/** Whether a recorded process still runs; null when it cannot be probed. Defaults to {@link processIdentityAlive}. */
	alive?: (identity: ProcessIdentity) => boolean | null;
}

/** A journal read as the read model holds it; a run's journal keeps only records its run owns (#434). */
export function journalSourceFromRead(
	read: {
		records: ReadonlyArray<{ record: TelemetryRecord }>;
		modes?: readonly Mode[];
		skipped: number;
		damaged: number;
		writer?: ClockOrigin;
	},
	fileExists: boolean,
	runId?: string,
): JournalSource {
	const records = read.records.map(({ record }) => record);
	return {
		present: fileExists || records.length > 0,
		records: runId === undefined ? records : records.filter((record) => record.ctx.runId === runId),
		modes: read.modes ?? [],
		skipped: read.skipped,
		damaged: read.damaged,
		...(read.writer ? { writer: read.writer } : {}),
	};
}

interface Attempt extends FoldedAttempt {
	startedAt: string;
	settledAt: string | null;
	ctx: TelemetryContext | null;
	recordIds: string[];
	/** The tools the attempt's call asked for, as tool.settled recorded them; null when none is recorded. */
	tools: ToolSummary | null;
}
/** The tool calls one model call asked for (#434 §12.3, §12.4). */
interface ToolSummary {
	calls: number;
	durationMs: number;
	/** Every tool was bookkeeping: the round re-read its context for no work on the task. */
	bookkeepingOnly: boolean;
}

/**
 * The tools whose rounds the epic counts as bookkeeping: they update the plan or record a decision and do no work on
 * the task, so a round that called only them paid a context re-read for nothing else (#434 §12.4).
 */
const BOOKKEEPING_TOOLS: ReadonlySet<string> = new Set([ToolNames.Tasks, ToolNames.Decide]);

function noteTool(tools: Map<string, ToolSummary>, record: TelemetryRecord): string | null {
	if (record.k !== "tool.settled" || record.ctx.callId === undefined) return null;
	const prior = tools.get(record.ctx.callId);
	tools.set(record.ctx.callId, {
		calls: (prior?.calls ?? 0) + 1,
		durationMs: (prior?.durationMs ?? 0) + record.data.durationMs,
		bookkeepingOnly: (prior?.bookkeepingOnly ?? true) && BOOKKEEPING_TOOLS.has(record.data.tool),
	});
	return record.ctx.callId;
}
interface Run {
	runId: string;
	source: JournalSource;
	/** The session record that referenced the run, which the run's turn and reference time come from. */
	reference: TelemetryRecord | null;
	fold: ReturnType<typeof foldRunJournal>;
	attempts: Attempt[];
	byAttempt: Map<string, Attempt>;
	settled: { at: string; data: EventPayload<"run.settled"> } | null;
	firstAt: string | null;
	lastAt: string | null;
	sessionId: string | null;
	/** The parent turn whose session record referenced the run. */
	turnId: string | null;
	referencedAt: string | null;
	/** Unreadable lines or a damaged segment; the fold cannot see what they held. */
	gap: number;
}
interface Analysis {
	sessionId: string;
	/** Every attempt in the read model's order; the same array as the whole selection's members. */
	attempts: Attempt[];
	byAttempt: Map<string, Attempt>;
	fold: Pick<JournalFold, "coverage">;
	/** Unknown contributions added to every whole-scope sum: an incomplete read and unattributed aggregates. */
	gap: number;
	runs: Map<string, Run>;
	/** One running fold per selection a reader asked for, keyed by group; the whole set is `""`. */
	selections: Map<string, SelectionState>;
	growth: Growth;
}

/**
 * What a live analysis needs to fold only the records a later read appends (#434 §11). Records fold as `head` then
 * the fixed `tail` (ancestors' records for a lineage), while a cold read folds appended records
 * before the tail; a new record that names an id the tail carries could fold differently, so it rebuilds instead.
 */
interface Growth {
	folder: CallJournalFolder;
	meta: Map<string, AttemptMeta>;
	/** Tool calls by the model call that asked for them, and each call's attempts, so a late tool record moves its call. */
	tools: Map<string, ToolSummary>;
	callAttempts: Map<string, Set<string>>;
	/** The first session record referencing each run. */
	references: Map<string, TelemetryRecord>;
	/** A gap other than policy was folded. */
	gapRecord: boolean;
	head: readonly TelemetryRecord[];
	tail: { records: Set<string>; attempts: Set<string>; runs: Set<string> };
	/** A lineage's parent source; null for a session's own analysis. */
	parent: SessionSource | null;
}

/** Facts an attempt's records give it beyond the fold: when it started and settled, its context and record ids. */
interface AttemptMeta {
	startedAt?: string;
	settledAt?: string;
	ctx?: TelemetryContext;
	ids: Set<string>;
}

const EPOCH = "1970-01-01T00:00:00.000Z";
const notApplicable: Fact<number> = { kind: "absent", reason: "not-applicable" };
const unobserved = { kind: "unknown", reason: "not-observed" } as const satisfies Fact<number>;
const localClock = (value: number): Fact<number> => ({ kind: "measured", value, source: "local-clock" });
const localCount = (value: number): Fact<number> => ({ kind: "measured", value, source: "local-count" });
const counted = (value: number): FactSum => foldFacts([{ kind: "measured", value, source: "local-count" }]);
/** One estimate whose producer named no method; a sum marks it `~` without claiming one (R3). */
const estimatedSum = (value: number): FactSum => ({
	measured: 0,
	estimated: value,
	unknownCount: 0,
	absentCount: 0,
	coverage: { measured: 0, estimated: 1, unknown: 0 },
});
/** `count` unknown contributions, built directly: a count read from a forged record must not size an allocation. */
const unknownSum = (count: number): FactSum => ({
	measured: 0,
	estimated: 0,
	unknownCount: count,
	absentCount: 0,
	coverage: { measured: 0, estimated: 0, unknown: count },
});
const header = (options: ReadOptions) => ({
	v: TELEMETRY_DTO_VERSION as typeof TELEMETRY_DTO_VERSION,
	foldVersion: TELEMETRY_FOLD_VERSION,
	generatedAt: (options.now ?? new Date()).toISOString(),
});

function noteMeta(meta: Map<string, AttemptMeta>, record: TelemetryRecord): void {
	if (record.k !== "call.started" && record.k !== "call.settled") return;
	const entry = meta.get(record.data.attemptId) ?? { ids: new Set<string>() };
	entry.ids.add(record.id);
	entry.ctx ??= record.ctx;
	if (record.k === "call.started") {
		if (entry.startedAt === undefined || record.t < entry.startedAt) entry.startedAt = record.t;
	} else if (entry.settledAt === undefined || record.t < entry.settledAt) entry.settledAt = record.t;
	meta.set(record.data.attemptId, entry);
}

function attemptOf(
	attempt: FoldedAttempt,
	entry: AttemptMeta | undefined,
	tools: ReadonlyMap<string, ToolSummary>,
): Attempt {
	return {
		...attempt,
		startedAt: entry?.startedAt ?? entry?.settledAt ?? EPOCH,
		settledAt: attempt.settled ? (entry?.settledAt ?? null) : null,
		ctx: entry?.ctx ?? null,
		recordIds: [...(entry?.ids ?? [])].sort(),
		tools: tools.get(attempt.started.callId) ?? null,
	};
}

/** The read model's attempt order, which per-attempt fact sums follow: start time, then attempt id. */
function byStart(a: Attempt, b: Attempt): number {
	return a.startedAt === b.startedAt
		? a.started.attemptId.localeCompare(b.started.attemptId)
		: a.startedAt < b.startedAt
			? -1
			: 1;
}
/** {@link foldCalls}'s order, which keeps every reader's floating-point sums identical (#434). */
const byAttemptId = (a: Attempt, b: Attempt) => a.started.attemptId.localeCompare(b.started.attemptId);

function attemptsOf(records: readonly TelemetryRecord[], attempts: readonly FoldedAttempt[]): Attempt[] {
	const meta = new Map<string, AttemptMeta>();
	const tools = new Map<string, ToolSummary>();
	for (const record of records) {
		noteMeta(meta, record);
		noteTool(tools, record);
	}
	return attempts.map((attempt) => attemptOf(attempt, meta.get(attempt.started.attemptId), tools)).sort(byStart);
}

const unavailable: JournalSource = { present: false, records: [], modes: [], skipped: 0, damaged: 0 };
/** Every surface reads an interrupted call's estimate where the provider reported nothing (#430). */
export const READ_MODEL_FOLD: FoldOptions = { interruptedEstimates: true };
const POLICY_GAPS: ReadonlySet<string> = new Set(["mode-filtered", "research-cap"]);

/** A run journal reads the same until the live model swaps its source, so each source is folded once. */
const runAnalyses = new WeakMap<JournalSource, Run>();
function analyzeRun(runId: string, source: JournalSource, reference?: TelemetryRecord): Run {
	const cached = runAnalyses.get(source);
	if (cached && cached.runId === runId && cached.reference === (reference ?? null)) return cached;
	const fold = foldRunJournal(source.records, READ_MODEL_FOLD);
	const attempts = attemptsOf(source.records, fold.calls.attempts);
	let settled: Run["settled"] = null;
	let firstAt: string | null = null;
	let lastAt: string | null = null;
	for (const record of source.records) {
		if (firstAt === null || record.t < firstAt) firstAt = record.t;
		if (lastAt === null || record.t > lastAt) lastAt = record.t;
		if (record.k === "run.settled" && (!settled || record.t >= settled.at)) settled = { at: record.t, data: record.data };
	}
	const run: Run = {
		runId,
		source,
		reference: reference ?? null,
		fold,
		attempts,
		byAttempt: new Map(attempts.map((attempt) => [attempt.started.attemptId, attempt])),
		settled,
		firstAt,
		lastAt,
		sessionId: source.records[0]?.ctx.sessionId ?? reference?.ctx.sessionId ?? null,
		turnId: reference?.ctx.turnId ?? null,
		referencedAt: reference?.t ?? null,
		gap: !source.present || source.skipped > 0 || source.damaged > 0 || source.seeding ? 1 : 0,
	};
	runAnalyses.set(source, run);
	return run;
}

/** Fold one record into the growth state; returns the attempts it may have changed. */
function grow(growth: Growth, record: TelemetryRecord): readonly string[] {
	noteMeta(growth.meta, record);
	if (record.k === "call.started" || record.k === "call.settled") {
		const attempts = growth.callAttempts.get(record.data.callId) ?? new Set<string>();
		attempts.add(record.data.attemptId);
		growth.callAttempts.set(record.data.callId, attempts);
	}
	// A tool settles after the call that asked for it, so its record changes that call's attempts.
	const toolCall = noteTool(growth.tools, record);
	if (toolCall !== null) return [...(growth.callAttempts.get(toolCall) ?? [])];
	if ((record.k === "run.linked" || record.k === "call.linked") && !growth.references.has(record.data.runId))
		growth.references.set(record.data.runId, record);
	// A mode-filtered or research-cap gap is policy: only research or content kinds go uncaptured, never
	// accountability, so neither makes a total partial (#434, R10).
	if (record.k === "journal.gap" && !POLICY_GAPS.has(record.data.reason)) growth.gapRecord = true;
	return growth.folder.add(record);
}

function settleRuns(analysis: Analysis, runSources: ReadonlyMap<string, JournalSource>, gap: number): void {
	const growth = analysis.growth;
	analysis.gap = gap + (growth.gapRecord ? 1 : 0);
	const runs = new Map<string, Run>();
	for (const runId of [...new Set([...growth.references.keys(), ...runSources.keys()])].sort())
		runs.set(runId, analyzeRun(runId, runSources.get(runId) ?? unavailable, growth.references.get(runId)));
	analysis.runs = runs;
}

function buildAnalysis(
	sessionId: string,
	head: readonly TelemetryRecord[],
	tail: readonly (readonly TelemetryRecord[])[],
	runSources: ReadonlyMap<string, JournalSource>,
	gap: number,
	parent: SessionSource | null,
): Analysis {
	const growth: Growth = {
		folder: callJournalFolder(undefined, READ_MODEL_FOLD),
		meta: new Map(),
		tools: new Map(),
		callAttempts: new Map(),
		references: new Map(),
		gapRecord: false,
		head,
		tail: { records: new Set(), attempts: new Set(), runs: new Set() },
		parent,
	};
	for (const record of head) grow(growth, record);
	for (const segment of tail)
		for (const record of segment) {
			grow(growth, record);
			growth.tail.records.add(record.id);
			if (record.k === "call.started" || record.k === "call.settled") growth.tail.attempts.add(record.data.attemptId);
			if (record.k === "run.linked" || record.k === "call.linked") growth.tail.runs.add(record.data.runId);
		}
	const attempts = growth.folder
		.attempts()
		.map((attempt) => attemptOf(attempt, growth.meta.get(attempt.started.attemptId), growth.tools))
		.sort(byStart);
	const analysis: Analysis = {
		sessionId,
		attempts,
		byAttempt: new Map(attempts.map((attempt) => [attempt.started.attemptId, attempt])),
		fold: { coverage: growth.folder.coverage },
		gap: 0,
		runs: new Map(),
		selections: new Map([["", selectionState(attempts, () => true)]]),
		growth,
	};
	settleRuns(analysis, runSources, gap);
	return analysis;
}

/**
 * Fold only what `head` appends to the records the analysis already holds, moving every running selection fold by
 * the attempts those records changed. False, with nothing changed, when `head` does not extend what was folded.
 */
function extendAnalysis(
	analysis: Analysis,
	head: readonly TelemetryRecord[],
	runSources: ReadonlyMap<string, JournalSource>,
	gap: number,
): boolean {
	const growth = analysis.growth;
	const folded = growth.head.length;
	if (head.length < folded) return false;
	for (let index = 0; index < folded; index += 1) if (head[index] !== growth.head[index]) return false;
	const tail = growth.tail;
	for (let index = folded; index < head.length; index += 1) {
		const record = head[index] as TelemetryRecord;
		if (
			tail.records.has(record.id) ||
			((record.k === "call.started" || record.k === "call.settled") && tail.attempts.has(record.data.attemptId)) ||
			((record.k === "run.linked" || record.k === "call.linked") && tail.runs.has(record.data.runId))
		)
			return false;
	}
	const touched = new Set<string>();
	for (let index = folded; index < head.length; index += 1)
		for (const attemptId of grow(growth, head[index] as TelemetryRecord)) touched.add(attemptId);
	growth.head = head;
	for (const attemptId of touched) {
		const before = analysis.byAttempt.get(attemptId);
		const folded = growth.folder.attempt(attemptId);
		const after = folded ? attemptOf(folded, growth.meta.get(attemptId), growth.tools) : undefined;
		if (after) analysis.byAttempt.set(attemptId, after);
		else analysis.byAttempt.delete(attemptId);
		for (const selection of analysis.selections.values()) updateSelection(selection, before, after);
	}
	settleRuns(analysis, runSources, gap);
	return true;
}

const readGap = (journal: JournalSource) => (journal.skipped > 0 || journal.damaged > 0 || journal.seeding ? 1 : 0);

/**
 * Analyses keyed by the source they fold. A live source declared a continuation of an analyzed one takes that
 * analysis over and folds only its appended records; the older source re-folds from scratch if it is read again.
 */
const analyses = new WeakMap<SessionSource, Analysis>();
const lineages = new WeakMap<SessionSource, Analysis>();
const continuations = new WeakMap<
	SessionSource,
	{ own: SessionSource | undefined; lineage: SessionSource | undefined }
>();

/**
 * Declare `next` a later read of `previous`: the same session with its own journal grown only by appending, so
 * analyzing it folds just the appended records (#434 §11). The read model verifies the append before relying on it.
 */
export function continueSource(next: SessionSource, previous: SessionSource): void {
	const prior = continuations.get(previous);
	continuations.set(next, {
		own: analyses.has(previous) ? previous : prior?.own,
		lineage: lineages.has(previous) ? previous : prior?.lineage,
	});
}

function analyze(source: SessionSource): Analysis {
	let analysis = analyses.get(source);
	if (analysis) return analysis;
	const gap = readGap(source.journal);
	const continuation = continuations.get(source);
	const base = continuation?.own;
	const prior = base ? analyses.get(base) : undefined;
	if (
		base &&
		prior &&
		prior.sessionId === source.sessionId &&
		extendAnalysis(prior, source.journal.records, source.runs, gap)
	) {
		analyses.delete(base);
		analysis = prior;
	} else analysis = buildAnalysis(source.sessionId, source.journal.records, [], source.runs, gap, null);
	if (continuation) continuation.own = undefined;
	analyses.set(source, analysis);
	return analysis;
}

/** A child's journal holds only its own calls; ancestors contribute theirs once, deduplicated by the fold (#434). */
function analyzeLineage(source: SessionSource): Analysis {
	let analysis = lineages.get(source);
	if (analysis) return analysis;
	const tail: (readonly TelemetryRecord[])[] = [];
	const runs = new Map<string, JournalSource>();
	let gap = 0;
	for (let node: SessionSource | null = source, depth = 0; node && depth < 128; depth += 1) {
		const own = analyze(node);
		if (node !== source) tail.push(node.journal.records);
		for (const [runId, run] of own.runs) if (!runs.has(runId)) runs.set(runId, run.source);
		gap += own.gap;
		if (node.parent && !node.parent.source) gap += 1;
		node = node.parent?.source ?? null;
	}
	const parent = source.parent?.source ?? null;
	const continuation = continuations.get(source);
	const base = continuation?.lineage;
	const prior = base ? lineages.get(base) : undefined;
	if (
		base &&
		prior &&
		prior.sessionId === source.sessionId &&
		prior.growth.parent === parent &&
		extendAnalysis(prior, source.journal.records, runs, gap)
	) {
		lineages.delete(base);
		analysis = prior;
	} else analysis = buildAnalysis(source.sessionId, source.journal.records, tail, runs, gap, parent);
	if (continuation) continuation.lineage = undefined;
	lineages.set(source, analysis);
	return analysis;
}

// ---- running selection folds ----

/** A fold over an ordered list that keeps the value before its last item, so the newest attempt settling refolds nothing. */
interface Fold<S> {
	value: S;
	/** The fold of every item but the last; null once a removal left it unknown. */
	previous: S | null;
	readonly empty: () => S;
	readonly add: (state: S, attempt: Attempt) => void;
	readonly copy: (state: S) => S;
}
/** How an edit moved the end of an ordered list; anything else refolds the list. */
type Edit = "append" | "replace-last" | "drop-last" | "other";

/** Lower bound: the first index whose item does not sort before `item`. */
function locate(items: readonly Attempt[], item: Attempt, order: (a: Attempt, b: Attempt) => number): number {
	let low = 0;
	let high = items.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (order(items[mid] as Attempt, item) < 0) low = mid + 1;
		else high = mid;
	}
	return low;
}

function edit(
	items: Attempt[],
	order: (a: Attempt, b: Attempt) => number,
	before: Attempt | undefined,
	after: Attempt | undefined,
): Edit {
	let wasLast = false;
	if (before) {
		const at = locate(items, before, order);
		if (items[at] !== before) {
			// Not where its key says; fall back to identity so the list never keeps a stale attempt.
			const index = items.indexOf(before);
			if (index !== -1) items.splice(index, 1);
			if (after) items.splice(locate(items, after, order), 0, after);
			return "other";
		}
		wasLast = at === items.length - 1;
		items.splice(at, 1);
	}
	if (!after) return wasLast ? "drop-last" : "other";
	const at = locate(items, after, order);
	items.splice(at, 0, after);
	if (at !== items.length - 1) return "other";
	return before === undefined ? "append" : wasLast ? "replace-last" : "other";
}

function refold<S>(fold: Fold<S>, items: readonly Attempt[]): void {
	const state = fold.empty();
	const last = items.length - 1;
	for (let index = 0; index < last; index += 1) fold.add(state, items[index] as Attempt);
	if (last < 0) {
		fold.previous = null;
		fold.value = state;
		return;
	}
	fold.previous = fold.copy(state);
	fold.add(state, items[last] as Attempt);
	fold.value = state;
}

/** Values already handed to a DTO are never mutated: every step folds into a copy. */
function advance<S>(fold: Fold<S>, change: Edit, after: Attempt | undefined, items: readonly Attempt[]): void {
	if (change === "append" && after) {
		const next = fold.copy(fold.value);
		fold.add(next, after);
		fold.previous = fold.value;
		fold.value = next;
	} else if (change === "replace-last" && after && fold.previous) {
		const next = fold.copy(fold.previous);
		fold.add(next, after);
		fold.value = next;
	} else if (change === "drop-last" && fold.previous) {
		fold.value = fold.previous;
		fold.previous = null;
	} else refold(fold, items);
}

const copySum = (sum: FactSum): FactSum => ({ ...sum, coverage: { ...sum.coverage } });
function copyTotals(totals: CallTotals): CallTotals {
	return {
		...totals,
		usage: {
			input: copySum(totals.usage.input),
			output: copySum(totals.usage.output),
			cacheRead: copySum(totals.usage.cacheRead),
			cacheWrite: copySum(totals.usage.cacheWrite),
			cacheWrite1h: copySum(totals.usage.cacheWrite1h),
			reasoning: copySum(totals.usage.reasoning),
		},
		promptTokens: copySum(totals.promptTokens),
		totalTokens: copySum(totals.totalTokens),
		usd: copySum(totals.usd),
	};
}

type PricedBy = CallSettled["pricing"]["pricedBy"];
const noPricing = (): Record<PricedBy, number> => ({ provider: 0, "target-rates": 0, catalog: 0, free: 0, none: 0 });

/**
 * One selection's attempts and their sums, kept current as batches land. The call fold follows attemptId order and
 * per-attempt fact folds follow the read model's order, exactly as a cold fold of the same members would (#434).
 */
interface SelectionState {
	readonly matches: (attempt: Attempt) => boolean;
	readonly members: Attempt[];
	readonly byId: Attempt[];
	readonly calls: Fold<CallTotals>;
	readonly facts: Map<FactMetric, Fold<FactSum>>;
	/** Members per call id, for the distinct call count. */
	readonly callIds: Map<string, number>;
	/** Invoked members whose token total is unknown. */
	missing: number;
	/** Invoked members by what priced them. */
	readonly pricedBy: Record<PricedBy, number>;
	totals: CallTotals | null;
}

function tokensUnknown(attempt: Attempt): boolean {
	const totals = emptyCallTotals();
	addCallTotals(totals, attempt.settled);
	return totals.totalTokens.unknownCount > 0;
}

function tallyMember(selection: SelectionState, attempt: Attempt, sign: 1 | -1): void {
	const callId = attempt.started.callId;
	const members = (selection.callIds.get(callId) ?? 0) + sign;
	if (members > 0) selection.callIds.set(callId, members);
	else selection.callIds.delete(callId);
	if (invoked(attempt) && attempt.settled) {
		selection.pricedBy[attempt.settled.pricing.pricedBy] += sign;
		if (tokensUnknown(attempt)) selection.missing += sign;
	}
}

/** `members` must already be in the read model's order; the selection owns the array from here on. */
function selectionState(members: Attempt[], matches: (attempt: Attempt) => boolean): SelectionState {
	const selection: SelectionState = {
		matches,
		members,
		byId: [...members].sort(byAttemptId),
		calls: {
			value: emptyCallTotals(),
			previous: null,
			empty: emptyCallTotals,
			add: (totals, attempt) => addCallTotals(totals, attempt.settled),
			copy: copyTotals,
		},
		facts: new Map(),
		callIds: new Map(),
		missing: 0,
		pricedBy: noPricing(),
		totals: null,
	};
	for (const attempt of members) tallyMember(selection, attempt, 1);
	refold(selection.calls, selection.byId);
	return selection;
}

function updateSelection(selection: SelectionState, before: Attempt | undefined, after: Attempt | undefined): void {
	const leaving = before && selection.matches(before) ? before : undefined;
	const joining = after && selection.matches(after) ? after : undefined;
	if (!leaving && !joining) return;
	if (leaving) tallyMember(selection, leaving, -1);
	if (joining) tallyMember(selection, joining, 1);
	const started = edit(selection.members, byStart, leaving, joining);
	for (const fold of selection.facts.values()) advance(fold, started, joining, selection.members);
	advance(selection.calls, edit(selection.byId, byAttemptId, leaving, joining), joining, selection.byId);
	selection.totals = null;
}

function selectionTotals(selection: SelectionState): CallTotals {
	selection.totals ??= { ...selection.calls.value, logicalCalls: selection.callIds.size };
	return selection.totals;
}

function selectionFacts(selection: SelectionState, metric: FactMetric): FactSum {
	let fold = selection.facts.get(metric);
	if (!fold) {
		fold = {
			value: emptyFactSum(),
			previous: null,
			empty: emptyFactSum,
			add: (sum, attempt) => addGroup(sum, [attemptFact(attempt, metric)]),
			copy: copySum,
		};
		refold(fold, selection.members);
		selection.facts.set(metric, fold);
	}
	return fold.value;
}

function selectionOf(analysis: Analysis, group: { by: FactGroup; key: string } | undefined): SelectionState {
	const key = group ? `${group.by}\u0000${group.key}` : "";
	let selection = analysis.selections.get(key);
	if (!selection) {
		const matches = (attempt: Attempt) => (group ? attemptInGroup(attempt, group) : true);
		selection = selectionState(analysis.attempts.filter(matches), matches);
		analysis.selections.set(key, selection);
	}
	return selection;
}

function unreadableAncestors(source: SessionSource): number {
	let count = 0;
	for (let node: SessionSource | null = source, depth = 0; node && depth < 128; depth += 1) {
		if (node.parent && !node.parent.source) count += 1;
		node = node.parent?.source ?? null;
	}
	return count;
}

// ---- selection ----

const invoked = (attempt: Attempt) => attempt.settled !== null && attempt.settled.disposition !== "never_sent";
function modelKey(target: CallSettled["target"]): string {
	const model = target.reportedModel.kind === "measured" ? target.reportedModel.value : target.requestedModel;
	return `${target.targetId}/${model}`;
}
function runModelKey(run: Run): string {
	const target = run.fold.aggregate?.target ?? run.attempts[0]?.settled?.target ?? run.attempts[0]?.started.target;
	return target ? modelKey(target) : "unknown/unknown";
}
/**
 * A cache break re-prefilled what the cache had served past the shared band: more than 1,024 tokens and a tenth of the
 * previous request's prefix, which is what this call read plus what it prefilled again. A server whose usage omits
 * its read but whose timings measured the uncached prefill read the prompt less that prefill. An unknown re-prefill
 * breaks on a call whose verdict says the cache missed. `partial` also labels an ordinary call that appended a tool
 * result to a warm prefix, and the band absorbs the tokens such an append loses at cache boundaries (#423, #434).
 */
function isBreak(attempt: Attempt): boolean {
	const settled = attempt.settled;
	if (!settled || settled.disposition === "never_sent") return false;
	const re = settled.cache.rePrefilledTokens;
	if (re.kind === "measured" || re.kind === "estimated") {
		const known = (fact: Fact<number> | undefined) =>
			fact && (fact.kind === "measured" || fact.kind === "estimated") ? fact.value : null;
		const prompt = known(settled.usage?.input);
		const uncached = known(settled.cache.uncachedPrefillTokens);
		const served =
			known(settled.usage?.cacheRead) ?? (prompt !== null && uncached !== null ? Math.max(0, prompt - uncached) : 0);
		return cacheBreakLoss(re.value, served + re.value);
	}
	return re.kind === "unknown" && (settled.cache.verdict === "cold" || settled.cache.verdict === "partial");
}
function coldKeys(attempt: Attempt): string[] {
	const reasons = attempt.settled?.cache.expectedColdReasons ?? [];
	return reasons.length > 0 ? [...new Set(reasons)] : ["unattributed"];
}

function attemptInGroup(attempt: Attempt, group: { by: FactGroup; key: string }): boolean {
	const settled = attempt.settled;
	switch (group.by) {
		case "label":
			return attempt.started.label === group.key;
		case "model":
			return modelKey(settled?.target ?? attempt.started.target) === group.key;
		case "turn":
			return (attempt.ctx?.turnId ?? "-") === group.key;
		case "cause":
			return settled?.stop.failure === group.key;
		case "wait":
			return settled?.stages.admission?.waitedOn === group.key;
		case "cold":
			return isBreak(attempt) && coldKeys(attempt).includes(group.key);
		case "run":
			return false;
	}
}
function runInGroup(run: Run, group: { by: FactGroup; key: string }): boolean {
	switch (group.by) {
		case "label":
			return group.key === "worker";
		case "model":
			return runModelKey(run) === group.key;
		case "turn":
			return (run.turnId ?? "-") === group.key;
		case "run":
			return run.runId === group.key;
		default:
			return false;
	}
}

interface Part {
	attempts?: Attempt[];
	/** The running fold `attempts` belong to, when the selection keeps one. */
	selection?: SelectionState;
	run?: Run;
	gap: number;
}
interface Selection {
	parts: Part[];
	attempt?: Attempt;
	describe: string;
}

type View = { session: SessionSource } | { run: Run } | { repo: RepoSource } | { process: Run };
/** An absent run journal is already one unknown contribution; a damaged one adds its own. */
const runGap = (run: Run) => (run.source.present ? run.gap : 0);

function select(view: View, ref: ParsedFactRef): Selection | null {
	const group = ref.group;
	if ("repo" in view)
		return (ref.scope === "repo" || ref.scope === "own" || ref.scope === "runs") &&
			view.repo.owner === ref.owner &&
			!ref.attemptId
			? selectRepo(view.repo, group, ref.scope)
			: null;
	if (ref.scope === "repo") return null;
	// A process journal folds as a run's does: its calls are whole attempts with no session to split them by (#434).
	if ("process" in view || ref.scope === "process") {
		if (!("process" in view) || ref.scope !== "process" || view.process.runId !== ref.owner) return null;
		const owned = view.process;
		if (ref.attemptId) {
			const attempt = owned.byAttempt.get(ref.attemptId);
			return attempt ? { parts: [{ attempts: [attempt], gap: 0 }], attempt, describe: "one process attempt" } : null;
		}
		const attempts = group ? owned.attempts.filter((attempt) => attemptInGroup(attempt, group)) : owned.attempts;
		return {
			parts: [{ attempts, gap: owned.gap }],
			describe: `the process journal's attempts${group ? ` where ${group.by}=${group.key}` : ""}`,
		};
	}
	if (ref.scope === "run") {
		const run =
			"run" in view ? (view.run.runId === ref.owner ? view.run : undefined) : analyze(view.session).runs.get(ref.owner);
		if (!run) return null;
		if (ref.attemptId) {
			const attempt = run.byAttempt.get(ref.attemptId);
			return attempt ? { parts: [{ attempts: [attempt], gap: 0 }], attempt, describe: "one run attempt" } : null;
		}
		if (!group || (group.by === "label" && group.key === "worker"))
			return { parts: [{ run, gap: runGap(run) }], describe: "the run's journal fold (calls, or its reported aggregate)" };
		// An aggregate-only run cannot be split by group; its share stays unknown (#434).
		const aggregate = run.fold.source === "calls" ? 0 : 1;
		return {
			parts: [{ attempts: run.attempts.filter((attempt) => attemptInGroup(attempt, group)), gap: run.gap + aggregate }],
			describe: `the run's attempts where ${group.by}=${group.key}`,
		};
	}
	if ("run" in view) return null;
	if (view.session.sessionId !== ref.owner) return null;
	const analysis = ref.scope === "lineage" ? analyzeLineage(view.session) : analyze(view.session);
	if (ref.attemptId) {
		if (ref.scope !== "own") return null;
		const attempt = analysis.byAttempt.get(ref.attemptId);
		return attempt ? { parts: [{ attempts: [attempt], gap: 0 }], attempt, describe: "one attempt" } : null;
	}
	const parts: Part[] = [];
	const described: string[] = [];
	if (ref.scope !== "runs") {
		const selection = selectionOf(analysis, group);
		parts.push({ attempts: selection.members, selection, gap: analysis.gap });
		described.push(`${ref.scope === "lineage" ? "the lineage's" : "the session's own"} attempts`);
	}
	if (ref.scope !== "own") {
		const runs = [...analysis.runs.values()].filter((run) => !group || runInGroup(run, group));
		for (const run of runs) parts.push({ run, gap: runGap(run) });
		described.push("each referenced run's journal fold");
	}
	return {
		parts,
		describe: `${described.join(" + ")}${group ? ` where ${group.by}=${group.key}` : ""}`,
	};
}

/**
 * Each session's own attempts and its runs, a run two sessions reference counted once, then the scope's own runs.
 * `own` keeps only the sessions' attempts and `runs` only the runs, the window's session and worker audiences.
 */
function selectRepo(
	repo: RepoSource,
	group: { by: FactGroup; key: string } | undefined,
	scope: "repo" | "own" | "runs",
): Selection {
	const parts: Part[] = [];
	const counted = new Set<string>();
	const addRun = (run: Run) => {
		if (scope === "own" || counted.has(run.runId)) return;
		counted.add(run.runId);
		if (!group || runInGroup(run, group)) parts.push({ run, gap: runGap(run) });
	};
	for (const session of repo.sessions) {
		const analysis = analyze(session);
		if (scope !== "runs") {
			const selection = selectionOf(analysis, group);
			parts.push({ attempts: selection.members, selection, gap: analysis.gap });
		}
		for (const run of analysis.runs.values()) addRun(run);
	}
	if (scope !== "own")
		for (const [runId, source] of [...repo.runs].sort(([a], [b]) => a.localeCompare(b)))
			addRun(analyzeRun(runId, source));
	const described = [
		...(scope !== "runs" ? [`${renderCount(repo.sessions.length)} sessions' attempts`] : []),
		...(scope !== "own" ? ["each run's journal fold"] : []),
	];
	return { parts, describe: `${described.join(" + ")}${group ? ` where ${group.by}=${group.key}` : ""}` };
}

// ---- measurement ----

type Family = "count" | "usd" | "duration";
const FAMILY: Record<FactMetric, Family> = {
	calls: "count",
	attempts: "count",
	neverSent: "count",
	sentUnsettled: "count",
	settledNoUsage: "count",
	settled: "count",
	incomplete: "count",
	input: "count",
	output: "count",
	cacheRead: "count",
	cacheWrite: "count",
	cacheWrite1h: "count",
	reasoning: "count",
	prompt: "count",
	total: "count",
	usd: "usd",
	apiCalls: "count",
	missingTokenCalls: "count",
	ttft: "duration",
	modelTime: "duration",
	settle: "duration",
	admissionWait: "duration",
	requestBytes: "count",
	websocketFailures: "count",
	sseFallbacks: "count",
	rePrefilled: "count",
	uncachedPrefill: "count",
	breakUsd: "usd",
	repairRounds: "count",
	runs: "count",
	harnessTime: "duration",
	networkTime: "duration",
	toolTime: "duration",
	bookkeepingRounds: "count",
	roundTripTax: "count",
};
const RULES: Record<FactMetric, string> = {
	calls: "count(distinct callId); a run contributes its API calls",
	attempts: "count(attempts)",
	neverSent: "count(attempts where disposition=never_sent)",
	sentUnsettled: "count(attempts where disposition=sent_unsettled)",
	settledNoUsage: "count(attempts where disposition=settled_no_usage)",
	settled: "count(attempts where disposition=settled)",
	incomplete: "count(attempts with no trustworthy settlement)",
	input: "sum(usage.input)",
	output: "sum(usage.output), reasoning included",
	cacheRead: "sum(usage.cacheRead)",
	cacheWrite: "sum(usage.cacheWrite)",
	cacheWrite1h: "sum(usage.cacheWrite1h), a cacheWrite subfield",
	reasoning: "sum(usage.reasoning), already inside output",
	prompt: "sum(usage.input + usage.cacheRead + usage.cacheWrite)",
	total: "sum(usage.total where reported, else input + cacheRead + cacheWrite + output)",
	usd: "sum(pricing.usd)",
	apiCalls: "count(attempts that reached the provider)",
	missingTokenCalls: "count(sent attempts whose token usage is unknown)",
	ttft: "stages.firstToken − stages.send.end, per attempt",
	modelTime: "stages.settle − stages.firstToken, per attempt",
	settle: "stages.settle, per attempt",
	admissionWait: "stages.admission.end − stages.admission.start, per attempt",
	requestBytes: "transport.requestBytes",
	websocketFailures: "transport.websocketFailures, where the call's connection counters were attributable",
	sseFallbacks: "transport.sseFallbacks, where the call's connection counters were attributable",
	rePrefilled: "cache.rePrefilledTokens",
	uncachedPrefill: "cache.uncachedPrefillTokens",
	breakUsd: "rePrefilledTokens × (input rate − cache-read rate), as each call records it",
	repairRounds: "run.settled.repairRounds",
	runs: "count(referenced runs)",
	harnessTime:
		"stages.send.start − (stages.admission.end − stages.admission.start): the harness's own work before sending",
	networkTime: "(stages.connect.end − stages.connect.start) + (stages.firstByte − stages.send.end)",
	toolTime: "sum(tool.settled.durationMs) over the tools the call asked for, approval parks excluded",
	bookkeepingRounds: `count(main attempts whose every tool was ${[...BOOKKEEPING_TOOLS].join(" or ")})`,
	roundTripTax: `sum(prompt tokens of main attempts whose every tool was ${[...BOOKKEEPING_TOOLS].join(" or ")})`,
};
const USAGE_FIELDS = new Set<FactMetric>(["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning"]);
/** Metrics one attempt states as a single fact; the rest are folds even over one attempt (prompt, total, counts). */
const ATTEMPT_FACTS = new Set<FactMetric>([
	...USAGE_FIELDS,
	"usd",
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
	"harnessTime",
	"networkTime",
	"toolTime",
	"bookkeepingRounds",
	"roundTripTax",
]);

/** One attempt's own fact for a per-attempt metric; never_sent reached nothing, so it is not applicable (R2). */
function attemptFact(attempt: Attempt, metric: FactMetric): Fact<number> {
	const settled = attempt.settled;
	if (metric === "admissionWait") {
		const admission = settled?.stages.admission;
		return admission ? localClock(admission.end - admission.start) : unobserved;
	}
	if (settled?.disposition === "never_sent") return notApplicable;
	if (!settled) return unobserved;
	if (USAGE_FIELDS.has(metric)) return settled.usage?.[metric as keyof CallUsage] ?? unobserved;
	const stages = settled.stages;
	const noFirstToken = settled.disposition === "settled" ? unobserved : notApplicable;
	switch (metric) {
		case "usd":
			return settled.pricing.usd;
		case "ttft":
			if (stages.settle === null || !stages.send) return unobserved;
			return stages.firstToken === undefined ? noFirstToken : localClock(Math.max(0, stages.firstToken - stages.send.end));
		case "modelTime":
			if (stages.settle === null) return unobserved;
			return stages.firstToken === undefined ? noFirstToken : localClock(Math.max(0, stages.settle - stages.firstToken));
		case "settle":
			return stages.settle === null ? unobserved : localClock(stages.settle);
		case "requestBytes":
			return settled.transport.requestBytes;
		case "websocketFailures":
			return settled.transport.websocketFailures ?? unobserved;
		case "sseFallbacks":
			return settled.transport.sseFallbacks ?? unobserved;
		case "rePrefilled":
			return settled.cache.rePrefilledTokens;
		case "uncachedPrefill":
			return settled.cache.uncachedPrefillTokens;
		case "breakUsd":
			// Fixed at settle from the call's own rates; a call settled before cache physics has none (#434 P2.4).
			return settled.cache.bill?.usd ?? unobserved;
		case "harnessTime": {
			if (!stages.send) return unobserved;
			const held = stages.admission ? stages.admission.end - stages.admission.start : 0;
			return localClock(Math.max(0, stages.send.start - held));
		}
		case "networkTime":
			// Pi owns the provider socket, so a call that recorded no connect span cannot split network from the wait for
			// the model (option B, #434).
			if (!stages.connect || stages.firstByte === undefined || !stages.send)
				return { kind: "unknown", reason: "unsupported" };
			return localClock(stages.connect.end - stages.connect.start + Math.max(0, stages.firstByte - stages.send.end));
		case "toolTime":
			if (settled.stop.reason !== "toolUse") return localClock(0);
			return attempt.tools ? localClock(attempt.tools.durationMs) : unobserved;
		case "bookkeepingRounds":
		case "roundTripTax":
			return roundTrip(attempt, metric);
		default:
			return unobserved;
	}
}

/**
 * A main-loop round whose every tool was bookkeeping re-read its whole context for no work on the task (#434 §12.4).
 * A round that asked for no tool is no such round; one whose tools went unrecorded is unknown.
 */
function roundTrip(attempt: Attempt, metric: "bookkeepingRounds" | "roundTripTax"): Fact<number> {
	const settled = attempt.settled;
	if (attempt.started.label !== "main" || !settled) return notApplicable;
	if (settled.stop.reason !== "toolUse") return localCount(0);
	if (!attempt.tools) return unobserved;
	if (!attempt.tools.bookkeepingOnly) return localCount(0);
	if (metric === "bookkeepingRounds") return localCount(1);
	const totals = emptyCallTotals();
	addCallTotals(totals, settled);
	const prompt = totals.promptTokens;
	if (prompt.unknownCount > 0) return unobserved;
	if (prompt.coverage.estimated === 0) return { kind: "measured", value: prompt.measured, source: "provider" };
	// The prompt is estimated by the method its estimated counts name (R3).
	const usage = settled.usage;
	const method = [usage?.input, usage?.cacheRead, usage?.cacheWrite].find((fact) => fact?.kind === "estimated");
	return method?.kind === "estimated"
		? { kind: "estimated", value: prompt.measured + prompt.estimated, method: method.method }
		: unobserved;
}

function attemptsSum(attempts: readonly Attempt[], metric: FactMetric): FactSum {
	return callSum(
		() => foldCalls(attempts),
		metric,
		() => foldCalls(attempts.filter(invoked)).totalTokens.unknownCount,
		() => foldFacts(attempts.map((attempt) => attemptFact(attempt, metric))),
	);
}

function selectionSum(selection: SelectionState, metric: FactMetric): FactSum {
	return callSum(
		() => selectionTotals(selection),
		metric,
		() => selection.missing,
		() => selectionFacts(selection, metric),
	);
}

function callSum(totals: () => CallTotals, metric: FactMetric, missing: () => number, facts: () => FactSum): FactSum {
	switch (metric) {
		case "calls":
			return counted(totals().logicalCalls);
		case "attempts":
			return counted(totals().attempts);
		case "neverSent":
		case "sentUnsettled":
		case "settledNoUsage":
		case "settled":
		case "incomplete":
			return counted(totals()[metric]);
		case "input":
		case "output":
		case "cacheRead":
		case "cacheWrite":
		case "cacheWrite1h":
		case "reasoning":
			return totals().usage[metric];
		case "prompt":
			return totals().promptTokens;
		case "total":
			return totals().totalTokens;
		case "usd":
			return totals().usd;
		case "apiCalls": {
			const all = totals();
			return counted(all.settled + all.settledNoUsage + all.sentUnsettled);
		}
		case "missingTokenCalls":
			return counted(missing());
		case "runs":
			return counted(0);
		case "repairRounds":
			return foldFacts([]);
		default:
			return facts();
	}
}

function runSum(run: Run, metric: FactMetric): FactSum {
	if (!run.source.present) return unknownSum(1);
	const fold = run.fold;
	const aggregateOnly = fold.source !== "calls";
	const counts = (value: number) => (aggregateOnly ? sumFactSums([counted(value), unknownSum(1)]) : counted(value));
	switch (metric) {
		case "input":
		case "output":
		case "cacheRead":
		case "cacheWrite":
		case "cacheWrite1h":
		case "reasoning":
			return fold.usage[metric];
		case "prompt":
			return aggregateOnly ? unknownSum(1) : fold.calls.totals.promptTokens;
		case "total":
			return fold.totalTokens;
		case "usd":
			return fold.usd;
		case "calls":
		case "apiCalls":
			return fold.apiCalls;
		case "missingTokenCalls":
			return fold.missingTokenCalls;
		case "attempts":
			return counts(fold.calls.totals.attempts);
		case "neverSent":
		case "sentUnsettled":
		case "settledNoUsage":
		case "settled":
		case "incomplete":
			return counts(fold.calls.totals[metric]);
		case "runs":
			return counted(1);
		case "repairRounds":
			return run.settled ? foldFacts([run.settled.data.repairRounds]) : unknownSum(1);
		default:
			return foldFacts(run.attempts.map((attempt) => attemptFact(attempt, metric)));
	}
}

function withGap(sum: FactSum, gap: number): FactSum {
	return gap > 0 ? sumFactSums([sum, unknownSum(gap)]) : sum;
}

/** A free price is a measured local zero; one priced contribution elsewhere makes the claim a dollar claim. */
function allFree(parts: readonly Part[]): boolean {
	let any = false;
	for (const part of parts) {
		if (part.run) {
			if (!part.run.source.present) return false;
			if (part.run.fold.allKnownFree) any = true;
			else if (
				part.run.fold.usd.coverage.measured + part.run.fold.usd.coverage.estimated + part.run.fold.usd.unknownCount >
				0
			)
				return false;
		}
		if (part.selection) {
			const counts = part.selection.pricedBy;
			const free = counts.free;
			if (counts.provider + counts["target-rates"] + counts.catalog + counts.none > 0) return false;
			if (free > 0) any = true;
			continue;
		}
		for (const attempt of part.attempts ?? []) {
			if (!invoked(attempt)) continue;
			if (attempt.settled?.pricing.pricedBy !== "free") return false;
			any = true;
		}
	}
	return any;
}

function display(metric: FactMetric, fact: Fact<number> | FactSum, free: boolean, pricedBy = "none"): string {
	const family = FAMILY[metric];
	if ("kind" in fact) {
		if (family === "usd") return renderUsdFact(fact, pricedBy);
		return renderFact(fact, family === "duration" ? "duration" : "count");
	}
	if (family === "usd") return renderUsdSum(fact, free);
	if (family === "duration") return renderDurationSum(fact);
	return renderCountSum(fact);
}

interface Measurement {
	quantity: Quantity;
	selection: Selection;
}

function measure(view: View, ref: ParsedFactRef): Measurement | null {
	const selection = select(view, ref);
	if (!selection) return null;
	const encoded = factRef(ref);
	const attempt = selection.attempt;
	if (attempt) {
		const metric = ref.metric;
		const fact: Fact<number> | FactSum = ATTEMPT_FACTS.has(metric)
			? attemptFact(attempt, metric)
			: attemptsSum([attempt], metric);
		// A cache-break bill names the rates it was priced by, which a free call's local zero depends on.
		const pricedBy = (metric === "breakUsd" ? attempt.settled?.cache.bill : attempt.settled?.pricing)?.pricedBy;
		return {
			quantity: { fact, display: display(metric, fact, pricedBy === "free", pricedBy), ref: encoded },
			selection,
		};
	}
	const sums = selection.parts.map((part) => partSum(part, ref.metric));
	const fact = sums.length === 1 && sums[0] ? sums[0] : sumFactSums(sums);
	return { quantity: { fact, display: display(ref.metric, fact, allFree(selection.parts)), ref: encoded }, selection };
}

function partSum(part: Part, metric: FactMetric): FactSum {
	return withGap(
		part.run
			? runSum(part.run, metric)
			: part.selection
				? selectionSum(part.selection, metric)
				: attemptsSum(part.attempts ?? [], metric),
		part.gap,
	);
}

/** Several turns read as one; see {@link turnsSum}. */
export interface TurnsSum {
	fact: FactSum;
	display: string;
	/** Every priced call among the turns was free, which the cost display's free claim rests on. */
	free: boolean;
}

/**
 * Several of a session's operator turns read as one, such as the turns one ACP prompt ran: each turn's own attempts
 * and the runs it referenced, the session's read gap counted once. One turn sums exactly as its `@turn=` quantity
 * does. No ref names a set of turns, so the sum carries its fact and display without one (#434 §11.3).
 */
export function turnsSum(source: SessionSource, turnIds: readonly string[], metric: FactMetric): TurnsSum {
	const analysis = analyze(source);
	const keys = new Set(turnIds);
	const parts: Part[] = [];
	for (const key of keys) {
		const selection = selectionOf(analysis, { by: "turn", key });
		parts.push({ attempts: selection.members, selection, gap: 0 });
	}
	for (const run of analysis.runs.values()) if (keys.has(run.turnId ?? "-")) parts.push({ run, gap: runGap(run) });
	const fact = withGap(sumFactSums(parts.map((part) => partSum(part, metric))), keys.size > 0 ? analysis.gap : 0);
	const free = allFree(parts);
	return { fact, display: display(metric, fact, free), free };
}

function quantity(view: View, ref: ParsedFactRef): Quantity {
	const measured = measure(view, ref);
	if (!measured) throw new Error(`read model cannot resolve its own reference ${factRef(ref)}`);
	return measured.quantity;
}

// ---- DTO builders ----

const own = (sessionId: string, metric: FactMetric, extra: Partial<ParsedFactRef> = {}): ParsedFactRef => ({
	scope: "own",
	owner: sessionId,
	metric,
	...extra,
});

function textFact(fact: Fact<string | boolean | null>) {
	return { fact, display: renderTextFact(fact) };
}

function tokenQuantities(view: View, base: Omit<ParsedFactRef, "metric">) {
	const q = (metric: FactMetric) => quantity(view, { ...base, metric });
	return {
		input: q("input"),
		output: q("output"),
		cacheRead: q("cacheRead"),
		cacheWrite: q("cacheWrite"),
		cacheWrite1h: q("cacheWrite1h"),
		reasoning: q("reasoning"),
		prompt: q("prompt"),
		total: q("total"),
	};
}

function callCounts(view: View, base: Omit<ParsedFactRef, "metric">) {
	const q = (metric: FactMetric) => quantity(view, { ...base, metric });
	return {
		calls: q("calls"),
		attempts: q("attempts"),
		dispositions: {
			neverSent: q("neverSent"),
			sentUnsettled: q("sentUnsettled"),
			settledNoUsage: q("settledNoUsage"),
			settled: q("settled"),
			incomplete: q("incomplete"),
		},
	};
}

function pricedByCounts(parts: readonly Part[]): Record<PricedBy, number> {
	const counts = noPricing();
	for (const part of parts) {
		if (part.selection)
			for (const [by, count] of Object.entries(part.selection.pricedBy)) counts[by as PricedBy] += count;
		else
			for (const attempt of part.attempts ?? [])
				if (invoked(attempt) && attempt.settled) counts[attempt.settled.pricing.pricedBy] += 1;
		if (part.run) {
			for (const attempt of part.run.attempts)
				if (invoked(attempt) && attempt.settled) counts[attempt.settled.pricing.pricedBy] += 1;
			if (part.run.fold.aggregate) counts[part.run.fold.aggregate.pricing.pricedBy] += 1;
		}
	}
	return counts;
}

function journalCoverage(source: JournalSource, fold: Pick<JournalFold, "coverage">) {
	return {
		present: source.present,
		seeding: source.seeding === true,
		records: source.records.length,
		skipped: source.skipped,
		damaged: source.damaged,
		gapRecords: fold.coverage.gapRecords,
		droppedRecords: fold.coverage.droppedRecords,
		duplicateRecords: fold.coverage.duplicateRecords,
		conflictingAttempts: fold.coverage.conflictingAttempts,
	};
}

function runRow(view: View, run: Run): RunRowV1 {
	const ref = (metric: FactMetric): ParsedFactRef => ({ scope: "run", owner: run.runId, metric });
	return {
		runId: run.runId,
		sessionId: run.sessionId,
		turnId: run.turnId,
		firstAt: run.firstAt,
		lastAt: run.lastAt,
		terminalReason: run.settled?.data.terminalReason ?? null,
		source: run.source.present ? run.fold.source : "unavailable",
		apiCalls: quantity(view, ref("apiCalls")),
		tokens: quantity(view, ref("total")),
		usd: quantity(view, ref("usd")),
	};
}

export function sessionTelemetry(source: SessionSource, options: ReadOptions = {}): SessionTelemetryV1 {
	const view: View = { session: source };
	const analysis = analyze(source);
	const id = source.sessionId;
	const ownSelection = select(view, own(id, "usd"));
	let firstAt: string | null = null;
	let lastAt: string | null = null;
	for (const record of source.journal.records) {
		if (firstAt === null || record.t < firstAt) firstAt = record.t;
		if (lastAt === null || record.t > lastAt) lastAt = record.t;
	}
	const labels = new Set(analysis.attempts.map((attempt) => attempt.started.label));
	if (analysis.runs.size > 0) labels.add("worker");
	let latest: Attempt | null = null;
	for (const attempt of analysis.attempts)
		if (
			attempt.started.label === "main" &&
			invoked(attempt) &&
			attempt.settledAt !== null &&
			(!latest || attempt.settledAt >= (latest.settledAt ?? ""))
		)
			latest = attempt;
	const session = (metric: FactMetric, extra: Partial<ParsedFactRef> = {}) =>
		quantity(view, { scope: "session", owner: id, metric, ...extra });
	const mainLoop = (metric: FactMetric) => quantity(view, own(id, metric, { group: { by: "label", key: "main" } }));
	return {
		...header(options),
		kind: "session",
		sessionId: id,
		modes: [...new Set(source.journal.modes)],
		journal: journalCoverage(source.journal, analysis.fold),
		lifetime: { firstRecordAt: firstAt, lastRecordAt: lastAt, ...lifecycle(source, options) },
		lineage: source.parent
			? {
					parent: { sessionId: source.parent.sessionId, turnId: source.parent.turnId, at: source.parent.at },
					totals: {
						tokens: quantity(view, { scope: "lineage", owner: id, metric: "total" }),
						usd: quantity(view, { scope: "lineage", owner: id, metric: "usd" }),
					},
					unreadableAncestors: unreadableAncestors(source),
				}
			: { parent: null, totals: null, unreadableAncestors: 0 },
		own: {
			counts: callCounts(view, { scope: "own", owner: id }),
			tokens: tokenQuantities(view, { scope: "own", owner: id }),
			cost: { usd: quantity(view, own(id, "usd")), pricedBy: pricedByCounts(ownSelection?.parts ?? []) },
		},
		byLabel: [...labels].sort().map((label) => ({
			label,
			calls: session("calls", { group: { by: "label", key: label } }),
			tokens: session("total", { group: { by: "label", key: label } }),
			usd: session("usd", { group: { by: "label", key: label } }),
		})),
		runs: {
			count: analysis.runs.size,
			unresolved: [...analysis.runs.values()].filter((run) => !run.source.present).length,
			apiCalls: quantity(view, { scope: "runs", owner: id, metric: "apiCalls" }),
			tokens: quantity(view, { scope: "runs", owner: id, metric: "total" }),
			usd: quantity(view, { scope: "runs", owner: id, metric: "usd" }),
		},
		totals: { tokens: session("total"), usd: session("usd") },
		overhead: {
			harness: mainLoop("harnessTime"),
			network: mainLoop("networkTime"),
			model: mainLoop("modelTime"),
			tool: mainLoop("toolTime"),
			bookkeepingRounds: mainLoop("bookkeepingRounds"),
			roundTripTax: mainLoop("roundTripTax"),
			prompt: mainLoop("prompt"),
		},
		transport: latest?.settled
			? {
					attemptId: latest.started.attemptId,
					at: latest.settledAt ?? latest.startedAt,
					kind: latest.settled.transport.kind,
					continuation: textFact(latest.settled.transport.continuation),
					sessionPinnedToSse: textFact(latest.settled.transport.sessionPinnedToSse),
					pinReason: latest.settled.transport.pinReason ?? null,
					recovery: latest.settled.transport.recovery ?? null,
					websocketFailures: quantity(view, own(id, "websocketFailures", { group: { by: "label", key: "main" } })),
					sseFallbacks: quantity(view, own(id, "sseFallbacks", { group: { by: "label", key: "main" } })),
				}
			: null,
	};
}

/**
 * Closed when the journal's latest lifecycle record is a close, or the ledger's close postdates the journal's latest
 * open or resume. Otherwise the session's owner decides: the ledger's, else the journal's last segment writer (#434
 * §6.1).
 */
function lifecycle(
	source: SessionSource,
	options: ReadOptions,
): Pick<SessionTelemetryV1["lifetime"], "state" | "closed"> {
	let latest: Extract<TelemetryRecord, { k: "session.opened" | "session.resumed" | "session.closed" }> | null = null;
	for (const record of source.journal.records)
		if (
			(record.k === "session.opened" || record.k === "session.resumed" || record.k === "session.closed") &&
			(!latest || record.t >= latest.t)
		)
			latest = record;
	if (latest?.k === "session.closed") return { state: "closed", closed: { at: latest.t, reason: latest.data.reason } };
	const ledger = source.ledger;
	// Every reopen clears endedAt on disk before the reopened process writes, so a set endedAt is a close. Facts dated
	// after it are late writes, such as health windows on a writer idling after `/new` or a background call settling;
	// only a journal open or resume says the session reopened.
	if (ledger?.endedAt && (latest === null || ledger.endedAt >= latest.t))
		return { state: "closed", closed: { at: ledger.endedAt, reason: null } };
	// The ledger restamps its owner on every reopen, before a new writer may have written anything.
	const writer = ledger?.owner ?? source.journal.writer ?? null;
	if (!writer) return { state: "unknown", closed: null };
	const alive = (options.alive ?? processIdentityAlive)(writer);
	return { state: alive === null ? "unverifiable" : alive ? "open" : "ended-abnormally", closed: null };
}

function callRow(view: View, scope: "own" | "run", owner: string, attempt: Attempt): CallRowV1 {
	const settled = attempt.settled;
	const target = settled?.target ?? attempt.started.target;
	const q = (metric: FactMetric) => quantity(view, { scope, owner, attemptId: attempt.started.attemptId, metric });
	const toolChoice = attempt.started.toolChoice;
	return {
		callId: attempt.started.callId as CallRowV1["callId"],
		attemptId: attempt.started.attemptId as CallRowV1["attemptId"],
		attempt: attempt.started.attempt,
		label: attempt.started.label,
		owner: {
			sessionId: attempt.ctx?.sessionId ?? null,
			...(attempt.ctx?.runId !== undefined ? { runId: attempt.ctx.runId } : {}),
			...(attempt.ctx?.turnId !== undefined ? { turnId: attempt.ctx.turnId } : {}),
		},
		startedAt: attempt.startedAt,
		settledAt: attempt.settledAt,
		target: {
			targetId: target.targetId,
			runtimeId: target.runtimeId,
			api: target.api,
			requestedModel: target.requestedModel,
			reportedModel: textFact(target.reportedModel),
		},
		roundKind: attempt.started.roundKind,
		toolChoice: typeof toolChoice === "string" ? toolChoice : `tool:${toolChoice.name}`,
		disposition: settled?.disposition ?? "incomplete",
		stop: settled ? settled.stop : null,
		usage:
			settled?.disposition === "never_sent"
				? null
				: tokenQuantities(view, { scope, owner, attemptId: attempt.started.attemptId }),
		usd: q("usd"),
		pricedBy: settled?.pricing.pricedBy ?? "none",
		stages: settled?.stages ?? null,
		timing: {
			ttft: q("ttft"),
			modelTime: q("modelTime"),
			settle: q("settle"),
			admissionWait: q("admissionWait"),
			harness: q("harnessTime"),
			network: q("networkTime"),
			tool: q("toolTime"),
		},
		admission: settled?.stages.admission?.waitedOn ?? null,
		transport: {
			kind: settled?.transport.kind ?? "unknown",
			continuation: textFact(settled?.transport.continuation ?? unobserved),
			requestBytes: q("requestBytes"),
			sessionPinnedToSse: textFact(settled?.transport.sessionPinnedToSse ?? unobserved),
			connectionReused: textFact(settled?.transport.connectionReused ?? unobserved),
			websocketFailures: q("websocketFailures"),
			sseFallbacks: q("sseFallbacks"),
			pinReason: settled?.transport.pinReason ?? null,
			recovery: settled?.transport.recovery ?? null,
		},
		cache: {
			verdict: settled?.cache.verdict ?? "unknown",
			expectedColdReasons: settled?.cache.expectedColdReasons ?? [],
			firstDivergentSection: textFact(settled?.cache.firstDivergentSection ?? unobserved),
			rePrefilled: q("rePrefilled"),
			uncachedPrefill: q("uncachedPrefill"),
			breakUsd: q("breakUsd"),
		},
		quota: settled?.quota ?? null,
		responseId: settled?.responseId ?? null,
	};
}

function matches(attempt: Attempt, filter: CallFilter): boolean {
	if (filter.labels && !filter.labels.includes(attempt.started.label)) return false;
	if (filter.dispositions && !filter.dispositions.includes(attempt.settled?.disposition ?? "incomplete")) return false;
	if (filter.turnIds && !filter.turnIds.includes(attempt.ctx?.turnId ?? "")) return false;
	if (filter.from && attempt.startedAt < filter.from) return false;
	if (filter.to && attempt.startedAt > filter.to) return false;
	return true;
}

/** A session's own attempts, or one referenced run's with `filter.runId`; `limit` keeps the newest rows. */
export function callsReport(source: SessionSource, filter: CallFilter = {}, options: ReadOptions = {}): CallsReportV1 {
	const view: View = { session: source };
	const analysis = analyze(source);
	const run = filter.runId === undefined ? undefined : analysis.runs.get(filter.runId);
	const attempts = (filter.runId === undefined ? analysis.attempts : (run?.attempts ?? [])).filter((attempt) =>
		matches(attempt, filter),
	);
	const shown = filter.limit === undefined ? attempts : attempts.slice(-filter.limit);
	return {
		...header(options),
		kind: "calls",
		sessionId: source.sessionId,
		runId: filter.runId ?? null,
		filter,
		calls: shown.map((attempt) =>
			run ? callRow(view, "run", run.runId, attempt) : callRow(view, "own", source.sessionId, attempt),
		),
		matched: attempts.length,
	};
}

export function runCallsReport(
	runId: string,
	source: JournalSource,
	filter: CallFilter = {},
	options: ReadOptions = {},
): CallsReportV1 {
	const run = analyzeRun(runId, source);
	const view: View = { run };
	const attempts = run.attempts.filter((attempt) => matches(attempt, filter));
	const shown = filter.limit === undefined ? attempts : attempts.slice(-filter.limit);
	return {
		...header(options),
		kind: "calls",
		sessionId: run.sessionId,
		runId,
		filter: { ...filter, runId },
		calls: shown.map((attempt) => callRow(view, "run", runId, attempt)),
		matched: attempts.length,
	};
}

type GroupBy = CostReportV1["groupBy"];
function groupKeys(runs: readonly Run[], attempts: readonly Attempt[], by: GroupBy): string[] {
	const keys = new Set<string>();
	for (const attempt of attempts)
		keys.add(
			by === "label"
				? attempt.started.label
				: by === "model"
					? modelKey(attempt.settled?.target ?? attempt.started.target)
					: (attempt.ctx?.turnId ?? "-"),
		);
	for (const run of runs) keys.add(by === "label" ? "worker" : by === "model" ? runModelKey(run) : (run.turnId ?? "-"));
	return [...keys].sort();
}

function costGroups(view: View, base: Omit<ParsedFactRef, "metric">, keys: readonly string[], by: GroupBy) {
	// A session or repository window splits into its own calls and its worker runs; one run is all worker spend.
	const split = by !== "label" && (base.scope === "session" || base.scope === "repo");
	return keys.map((key) => {
		const ref = (metric: FactMetric, scope = base.scope): ParsedFactRef => ({
			...base,
			scope,
			metric,
			group: { by, key },
		});
		const share = (scope: "own" | "runs") => ({
			calls: quantity(view, ref("calls", scope)),
			tokens: quantity(view, ref("total", scope)),
			usd: quantity(view, ref("usd", scope)),
		});
		return {
			key,
			calls: quantity(view, ref("calls")),
			tokens: quantity(view, ref("total")),
			usd: quantity(view, ref("usd")),
			pricedBy: pricedByCounts(select(view, ref("usd"))?.parts ?? []),
			audience: split ? { session: share("own"), worker: share("runs") } : null,
		};
	});
}

export function costReport(source: SessionSource, groupBy: GroupBy = "label", options: ReadOptions = {}): CostReportV1 {
	const view: View = { session: source };
	const analysis = analyze(source);
	const base = { scope: "session" as const, owner: source.sessionId };
	return {
		...header(options),
		kind: "cost",
		scope: { sessionId: source.sessionId },
		groupBy,
		total: {
			calls: quantity(view, { ...base, metric: "calls" }),
			tokens: quantity(view, { ...base, metric: "total" }),
			usd: quantity(view, { ...base, metric: "usd" }),
			pricedBy: pricedByCounts(select(view, { ...base, metric: "usd" })?.parts ?? []),
		},
		groups: costGroups(view, base, groupKeys([...analysis.runs.values()], analysis.attempts, groupBy), groupBy),
	};
}

/** One cost report across a repository's sessions and runs over a window (#434 §11.1); refs use the `repo` scope. */
export function repoCostReport(
	repo: RepoSource,
	scope: { repo: string; days: number },
	groupBy: GroupBy = "label",
	options: ReadOptions = {},
): CostReportV1 {
	const view: View = { repo };
	const base = { scope: "repo" as const, owner: repo.owner };
	const attempts = repo.sessions.flatMap((session) => analyze(session).attempts);
	const runs = new Map<string, Run>();
	for (const session of repo.sessions)
		for (const run of analyze(session).runs.values()) if (!runs.has(run.runId)) runs.set(run.runId, run);
	for (const [runId, source] of repo.runs) if (!runs.has(runId)) runs.set(runId, analyzeRun(runId, source));
	return {
		...header(options),
		kind: "cost",
		scope: { repo: scope.repo, days: scope.days },
		groupBy,
		total: {
			calls: quantity(view, { ...base, metric: "calls" }),
			tokens: quantity(view, { ...base, metric: "total" }),
			usd: quantity(view, { ...base, metric: "usd" }),
			pricedBy: pricedByCounts(select(view, { ...base, metric: "usd" })?.parts ?? []),
		},
		groups: costGroups(view, base, groupKeys([...runs.values()], attempts, groupBy), groupBy),
	};
}

/** One run's token field as a store with no journal fold records it: the count it holds, and whether it is whole. */
export interface RunTokenField {
	/** Null when the store holds no count for the field. */
	known: number | null;
	/** Some of the run's calls reported no usage, or the store cannot say whether any did. */
	partial: boolean;
}

/** A token field over many runs, each run one contribution (#434 §11.3). */
export interface RunsTotal {
	/** The known part. */
	known: number;
	/** Runs that left the field partial or unknown. */
	unknownRuns: number;
	display: string;
}

/**
 * A token field over runs the read model holds no journal fold for, such as the run ledger `fleet status` lists, where
 * reading every run journal costs seconds. A run that left the field partial or unknown counts once, so the total
 * renders as a lower bound beside the number of such runs, never as a sum that took an unknown run for zero.
 */
export function runsTotal(fields: readonly RunTokenField[]): RunsTotal {
	const sum = sumFactSums(
		fields.map((field) =>
			field.known === null
				? unknownSum(1)
				: field.partial
					? sumFactSums([counted(field.known), unknownSum(1)])
					: counted(field.known),
		),
	);
	return { known: sum.measured + sum.estimated, unknownRuns: sum.unknownCount, display: renderCountSum(sum, "run") };
}

/** One run's sealed cost as a store with no journal fold records it: its amount and the provenance it was sealed with. */
export interface RunCostField {
	/** Null when no receipt holds the run's cost. */
	usd: number | null;
	provenance: "known" | "known_free" | "estimated" | "unknown";
}

/**
 * A cost over runs the read model holds no journal fold for, each run one contribution, worded by the canonical
 * renderer: an estimated run marks the whole `~`, and a run nobody priced leaves it a lower bound (#434 §11.3).
 */
export function runsCost(fields: readonly RunCostField[]): { fact: FactSum; display: string } {
	const fact = foldFacts(
		fields.map((field): Fact<number> => {
			if (field.usd === null || !Number.isFinite(field.usd) || field.usd < 0 || field.provenance === "unknown")
				return unobserved;
			if (field.provenance === "estimated") return { kind: "estimated", value: field.usd, method: "catalog" };
			return { kind: "measured", value: field.provenance === "known_free" ? 0 : field.usd, source: "local-count" };
		}),
	);
	const free = fields.length > 0 && fields.every((field) => field.provenance === "known_free");
	return { fact, display: renderUsdSum(fact, free) };
}

/**
 * A finished run's token count as its terminal event or sealed receipt states it, worded with its call coverage: calls
 * that reported no usage make it a lower bound beside them, and a run that never recorded its coverage says so, so a
 * partly counted run never reads as whole (#434 §11.3).
 */
export function runTokenCount(
	tokens: number,
	coverage: { apiCalls?: number | undefined; missingTokenCalls?: number | undefined },
): { fact: FactSum; display: string } {
	const known = Number.isFinite(tokens) && tokens >= 0 ? tokens : 0;
	const missing = coverage.missingTokenCalls;
	if (missing === undefined || coverage.apiCalls === undefined)
		return {
			fact: sumFactSums([counted(known), unknownSum(1)]),
			display: `≥${renderCount(known)} (call coverage not recorded)`,
		};
	const fact = missing > 0 ? sumFactSums([counted(known), unknownSum(missing)]) : counted(known);
	return { fact, display: renderCountSum(fact, "call") };
}

/** A repository window's token fields: the session view's token quantities over the `repo` scope (#434 §11.1). */
/**
 * One quantity over a process journal: the calls its process made with no session or run, such as System One outside a
 * session or a startup warm (#434).
 */
export function processQuantity(processId: string, source: JournalSource, metric: FactMetric): Quantity {
	return quantity({ process: analyzeRun(processId, source) }, { scope: "process", owner: processId, metric });
}

export function repoTokenQuantities(repo: RepoSource): SessionTelemetryV1["own"]["tokens"] {
	return tokenQuantities({ repo }, { scope: "repo", owner: repo.owner });
}

export function runCostReport(
	runId: string,
	source: JournalSource,
	groupBy: GroupBy = "model",
	options: ReadOptions = {},
): CostReportV1 {
	const run = analyzeRun(runId, source);
	const view: View = { run };
	const base = { scope: "run" as const, owner: runId };
	const keys = new Set<string>();
	for (const attempt of run.attempts)
		keys.add(
			groupBy === "label"
				? attempt.started.label
				: groupBy === "model"
					? modelKey(attempt.settled?.target ?? attempt.started.target)
					: (attempt.ctx?.turnId ?? "-"),
		);
	return {
		...header(options),
		kind: "cost",
		scope: { runId },
		groupBy,
		total: {
			calls: quantity(view, { ...base, metric: "calls" }),
			tokens: quantity(view, { ...base, metric: "total" }),
			usd: quantity(view, { ...base, metric: "usd" }),
			pricedBy: pricedByCounts([{ run, gap: runGap(run) }]),
		},
		groups: costGroups(view, base, [...keys].sort(), groupBy),
	};
}

export function cacheReport(source: SessionSource, options: ReadOptions = {}): CacheReportV1 {
	const view: View = { session: source };
	const analysis = analyze(source);
	const id = source.sessionId;
	const verdicts = { hot: 0, partial: 0, cold: 0, small: 0, unknown: 0 };
	for (const attempt of analysis.attempts)
		if (invoked(attempt) && attempt.settled) verdicts[attempt.settled.cache.verdict] += 1;
	const breaks = analysis.attempts.filter(isBreak);
	const causes = [...new Set(breaks.flatMap(coldKeys))].sort();
	return {
		...header(options),
		kind: "cache",
		sessionId: id,
		verdicts,
		cacheRead: quantity(view, own(id, "cacheRead")),
		cacheWrite: quantity(view, own(id, "cacheWrite")),
		uncachedPrefill: quantity(view, own(id, "uncachedPrefill")),
		rePrefilled: quantity(view, own(id, "rePrefilled")),
		breakUsd: quantity(view, own(id, "breakUsd")),
		breaks: breaks.map((attempt) => {
			const q = (metric: FactMetric) => quantity(view, own(id, metric, { attemptId: attempt.started.attemptId }));
			return {
				callId: attempt.started.callId as CallRowV1["callId"],
				attemptId: attempt.started.attemptId as CallRowV1["attemptId"],
				at: attempt.settledAt ?? attempt.startedAt,
				verdict: attempt.settled?.cache.verdict ?? "unknown",
				expectedColdReasons: attempt.settled?.cache.expectedColdReasons ?? [],
				firstDivergentSection: textFact(attempt.settled?.cache.firstDivergentSection ?? unobserved),
				rePrefilled: q("rePrefilled"),
				uncachedPrefill: q("uncachedPrefill"),
				breakUsd: q("breakUsd"),
			};
		}),
		byCause: causes.map((cause) => ({
			cause,
			breaks: breaks.filter((attempt) => coldKeys(attempt).includes(cause)).length,
			rePrefilled: quantity(view, own(id, "rePrefilled", { group: { by: "cold", key: cause } })),
			breakUsd: quantity(view, own(id, "breakUsd", { group: { by: "cold", key: cause } })),
		})),
	};
}

type BudgetEntry = Extract<TimelineEntry, { kind: "budget" }>;
type QuotaEntry = Extract<TimelineEntry, { kind: "quota" }>;

/**
 * The spend admission saw at `t`, marked as the session's priced calls settled by then were: estimated when any was,
 * with every sent call it could not price beside it, as the cost tracker that fed admission words it (#434 §8).
 */
function spendAt(analysis: Analysis, usd: number, t: string): FactSum {
	let estimated = false;
	let unpriced = 0;
	const visit = (attempt: Attempt) => {
		if (!invoked(attempt) || !attempt.settled || attempt.settledAt === null || attempt.settledAt > t) return;
		const fact = attempt.settled.pricing.usd;
		if (fact.kind === "estimated") estimated = true;
		else if (fact.kind === "unknown") unpriced += 1;
	};
	for (const attempt of analysis.attempts) visit(attempt);
	for (const run of analysis.runs.values()) for (const attempt of run.attempts) visit(attempt);
	return {
		measured: estimated ? 0 : usd,
		estimated: estimated ? usd : 0,
		unknownCount: unpriced,
		absentCount: 0,
		coverage: { measured: estimated ? 0 : 1, estimated: estimated ? 1 : 0, unknown: unpriced },
	};
}

function budgetEntry(
	analysis: Analysis,
	record: Extract<TelemetryRecord, { k: "budget.crossed" | "budget.held" }>,
): BudgetEntry {
	const data = record.data;
	const wait = record.k === "budget.held" ? record.data : null;
	const waited = wait ? localClock(wait.waitedMs) : null;
	const spend = spendAt(analysis, data.spendUsd, record.t);
	// Admission's own estimate of what the held request re-sends; it names no method, so it reads `~`.
	const context = data.contextTokens === undefined ? null : estimatedSum(data.contextTokens);
	// Counted ahead of its settlement, so it is a projection and reads `~` (#434).
	const projected = data.projectedUsd === undefined ? null : estimatedSum(data.projectedUsd);
	return {
		kind: "budget",
		at: record.t,
		event: wait ? "wait" : "crossing",
		level: data.level,
		callId: (record.ctx.callId ?? null) as CallRowV1["callId"] | null,
		attemptId: (record.ctx.attemptId ?? null) as CallRowV1["attemptId"] | null,
		spend: { fact: spend, display: renderUsdSum(spend, false) },
		projected: projected ? { fact: projected, display: renderUsdSum(projected, false) } : null,
		ceiling: { usd: data.ceilingUsd, display: renderUsdLimit(data.ceilingUsd) },
		contextTokens: context ? { fact: context, display: renderCountSum(context) } : null,
		outcome: wait?.outcome ?? null,
		waited: waited ? { fact: waited, display: renderFact(waited, "duration") } : null,
		raisedTo:
			wait?.raisedToUsd === undefined ? null : { usd: wait.raisedToUsd, display: renderUsdLimit(wait.raisedToUsd) },
		raisedBy: wait?.raisedBy ?? null,
	};
}

function quotaEntry(record: Extract<TelemetryRecord, { k: "quota.read" }>): QuotaEntry {
	return {
		kind: "quota",
		at: record.t,
		provider: record.data.provider,
		targetId: record.data.targetId,
		source: record.data.source,
		observedAt: record.data.observedAt,
		limitReached: record.data.limitReached ?? null,
		windows: record.data.windows.map((window) => ({
			key: window.key,
			usedPct: { fact: window.usedPct, display: renderFact(window.usedPct, "percent") },
			resetsAt: window.resetsAt ?? null,
		})),
	};
}

type QuotaReading = Extract<TelemetryRecord, { k: "quota.read" }>["data"];
/** The account a reading names, as the process's own observations key it: Codex readings are per target. */
export const quotaAccount = (reading: QuotaReading): string =>
	reading.provider === "codex" ? `codex:${reading.targetId}` : reading.provider;

/** A provider reports a window's reset with drift between readings; a reset that moved further began a new window. */
const QUOTA_RESET_DRIFT_MS = 5 * 60_000;
function sameQuotaWindow(a: string | undefined, b: string | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	return Math.abs(Date.parse(a) - Date.parse(b)) <= QUOTA_RESET_DRIFT_MS;
}

export interface AccountQuota {
	reading: QuotaReading;
	/** Per window key, what the window gained since the account's previous reading of the same window. */
	consumed: ReadonlyMap<string, Fact<number>>;
}

/**
 * Each account's newest journaled reading and the window consumption between it and the reading before it (#434
 * §12.5, C2). Consumption is estimated, never measured: other devices draw from the same shared window, so the delta
 * is the account's, not this host's. A window whose reset moved, or whose share fell, restarted between the two
 * readings and has no delta.
 */
export function foldAccountQuota(records: readonly TelemetryRecord[]): Map<string, AccountQuota> {
	const byAccount = new Map<string, QuotaReading[]>();
	for (const record of records) {
		if (record.k !== "quota.read") continue;
		const account = quotaAccount(record.data);
		byAccount.set(account, [...(byAccount.get(account) ?? []), record.data]);
	}
	const folded = new Map<string, AccountQuota>();
	for (const [account, readings] of byAccount) {
		readings.sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0));
		const reading = readings.at(-1) as QuotaReading;
		const previous = readings.length > 1 ? readings.at(-2) : undefined;
		const consumed = new Map<string, Fact<number>>();
		for (const window of reading.windows) {
			const prior = previous?.windows.find((candidate) => candidate.key === window.key);
			if (prior?.usedPct.kind !== "measured" || window.usedPct.kind !== "measured") continue;
			if (!sameQuotaWindow(prior.resetsAt, window.resetsAt)) continue;
			const delta = window.usedPct.value - prior.usedPct.value;
			if (delta < 0) continue;
			consumed.set(window.key, {
				kind: "estimated",
				value: Math.round(delta * 1000) / 1000,
				method: "shared-account-window-delta",
			});
		}
		folded.set(account, { reading, consumed });
	}
	return folded;
}

function gapEntry(record: Extract<TelemetryRecord, { k: "journal.gap" }>): Extract<TimelineEntry, { kind: "gap" }> {
	const { sink, reason, count } = record.data;
	return { kind: "gap", at: record.t, sink, reason, count, countShown: shownCount(count) };
}

/** A count a record states, worded by the renderer. */
function shownCount(value: number): { fact: Fact<number>; display: string } {
	const fact = localCount(value);
	return { fact, display: renderFact(fact) };
}

/** A reading that says the account cannot send, or a window measured full. */
const quotaLimited = (entry: QuotaEntry) =>
	entry.limitReached === true ||
	entry.windows.some((window) => window.usedPct.fact.kind === "measured" && window.usedPct.fact.value >= 100);

export function timeline(
	source: SessionSource,
	range: { from: string; to: string } | null = null,
	options: ReadOptions = {},
): TimelineV1 {
	const view: View = { session: source };
	const analysis = analyze(source);
	const id = source.sessionId;
	const entries: TimelineEntry[] = analysis.attempts.map((attempt) => callEntry(view, "own", id, attempt));
	for (const record of source.accountQuota ?? []) if (record.k === "quota.read") entries.push(quotaEntry(record));
	for (const record of source.journal.records) {
		const at = record.t;
		switch (record.k) {
			case "turn.settled":
				entries.push({
					kind: "turn",
					at,
					turnId: record.ctx.turnId ?? null,
					stopReason: record.data.stopReason,
					cause: record.data.terminal.cause,
					stage: record.data.terminal.stage,
					retries: record.data.terminal.retries,
					retriesShown: shownCount(record.data.terminal.retries),
					callIds: record.data.terminal.callIds as CallRowV1["callId"][],
				});
				break;
			case "run.linked":
				entries.push({ kind: "run", at, runId: record.data.runId, event: "referenced", terminalReason: null });
				break;
			case "compaction.settled":
				entries.push({
					kind: "compaction",
					at,
					callIds: record.data.callIds as CallRowV1["callId"][],
					outcome: record.data.outcome,
				});
				break;
			case "session.opened":
			case "session.resumed":
				entries.push({ kind: "session", at, event: record.k === "session.opened" ? "opened" : "resumed", detail: null });
				break;
			case "session.forked":
				entries.push({
					kind: "session",
					at,
					event: "forked_from",
					detail: `${record.data.parentSessionId} at ${record.data.parentTurnId}`,
				});
				break;
			case "session.closed":
				entries.push({ kind: "session", at, event: "closed", detail: record.data.reason });
				break;
			case "journal.gap":
				entries.push(gapEntry(record));
				break;
			case "config.snapshotted":
				entries.push({
					kind: "config",
					at,
					event: "snapshot",
					source: null,
					paths: null,
					settings: record.data.settings,
					previous: null,
				});
				break;
			case "config.changed":
				entries.push({
					kind: "config",
					at,
					event: "changed",
					source: record.data.source,
					paths: record.data.paths,
					settings: record.data.after,
					previous: record.data.before,
				});
				break;
			case "budget.crossed":
			case "budget.held":
				entries.push(budgetEntry(analysis, record));
				break;
			case "tool.settled": {
				const data = record.data;
				const duration = localClock(data.durationMs);
				const parked = data.parkedMs === undefined ? null : localClock(data.parkedMs);
				const bytes = data.resultBytes === undefined ? null : localCount(data.resultBytes);
				entries.push({
					kind: "tool",
					at,
					tool: data.tool,
					outcome: data.outcome,
					blocked: data.blocked ?? null,
					toolCallId: record.ctx.toolCallId ?? null,
					callId: (record.ctx.callId ?? null) as CallRowV1["callId"] | null,
					turnId: record.ctx.turnId ?? null,
					runId: record.ctx.runId ?? null,
					duration: { fact: duration, display: renderFact(duration, "duration") },
					parked: parked ? { fact: parked, display: renderFact(parked, "duration") } : null,
					resultBytes: bytes ? { fact: bytes, display: renderFact(bytes) } : null,
				});
				break;
			}
			case "middleware.fired":
				entries.push({
					kind: "middleware",
					at,
					hook: record.data.hook,
					phase: record.data.phase,
					ruleId: record.data.ruleId,
					effects: record.data.effects,
					severity: record.data.severity ?? null,
					evidence: record.data.evidence ?? null,
					tool: record.data.tool ?? null,
					turnId: record.ctx.turnId ?? null,
				});
				break;
			case "auth.refreshed": {
				const duration = localClock(record.data.durationMs);
				entries.push({
					kind: "auth",
					at,
					provider: record.data.provider,
					trigger: record.data.trigger,
					attempted: record.data.attempted,
					outcome: record.data.outcome,
					wroteCredential: record.data.writerPid !== null,
					duration: { fact: duration, display: renderFact(duration, "duration") },
				});
				break;
			}
			case "prompt.compiled": {
				const tokens: Fact<number> = { kind: "estimated", value: record.data.tokenEstimate, method: "chars/4" };
				entries.push({
					kind: "prompt",
					at,
					structure: record.data.structure,
					layoutVersion: record.data.layoutVersion,
					sections: record.data.sections,
					sectionsShown: shownCount(record.data.sections),
					tokens: { fact: tokens, display: renderFact(tokens) },
					callId: (record.ctx.callId ?? null) as CallRowV1["callId"] | null,
				});
				break;
			}
			case "context.snapshotted": {
				const data = record.data;
				const estimated: Fact<number> | null =
					data.estimatedTokens === undefined ? null : { kind: "estimated", value: data.estimatedTokens, method: "chars/4" };
				const reconciled: Fact<number> | null =
					data.reconciledTokens === undefined
						? null
						: { kind: "measured", value: data.reconciledTokens, source: "provider" };
				entries.push({
					kind: "context",
					at,
					snapshotId: data.snapshotId,
					source: data.source,
					window: {
						...data.window,
						display: { desired: renderCount(data.window.desired), effective: renderCount(data.window.effective) },
					},
					estimated: estimated ? { fact: estimated, display: renderFact(estimated) } : null,
					reconciled: reconciled ? { fact: reconciled, display: renderFact(reconciled) } : null,
					turnId: record.ctx.turnId ?? null,
					callId: (record.ctx.callId ?? null) as CallRowV1["callId"] | null,
				});
				break;
			}
			case "system_one.decided": {
				const data = record.data;
				const latency = localClock(data.latencyMs);
				const deadline = localClock(data.deadlineMs);
				entries.push({
					kind: "system-one",
					at,
					site: data.site,
					moment: data.moment ?? null,
					outcome: data.outcome,
					latency: { fact: latency, display: renderFact(latency, "duration") },
					deadline: { fact: deadline, display: renderFact(deadline, "duration") },
					fitted: data.fitted ?? null,
					routes: data.routes.map((route) => {
						const roundTrip = route.roundTripMs === undefined ? null : localClock(route.roundTripMs);
						return {
							engine: route.engine,
							kind: route.kind,
							outcome: route.outcome,
							roundTrip: roundTrip ? { fact: roundTrip, display: renderFact(roundTrip, "duration") } : null,
							breaker: route.breaker ?? null,
						};
					}),
					callIds: data.callIds as CallRowV1["callId"][],
				});
				break;
			}
		}
	}
	// A worker's channel failures live in its run journal; the session shows those of the runs it referenced (#425).
	for (const run of analysis.runs.values())
		for (const record of run.source.records)
			if (record.k === "worker.channel_failed")
				entries.push({
					kind: "worker-channel",
					at: record.t,
					runId: run.runId,
					lane: record.data.lane,
					frameType: record.data.frameType,
					errno: record.data.errno,
					afterExit: record.data.afterExit,
					failure: record.data.failure,
				});
	for (const run of analysis.runs.values())
		if (run.settled)
			entries.push({
				kind: "run",
				at: run.settled.at,
				runId: run.runId,
				event: "settled",
				terminalReason: run.settled.data.terminalReason,
			});
	const order: Record<TimelineEntry["kind"], number> = {
		session: 0,
		gap: 1,
		config: 2,
		auth: 3,
		quota: 4,
		budget: 5,
		prompt: 6,
		context: 7,
		"system-one": 8,
		middleware: 9,
		call: 10,
		tool: 11,
		"worker-channel": 12,
		compaction: 13,
		run: 14,
		turn: 15,
	};
	const within = (at: string) => !range || (at >= range.from && at <= range.to);
	return {
		...header(options),
		kind: "timeline",
		sessionId: id,
		range,
		entries: entries
			.filter((entry) => within(entry.at))
			.sort((a, b) => (a.at === b.at ? order[a.kind] - order[b.kind] : a.at < b.at ? -1 : 1)),
	};
}

/** One attempt on a timeline, its quantities under the scope that owns it. */
function callEntry(
	view: View,
	scope: "own" | "run",
	owner: string,
	attempt: Attempt,
): Extract<TimelineEntry, { kind: "call" }> {
	const q = (metric: FactMetric) => quantity(view, { scope, owner, attemptId: attempt.started.attemptId, metric });
	return {
		kind: "call",
		at: attempt.startedAt,
		endAt: attempt.settledAt,
		callId: attempt.started.callId as CallRowV1["callId"],
		attemptId: attempt.started.attemptId as CallRowV1["attemptId"],
		label: attempt.started.label,
		turnId: attempt.ctx?.turnId ?? null,
		runId: attempt.ctx?.runId ?? null,
		disposition: attempt.settled?.disposition ?? "incomplete",
		failure: attempt.settled?.stop.failure ?? null,
		stages: attempt.settled?.stages ?? null,
		timing: { ttft: q("ttft"), modelTime: q("modelTime"), settle: q("settle"), admissionWait: q("admissionWait") },
		tokens: q("total"),
		usd: q("usd"),
		cacheVerdict: attempt.settled?.cache.verdict ?? "unknown",
	};
}

/**
 * One run journal in time order (#434 §11.3): attempts, the bounded run feed, the worker process's start and exit,
 * gaps and the settlement. Entries at the same instant keep journal order within a kind, so feed sequence holds.
 */
export function runTimeline(runId: string, source: JournalSource, options: ReadOptions = {}): RunTimelineV1 {
	const run = analyzeRun(runId, source);
	const view: View = { run };
	const entries: RunTimelineEntry[] = run.attempts.map((attempt) => callEntry(view, "run", runId, attempt));
	for (const record of source.records) {
		const at = record.t;
		switch (record.k) {
			case "run.feed_appended": {
				const body = record.data.body;
				const ms = body.kind === "event" ? body.durationMs : undefined;
				const fact = ms === undefined ? null : localClock(ms);
				entries.push({
					kind: "feed",
					at,
					seq: record.data.seq,
					body,
					duration: fact ? { fact, display: renderFact(fact, "duration") } : null,
				});
				break;
			}
			case "process.started":
				entries.push({ kind: "process", at, event: "started", exitCode: null });
				break;
			case "process.exited":
				entries.push({ kind: "process", at, event: "exited", exitCode: record.data.exitCode });
				break;
			case "journal.gap":
				entries.push(gapEntry(record));
				break;
		}
	}
	if (run.settled)
		entries.push({
			kind: "run",
			at: run.settled.at,
			runId,
			event: "settled",
			terminalReason: run.settled.data.terminalReason,
		});
	const order: Record<RunTimelineEntry["kind"], number> = { process: 0, gap: 1, call: 2, feed: 3, run: 4 };
	return {
		...header(options),
		kind: "run-timeline",
		runId,
		sessionId: run.sessionId,
		entries: entries.sort((a, b) => (a.at === b.at ? order[a.kind] - order[b.kind] : a.at < b.at ? -1 : 1)),
	};
}

/** One settled code step of a fleet root, with the time its record was journaled. */
export type CodeStepRowV1 = EventPayload<"code_step.settled"> & { at: string };

/** The code steps a fleet root's journal settled, oldest start first (#434). */
export function codeStepsReport(source: JournalSource): CodeStepRowV1[] {
	return source.records
		.flatMap((record) => (record.k === "code_step.settled" ? [{ ...record.data, at: record.t }] : []))
		.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/** The safety and lifecycle decisions a scope journals: what the retired audit log kept (#434). */
export const ACCOUNTABILITY_EVENTS = [
	"tool.decided",
	"approval.requested",
	"approval.resolved",
	"run.aborted",
	"turn.aborted",
	"agent.status_changed",
	"completion.evaluated",
	"safety.judged",
	"session.resumed",
	"session.closed",
] as const satisfies readonly JournalEventName[];
export type AccountabilityEventName = (typeof ACCOUNTABILITY_EVENTS)[number];
export type AccountabilityRecord = TelemetryRecord<AccountabilityEventName>;

const accountabilityKinds: ReadonlySet<string> = new Set(ACCOUNTABILITY_EVENTS);

function isAccountabilityRecord(record: TelemetryRecord): record is AccountabilityRecord {
	return accountabilityKinds.has(record.k);
}

/**
 * The accountability records of the given journals, oldest first and each once: a run journal a session and a repo
 * both reference is read once (#434).
 */
export function accountabilityRecords(journals: Iterable<JournalSource>): AccountabilityRecord[] {
	const seen = new Set<string>();
	const out: AccountabilityRecord[] = [];
	for (const journal of journals) {
		for (const record of journal.records) {
			if (!isAccountabilityRecord(record) || seen.has(record.id)) continue;
			seen.add(record.id);
			out.push(record);
		}
	}
	return out.sort((a, b) => a.t.localeCompare(b.t) || a.id.localeCompare(b.id));
}

/** A session's own journal and the run journals its records reference. */
export function sessionJournals(source: SessionSource): JournalSource[] {
	return [source.journal, ...source.runs.values()];
}

/** The runs a session's own records reference, in run id order. */
export function runsReport(source: SessionSource): RunRowV1[] {
	const view: View = { session: source };
	return [...analyze(source).runs.values()].map((run) => runRow(view, run));
}

/** One run as a list row: the row `runTelemetry` reports, without the per-run detail (#434 §11.3). */
export function runRowTelemetry(runId: string, source: JournalSource): RunRowV1 {
	const run = analyzeRun(runId, source);
	return runRow({ run }, run);
}

/** `receipt` is the run's sealed receipt read through its integrity check, which the caller's loader reads (#434 §11.1). */
export function runTelemetry(
	runId: string,
	source: JournalSource,
	options: ReadOptions = {},
	receipt: ReceiptEvidenceV1 | null = null,
): RunTelemetryV1 {
	const run = analyzeRun(runId, source);
	const view: View = { run };
	const base = { scope: "run" as const, owner: runId };
	const settled = run.settled;
	return {
		...header(options),
		kind: "run",
		row: runRow(view, run),
		journal: journalCoverage(source, run.fold.calls),
		counts: callCounts(view, base),
		tokens: tokenQuantities(view, base),
		missingTokenCalls: quantity(view, { ...base, metric: "missingTokenCalls" }),
		settled: settled
			? {
					at: settled.at,
					terminalReason: settled.data.terminalReason,
					processExitCode: settled.data.processExitCode,
					boundKind: settled.data.boundKind ?? null,
					repairRounds: quantity(view, { ...base, metric: "repairRounds" }),
					frameType: settled.data.frameType,
					callIds: settled.data.callIds as NonNullable<RunTelemetryV1["settled"]>["callIds"],
				}
			: null,
		receipt,
	};
}

export function whyStopped(source: SessionSource, options: ReadOptions = {}): WhyStoppedV1 {
	const view: View = { session: source };
	const analysis = analyze(source);
	const id = source.sessionId;
	let last: { at: string; record: Extract<TelemetryRecord, { k: "turn.settled" }> } | null = null;
	// The session DTO's lifecycle, so a close the ledger recorded reads closed here too (#434 §6.1).
	const life = lifecycle(source, options);
	const budget: BudgetEntry[] = [];
	const latestQuota = new Map<string, QuotaEntry>();
	for (const record of source.journal.records) {
		if (record.k === "turn.settled" && (!last || record.t >= last.at)) last = { at: record.t, record };
		if (record.k === "budget.crossed" || record.k === "budget.held") budget.push(budgetEntry(analysis, record));
	}
	for (const record of source.accountQuota ?? []) {
		if (record.k === "quota.read") {
			const account = `${record.data.provider}\u0000${record.data.targetId}`;
			const entry = quotaEntry(record);
			const prior = latestQuota.get(account);
			if (!prior || entry.observedAt >= prior.observedAt) latestQuota.set(account, entry);
		}
	}
	budget.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
	const quota = [...latestQuota.values()].sort(
		(a, b) =>
			Number(quotaLimited(b)) - Number(quotaLimited(a)) ||
			a.provider.localeCompare(b.provider) ||
			a.targetId.localeCompare(b.targetId),
	);
	const terminal = last?.record.data;
	const lastCallIds = new Set(terminal?.terminal.callIds ?? []);
	const lastCalls = analysis.attempts
		.filter((attempt) => lastCallIds.has(attempt.started.callId))
		.map((attempt) => callRow(view, "own", id, attempt));
	const causes = new Map<string, string>();
	const waits = new Set<NonNullable<NonNullable<CallSettled["stages"]["admission"]>["waitedOn"]>>();
	for (const attempt of analysis.attempts) {
		const settled = attempt.settled;
		const failure = settled?.stop.failure;
		const at = attempt.settledAt ?? attempt.startedAt;
		if (failure && (causes.get(failure) ?? "") < at) causes.set(failure, at);
		const waitedOn = settled?.stages.admission?.waitedOn;
		if (waitedOn) waits.add(waitedOn);
	}
	const state: WhyStoppedV1["state"] =
		life.state === "closed"
			? "closed"
			: !terminal
				? "no-turns"
				: terminal.stopReason === "error"
					? "turn-failed"
					: terminal.stopReason === "aborted"
						? "turn-cancelled"
						: "turn-completed";
	const causeRows = [...causes.entries()]
		.sort(([, a], [, b]) => (a < b ? 1 : -1))
		.map(([cause, lastAt]) => ({
			cause: cause as NonNullable<CallSettled["stop"]["failure"]>,
			calls: quantity(view, own(id, "attempts", { group: { by: "cause", key: cause } })),
			lastAt,
		}));
	const waitRows = [...waits].sort().map((on) => ({
		on,
		calls: quantity(view, own(id, "attempts", { group: { by: "wait", key: on } })),
		waited: quantity(view, own(id, "admissionWait", { group: { by: "wait", key: on } })),
	}));
	const spend = {
		tokens: quantity(view, { scope: "session", owner: id, metric: "total" }),
		usd: quantity(view, { scope: "session", owner: id, metric: "usd" }),
	};
	const cache = {
		rePrefilled: quantity(view, own(id, "rePrefilled")),
		breakUsd: quantity(view, own(id, "breakUsd")),
	};
	const main = { group: { by: "label" as const, key: "main" } };
	const roundTrips = {
		rounds: quantity(view, own(id, "bookkeepingRounds", main)),
		tax: quantity(view, own(id, "roundTripTax", main)),
	};
	const findings: string[] = [];
	if (state === "no-turns") findings.push("No turn has settled in this session's journal.");
	else if (terminal) {
		const stage = terminal.terminal.stage ? ` at ${terminal.terminal.stage}` : "";
		const retries =
			terminal.terminal.retries > 0
				? ` after ${renderCount(terminal.terminal.retries)} ${terminal.terminal.retries === 1 ? "retry" : "retries"}`
				: "";
		findings.push(
			terminal.terminal.cause
				? `The last turn stopped (${terminal.stopReason}) on ${terminal.terminal.cause}${stage}${retries}.`
				: `The last turn stopped (${terminal.stopReason})${stage}${retries}.`,
		);
	}
	if (life.closed)
		findings.push(`The session closed at ${life.closed.at}${life.closed.reason ? ` (${life.closed.reason})` : ""}.`);
	else if (life.state === "ended-abnormally") findings.push("The session's process ended without closing it.");
	const crossing = budget.filter((entry) => entry.event === "crossing").at(-1);
	if (crossing)
		findings.push(
			`Priced spend ${crossing.level === "over" ? "passed" : "reached"} the ${crossing.ceiling.display} ceiling at ${crossing.at}: ${crossing.spend.display}.`,
		);
	const held = budget.filter((entry) => entry.event === "wait");
	const release = held.at(-1);
	if (release)
		findings.push(
			`${renderCount(held.length)} paid ${held.length === 1 ? "request was" : "requests were"} held at a ceiling; the last ${
				release.outcome === "raised" || release.outcome === "removed" || release.outcome === "cleared"
					? `was released (${release.outcome}${release.raisedTo ? ` to ${release.raisedTo.display}` : ""}${release.raisedBy ? ` by ${release.raisedBy}` : ""})`
					: `ended ${release.outcome ?? "unreleased"}`
			} after ${release.waited?.display ?? "an unrecorded wait"}.`,
		);
	for (const entry of quota.filter(quotaLimited))
		findings.push(
			`${entry.provider} reported the account limited at ${entry.observedAt}: ${entry.windows.map((window) => `${window.key} ${window.usedPct.display}`).join(", ")}.`,
		);
	for (const row of waitRows)
		findings.push(`Admission held on ${row.on}: ${row.calls.display} attempt(s), ${row.waited.display} waited.`);
	for (const row of causeRows)
		findings.push(`Failed on ${row.cause}: ${row.calls.display} attempt(s), the last at ${row.lastAt}.`);
	findings.push(`Spend: ${spend.usd.display} over ${spend.tokens.display} tokens.`);
	findings.push(`Re-prefilled tokens: ${cache.rePrefilled.display}; cache-break bill: ${cache.breakUsd.display}.`);
	const rounds = roundTrips.rounds.fact;
	if ("kind" in rounds ? rounds.kind !== "measured" || rounds.value > 0 : rounds.measured > 0 || rounds.unknownCount > 0)
		findings.push(
			`Bookkeeping-only rounds: ${roundTrips.rounds.display}, re-reading ${roundTrips.tax.display} prompt tokens.`,
		);
	return {
		...header(options),
		kind: "why-stopped",
		sessionId: id,
		state,
		lastTurn: last
			? {
					at: last.at,
					turnId: last.record.ctx.turnId ?? null,
					stopReason: last.record.data.stopReason,
					cause: last.record.data.terminal.cause,
					stage: last.record.data.terminal.stage,
					retries: last.record.data.terminal.retries,
					callIds: last.record.data.terminal.callIds as CallRowV1["callId"][],
				}
			: null,
		lastCalls,
		causes: causeRows,
		waits: waitRows,
		cache,
		roundTrips,
		spend,
		budget,
		quota,
		findings,
	};
}

/** One quantity by reference, measured exactly as every DTO measures it; null when the source cannot see the ref. */
/** Fold a source now, so the first reader after a live seed finds its analysis built (#434 §11). */
export function prepareSource(source: SessionSource): void {
	analyze(source);
	if (source.parent) analyzeLineage(source);
}

export function quantityOf(ref: FactRef, source: SessionSource): Quantity | null {
	const parsed = parseFactRef(ref);
	return parsed ? (measure({ session: source }, parsed)?.quantity ?? null) : null;
}

const EXPLAIN_CAP = 500;

/** Resolve a reference against a session (any scope it can see) or a standalone run. */
export function explain(
	ref: FactRef,
	source: { session: SessionSource } | { runId: string; run: JournalSource } | { repo: RepoSource },
	options: ReadOptions = {},
): ExplanationV1 | null {
	const parsed = parseFactRef(ref);
	if (!parsed) return null;
	const view: View =
		"session" in source
			? { session: source.session }
			: "repo" in source
				? { repo: source.repo }
				: { run: analyzeRun(source.runId, source.run) };
	const measured = measure(view, parsed);
	if (!measured) return null;
	const attempts = measured.selection.parts.flatMap((part) => part.attempts ?? part.run?.attempts ?? []);
	const runIds = measured.selection.parts.flatMap((part) => (part.run ? [part.run.runId] : []));
	const gaps = measured.selection.parts.reduce(
		(total, part) => total + part.gap + (part.run && !part.run.source.present ? 1 : 0),
		0,
	);
	const listed = attempts.slice(0, EXPLAIN_CAP);
	return {
		...header(options),
		kind: "explanation",
		ref: factRef(parsed),
		value: measured.quantity,
		coverage: renderCoverage(measured.quantity.fact),
		rule: `${RULES[parsed.metric]} over ${measured.selection.describe}; a never_sent attempt contributes nothing (R2), and unknown, unsettled or unreadable contributions keep the sum partial${
			gaps > 0 ? ` (${renderCount(gaps)} unreadable or unattributed ${gaps === 1 ? "source" : "sources"})` : ""
		}`,
		from: {
			callIds: [...new Set(listed.map((attempt) => attempt.started.callId))].sort() as ExplanationV1["from"]["callIds"],
			attemptIds: listed.map((attempt) => attempt.started.attemptId).sort() as ExplanationV1["from"]["attemptIds"],
			runIds: [...new Set(runIds)].sort(),
			recordIds: [...new Set(listed.flatMap((attempt) => attempt.recordIds))].sort(),
			omitted: attempts.length - listed.length,
		},
	};
}

/** Session accounting replays only snapshots owned by this session, in journal order (#434). */
export function contextSnapshots(records: readonly TelemetryRecord[], sessionId: string): ContextSnapshot[] {
	return records.flatMap((record) => {
		if (record.k !== "context.snapshotted" || record.ctx.sessionId !== sessionId) return [];
		const data = record.data;
		return [
			{
				snapshotId: data.snapshotId,
				sessionId,
				turnId: record.ctx.turnId ?? "",
				providerId: data.providerId,
				runtimeId: data.runtimeId,
				modelId: data.modelId,
				desiredContextWindow: data.window.desired,
				effectiveContextWindow: data.window.effective,
				contextWindowSource: data.window.source,
				categories: data.categories,
				sources: { total: data.source, splits: data.splits },
				...(data.promptSegments ? { promptSegments: data.promptSegments } : {}),
				...(data.promptHash ? { promptHash: data.promptHash } : {}),
				...(data.toolSignature ? { toolSignature: data.toolSignature } : {}),
				...(data.messageRange ? { messageRange: data.messageRange } : {}),
				...(data.estimatedTokens !== undefined ? { estimatedTokens: data.estimatedTokens } : {}),
				...(data.reconciledTokens !== undefined ? { reconciledTokens: data.reconciledTokens } : {}),
				...(data.divergenceRatio !== undefined ? { divergenceRatio: data.divergenceRatio } : {}),
				...(record.ctx.callId ? { callId: record.ctx.callId } : {}),
				...(record.ctx.attemptId ? { attemptId: record.ctx.attemptId } : {}),
			},
		];
	});
}

/** An idle writer can announce a structure again; the first compile owns its provenance (#434). */
export function promptCompiles(
	records: readonly TelemetryRecord[],
	sessionId: string,
	resolve: (ref: ObjectRef) => ReturnType<typeof telemetryPromptStructure> | null,
): SessionPromptCompileRecord[] {
	const seen = new Set<string>();
	return records.flatMap((record) => {
		if (record.k !== "prompt.compiled" || record.ctx.sessionId !== sessionId || seen.has(record.data.structure.id))
			return [];
		const structure = resolve(record.data.structure);
		if (!structure?.compile) return [];
		seen.add(record.data.structure.id);
		return [
			{
				...structure.compile,
				sections: structure.sections,
				fragments: structure.fragments.map((fragment) => {
					if (fragment.relPath === undefined) throw new Error("prompt fragment path is unavailable");
					return { ...fragment, relPath: fragment.relPath };
				}),
			},
		];
	});
}

export interface TaskMemorySpendSummary {
	/** Referenced attempts whose journal facts are missing or still incomplete (#434). */
	unresolvedCalls?: number;
	/** Retained llm-tier boundaries, including skipped attempts. Rules-tier rows are excluded. */
	llmSteps: number;
	/** Llm-tier steps whose reminder reached the visible channel. */
	injections: number;
	/** Injections over llm steps, 0 when no llm step has run. */
	hitRate: number;
	inputTokens: number;
	outputTokens: number;
	totalTokens: number;
	/** Cumulative llm-tier step latency. */
	modelMs: number;
	/** Slowest single llm-tier step, which is what a deadline has to answer for. */
	slowestStepMs: number;
	/** Llm-tier steps that spent their whole budget and answered nothing. */
	timeouts: number;
	/** Boundaries skipped because the chat endpoint was serving a turn. */
	endpointBusySkips: number;
	/** Oldest and newest row in the ledger, so a rate is read against a window. */
	firstAt: string | null;
	lastAt: string | null;
	readableFiles: number;
	unreadableFiles: number;
	/** Nonblank rows that could not be parsed as supported telemetry. */
	invalidRows: number;
	/** Calls explicitly recorded as missing provider usage; historical zeros alone cannot establish this. */
	missingTokenCalls: number;
	/** Llm-tier steps with no observation of provider usage coverage. */
	unreportedUsageSteps: number;
}

export function emptyTaskMemorySpendSummary(): TaskMemorySpendSummary {
	return {
		llmSteps: 0,
		injections: 0,
		hitRate: 0,
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		modelMs: 0,
		slowestStepMs: 0,
		timeouts: 0,
		endpointBusySkips: 0,
		firstAt: null,
		lastAt: null,
		readableFiles: 0,
		unreadableFiles: 0,
		invalidRows: 0,
		missingTokenCalls: 0,
		unreportedUsageSteps: 0,
	};
}

/** Fold memory decisions and their call facts from the same journal records (#434). */
export function foldTaskMemorySpend(records: readonly TelemetryRecord[]): TaskMemorySpendSummary {
	const summary = emptyTaskMemorySpendSummary();
	const attempts = new Map<string, FoldedAttempt>();
	for (const attempt of foldCallJournal(records).attempts) attempts.set(attempt.started.attemptId, attempt);
	const seen = new Set<string>();
	const value = (fact: Fact<number>) => (fact.kind === "measured" || fact.kind === "estimated" ? fact.value : 0);
	for (const row of records) {
		if (row.k !== "memory.step_decided") continue;
		const record = row.data;
		const at = row.t;
		if (summary.firstAt === null || at < summary.firstAt) summary.firstAt = at;
		if (summary.lastAt === null || at > summary.lastAt) summary.lastAt = at;
		if (record.reason === "endpoint_busy") summary.endpointBusySkips += 1;
		if (record.tier !== "llm") continue;
		summary.llmSteps += 1;
		if (record.decision === "injected") summary.injections += 1;
		if (record.decision === "timeout") summary.timeouts += 1;
		if (record.calls?.length) {
			const linked: FoldedAttempt[] = [];
			for (const ref of record.calls) {
				const key = `${telemetryOwner(row.ctx)}/${ref.attemptId}`;
				if (seen.has(key)) continue;
				seen.add(key);
				const attempt = attempts.get(ref.attemptId);
				if (attempt?.started.callId === ref.callId) linked.push(attempt);
				if (!attempt || attempt.started.callId !== ref.callId || attempt.settled === null)
					summary.unresolvedCalls = (summary.unresolvedCalls ?? 0) + 1;
			}
			const totals = foldCalls(linked);
			summary.inputTokens += totals.usage.input.measured + totals.usage.input.estimated;
			summary.outputTokens += totals.usage.output.measured + totals.usage.output.estimated;
			summary.totalTokens += totals.totalTokens.measured + totals.totalTokens.estimated;
			summary.missingTokenCalls += foldCalls(
				linked.filter((attempt) => attempt.settled !== null),
			).totalTokens.unknownCount;
		} else {
			summary.inputTokens += value(record.inputTokens);
			summary.outputTokens += value(record.outputTokens);
			summary.totalTokens += value(record.inputTokens) + value(record.outputTokens);
			summary.missingTokenCalls += record.missingTokenCalls ?? 0;
			if (
				record.missingTokenCalls === undefined &&
				(record.inputTokens.kind === "unknown" || record.outputTokens.kind === "unknown")
			)
				summary.unreportedUsageSteps += 1;
		}
		summary.modelMs += value(record.latencyMs);
		summary.slowestStepMs = Math.max(summary.slowestStepMs, value(record.latencyMs));
	}
	summary.hitRate = summary.llmSteps === 0 ? 0 : summary.injections / summary.llmSteps;
	return summary;
}
