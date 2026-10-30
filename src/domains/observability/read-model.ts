import { processIdentityAlive } from "../../core/process-identity.js";
import type { TelemetryContext } from "../../core/telemetry/context.js";
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
import type { CallSettled, CallUsage, Payload } from "../../core/telemetry/schemas.js";
import type { CallJournalFolder, CallTotals, FoldedAttempt, JournalFold } from "./folds.js";
import {
	addCallTotals,
	addGroup,
	callJournalFolder,
	emptyCallTotals,
	emptyFactSum,
	foldCalls,
	foldFacts,
	foldRunJournal,
	sumFactSums,
	TELEMETRY_FOLD_VERSION,
} from "./folds.js";

/**
 * The telemetry read model (#434 §11). Pure: callers hand it journal records (read from disk, or the live writer's
 * persisted batches) and get DTOs back. Every quantity in every DTO comes from {@link measure}, the same function
 * `explain` answers with, so a number and its explanation cannot drift apart, and every display string comes from
 * the canonical renderer. Arithmetic is the observability folds'; this module only selects what they fold.
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
	/** Calls rebuilt from ledger rows the journal never held; checkpoint aggregates naming no calls stay unknown. */
	legacy: { records: readonly TelemetryRecord[]; aggregates: number };
	/** Run journals this session's own records reference, keyed by run id. */
	runs: ReadonlyMap<string, JournalSource>;
	/** The fork parent; `source` is null when its journal and ledger could not be read. */
	parent: { sessionId: string; turnId: string; at: string; source: SessionSource | null } | null;
	/**
	 * The ledger's own lifecycle: `endedAt` is set by a clean close and cleared by a reopen. Sessions that predate the
	 * journal, and every session until the journal records its own close, end only here (#434 §6.1).
	 */
	ledger?: { endedAt: string | null; owner: ProcessIdentity | null };
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
}
interface Run {
	runId: string;
	source: JournalSource;
	/** The session record that referenced the run, which the run's turn and reference time come from. */
	reference: TelemetryRecord | null;
	fold: ReturnType<typeof foldRunJournal>;
	attempts: Attempt[];
	byAttempt: Map<string, Attempt>;
	settled: { at: string; data: Payload<"run.settled"> } | null;
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
 * the fixed `tail` (legacy rows, then ancestors' records for a lineage), while a cold read folds appended records
 * before the tail; a new record that names an id the tail carries could fold differently, so it rebuilds instead.
 */
interface Growth {
	folder: CallJournalFolder;
	meta: Map<string, AttemptMeta>;
	/** The first session record referencing each run. */
	references: Map<string, TelemetryRecord>;
	/** A gap other than policy was folded. */
	gapRecord: boolean;
	head: readonly TelemetryRecord[];
	tail: { records: Set<string>; attempts: Set<string>; runs: Set<string> };
	legacy: SessionSource["legacy"];
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
const unknownSum = (count: number): FactSum => foldFacts(Array.from({ length: count }, () => unobserved));
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

function attemptOf(attempt: FoldedAttempt, entry: AttemptMeta | undefined): Attempt {
	return {
		...attempt,
		startedAt: entry?.startedAt ?? entry?.settledAt ?? EPOCH,
		settledAt: attempt.settled ? (entry?.settledAt ?? null) : null,
		ctx: entry?.ctx ?? null,
		recordIds: [...(entry?.ids ?? [])].sort(),
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
	for (const record of records) noteMeta(meta, record);
	return attempts.map((attempt) => attemptOf(attempt, meta.get(attempt.started.attemptId))).sort(byStart);
}

const unavailable: JournalSource = { present: false, records: [], modes: [], skipped: 0, damaged: 0 };
const POLICY_GAPS: ReadonlySet<string> = new Set(["mode-filtered", "research-cap"]);

/** A run journal reads the same until the live model swaps its source, so each source is folded once. */
const runAnalyses = new WeakMap<JournalSource, Run>();
function analyzeRun(runId: string, source: JournalSource, reference?: TelemetryRecord): Run {
	const cached = runAnalyses.get(source);
	if (cached && cached.runId === runId && cached.reference === (reference ?? null)) return cached;
	const fold = foldRunJournal(source.records);
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
	if ((record.k === "run.ref" || record.k === "call.ref") && !growth.references.has(record.data.runId))
		growth.references.set(record.data.runId, record);
	// A mode-filtered or research-cap gap is policy: only research or content kinds go uncaptured, never
	// accountability, so neither makes a total partial (#434, R10).
	if (record.k === "gap" && !POLICY_GAPS.has(record.data.reason)) growth.gapRecord = true;
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
	legacy: SessionSource["legacy"],
	parent: SessionSource | null,
): Analysis {
	const growth: Growth = {
		folder: callJournalFolder(),
		meta: new Map(),
		references: new Map(),
		gapRecord: false,
		head,
		tail: { records: new Set(), attempts: new Set(), runs: new Set() },
		legacy,
		parent,
	};
	for (const record of head) grow(growth, record);
	for (const segment of tail)
		for (const record of segment) {
			grow(growth, record);
			growth.tail.records.add(record.id);
			if (record.k === "call.started" || record.k === "call.settled") growth.tail.attempts.add(record.data.attemptId);
			if (record.k === "run.ref" || record.k === "call.ref") growth.tail.runs.add(record.data.runId);
		}
	const attempts = growth.folder
		.attempts()
		.map((attempt) => attemptOf(attempt, growth.meta.get(attempt.started.attemptId)))
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
			((record.k === "run.ref" || record.k === "call.ref") && tail.runs.has(record.data.runId))
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
		const after = folded ? attemptOf(folded, growth.meta.get(attemptId)) : undefined;
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
	const gap = readGap(source.journal) + source.legacy.aggregates;
	const continuation = continuations.get(source);
	const base = continuation?.own;
	const prior = base ? analyses.get(base) : undefined;
	if (
		base &&
		prior &&
		prior.sessionId === source.sessionId &&
		prior.growth.legacy === source.legacy &&
		extendAnalysis(prior, source.journal.records, source.runs, gap)
	) {
		analyses.delete(base);
		analysis = prior;
	} else
		analysis = buildAnalysis(
			source.sessionId,
			source.journal.records,
			[source.legacy.records],
			source.runs,
			gap,
			source.legacy,
			null,
		);
	if (continuation) continuation.own = undefined;
	analyses.set(source, analysis);
	return analysis;
}

/** A child's journal holds only its own calls; ancestors contribute theirs once, deduplicated by the fold (#434). */
function analyzeLineage(source: SessionSource): Analysis {
	let analysis = lineages.get(source);
	if (analysis) return analysis;
	const tail: (readonly TelemetryRecord[])[] = [source.legacy.records];
	const runs = new Map<string, JournalSource>();
	let gap = 0;
	for (let node: SessionSource | null = source, depth = 0; node && depth < 128; depth += 1) {
		const own = analyze(node);
		if (node !== source) tail.push(node.journal.records, node.legacy.records);
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
		prior.growth.legacy === source.legacy &&
		prior.growth.parent === parent &&
		extendAnalysis(prior, source.journal.records, runs, gap)
	) {
		lineages.delete(base);
		analysis = prior;
	} else analysis = buildAnalysis(source.sessionId, source.journal.records, tail, runs, gap, source.legacy, parent);
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
function isBreak(attempt: Attempt): boolean {
	const settled = attempt.settled;
	if (!settled || settled.disposition === "never_sent") return false;
	const re = settled.cache.rePrefilledTokens;
	return (
		(re.kind === "measured" && re.value > 0) || settled.cache.verdict === "cold" || settled.cache.verdict === "partial"
	);
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

type View = { session: SessionSource } | { run: Run } | { repo: RepoSource };
/** An absent run journal is already one unknown contribution; a damaged one adds its own. */
const runGap = (run: Run) => (run.source.present ? run.gap : 0);

function select(view: View, ref: ParsedFactRef): Selection | null {
	const group = ref.group;
	if (ref.scope === "repo")
		return "repo" in view && view.repo.owner === ref.owner && !ref.attemptId ? selectRepo(view.repo, group) : null;
	if ("repo" in view) return null;
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

/** Each session's own attempts and its runs, a run two sessions reference counted once, then the scope's own runs. */
function selectRepo(repo: RepoSource, group: { by: FactGroup; key: string } | undefined): Selection {
	const parts: Part[] = [];
	const counted = new Set<string>();
	const addRun = (run: Run) => {
		if (counted.has(run.runId)) return;
		counted.add(run.runId);
		if (!group || runInGroup(run, group)) parts.push({ run, gap: runGap(run) });
	};
	for (const session of repo.sessions) {
		const analysis = analyze(session);
		const selection = selectionOf(analysis, group);
		parts.push({ attempts: selection.members, selection, gap: analysis.gap });
		for (const run of analysis.runs.values()) addRun(run);
	}
	for (const [runId, source] of [...repo.runs].sort(([a], [b]) => a.localeCompare(b))) addRun(analyzeRun(runId, source));
	return {
		parts,
		describe: `${renderCount(repo.sessions.length)} sessions' attempts + each run's journal fold${group ? ` where ${group.by}=${group.key}` : ""}`,
	};
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
		default:
			return unobserved;
	}
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
	const sums = selection.parts.map((part) =>
		withGap(
			part.run
				? runSum(part.run, ref.metric)
				: part.selection
					? selectionSum(part.selection, ref.metric)
					: attemptsSum(part.attempts ?? [], ref.metric),
			part.gap,
		),
	);
	const fact = sums.length === 1 && sums[0] ? sums[0] : sumFactSums(sums);
	return { quantity: { fact, display: display(ref.metric, fact, allFree(selection.parts)), ref: encoded }, selection };
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

function journalCoverage(source: JournalSource, fold: Pick<JournalFold, "coverage">, aggregates = 0) {
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
		unattributedAggregates: aggregates,
	};
}

function runRow(view: View, run: Run): RunRowV1 {
	const ref = (metric: FactMetric): ParsedFactRef => ({ scope: "run", owner: run.runId, metric });
	return {
		runId: run.runId,
		sessionId: run.sessionId,
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
	return {
		...header(options),
		kind: "session",
		sessionId: id,
		modes: [...new Set(source.journal.modes)],
		journal: journalCoverage(source.journal, analysis.fold, source.legacy.aggregates),
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
		timing: { ttft: q("ttft"), modelTime: q("modelTime"), settle: q("settle"), admissionWait: q("admissionWait") },
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
	return keys.map((key) => {
		const ref = (metric: FactMetric): ParsedFactRef => ({ ...base, metric, group: { by, key } });
		return {
			key,
			calls: quantity(view, ref("calls")),
			tokens: quantity(view, ref("total")),
			usd: quantity(view, ref("usd")),
			pricedBy: pricedByCounts(select(view, ref("usd"))?.parts ?? []),
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

/** A repository window's token fields: the session view's token quantities over the `repo` scope (#434 §11.1). */
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
	record: Extract<TelemetryRecord, { k: "budget.crossing" | "budget.wait" }>,
): BudgetEntry {
	const data = record.data;
	const wait = record.k === "budget.wait" ? record.data : null;
	const waited = wait ? localClock(wait.waitedMs) : null;
	const spend = spendAt(analysis, data.spendUsd, record.t);
	// Admission's own estimate of what the held request re-sends; it names no method, so it reads `~`.
	const context = data.contextTokens === undefined ? null : estimatedSum(data.contextTokens);
	return {
		kind: "budget",
		at: record.t,
		event: wait ? "wait" : "crossing",
		level: data.level,
		callId: (record.ctx.callId ?? null) as CallRowV1["callId"] | null,
		attemptId: (record.ctx.attemptId ?? null) as CallRowV1["attemptId"] | null,
		spend: { fact: spend, display: renderUsdSum(spend, false) },
		ceiling: { usd: data.ceilingUsd, display: renderUsdLimit(data.ceilingUsd) },
		contextTokens: context ? { fact: context, display: renderCountSum(context) } : null,
		outcome: wait?.outcome ?? null,
		waited: waited ? { fact: waited, display: renderFact(waited, "duration") } : null,
		raisedTo:
			wait?.raisedToUsd === undefined ? null : { usd: wait.raisedToUsd, display: renderUsdLimit(wait.raisedToUsd) },
		raisedBy: wait?.raisedBy ?? null,
	};
}

function quotaEntry(record: Extract<TelemetryRecord, { k: "quota.reading" }>): QuotaEntry {
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
					callIds: record.data.terminal.callIds as CallRowV1["callId"][],
				});
				break;
			case "run.ref":
				entries.push({ kind: "run", at, runId: record.data.runId, event: "referenced", terminalReason: null });
				break;
			case "compaction.closed":
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
			case "session.forked_from":
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
			case "gap":
				entries.push({ kind: "gap", at, sink: record.data.sink, reason: record.data.reason, count: record.data.count });
				break;
			case "config.snapshot":
				entries.push({
					kind: "config",
					at,
					event: "snapshot",
					source: null,
					paths: null,
					settings: record.data.settings,
					previous: null,
					settingsFingerprint: record.data.settingsFingerprint,
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
					settingsFingerprint: record.data.settingsFingerprint,
				});
				break;
			case "budget.crossing":
			case "budget.wait":
				entries.push(budgetEntry(analysis, record));
				break;
			case "quota.reading":
				entries.push(quotaEntry(record));
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
			case "auth.event": {
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
					tokens: { fact: tokens, display: renderFact(tokens) },
					callId: (record.ctx.callId ?? null) as CallRowV1["callId"] | null,
				});
				break;
			}
			case "context.snapshot": {
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
					window: data.window,
					estimated: estimated ? { fact: estimated, display: renderFact(estimated) } : null,
					reconciled: reconciled ? { fact: reconciled, display: renderFact(reconciled) } : null,
					turnId: record.ctx.turnId ?? null,
					callId: (record.ctx.callId ?? null) as CallRowV1["callId"] | null,
				});
				break;
			}
			case "system_one.decision": {
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
			if (record.k === "worker.channel")
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
			case "run.feed": {
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
			case "gap":
				entries.push({ kind: "gap", at, sink: record.data.sink, reason: record.data.reason, count: record.data.count });
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
	let closedAt: string | null = null;
	const budget: BudgetEntry[] = [];
	const latestQuota = new Map<string, QuotaEntry>();
	for (const record of source.journal.records) {
		if (record.k === "turn.settled" && (!last || record.t >= last.at)) last = { at: record.t, record };
		if (record.k === "session.closed" && (!closedAt || record.t > closedAt)) closedAt = record.t;
		if (record.k === "budget.crossing" || record.k === "budget.wait") budget.push(budgetEntry(analysis, record));
		if (record.k === "quota.reading") {
			const account = `${record.data.provider}\u0000${record.data.targetId}`;
			const entry = quotaEntry(record);
			const prior = latestQuota.get(account);
			if (!prior || entry.observedAt >= prior.observedAt) latestQuota.set(account, entry);
		}
	}
	budget.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
	const quota = [...latestQuota.values()].sort(
		(a, b) => Number(quotaLimited(b)) - Number(quotaLimited(a)) || (a.provider < b.provider ? -1 : 1),
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
		closedAt && (!last || closedAt >= last.at)
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
	if (state === "closed") findings.push("The session closed after its last turn.");
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
	source: { session: SessionSource } | { runId: string; run: JournalSource },
	options: ReadOptions = {},
): ExplanationV1 | null {
	const parsed = parseFactRef(ref);
	if (!parsed) return null;
	const view: View = "session" in source ? { session: source.session } : { run: analyzeRun(source.runId, source.run) };
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
