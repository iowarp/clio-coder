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
	RunRowV1,
	RunTelemetryV1,
	SessionTelemetryV1,
	TimelineEntry,
	TimelineV1,
	WhyStoppedV1,
} from "../../core/telemetry/dto.js";
import { factRef, parseFactRef, TELEMETRY_DTO_VERSION } from "../../core/telemetry/dto.js";
import type { SegmentHeader, TelemetryRecord } from "../../core/telemetry/envelope.js";
import type { Fact, FactSum } from "../../core/telemetry/fact.js";
import {
	renderCount,
	renderCountSum,
	renderDurationSum,
	renderFact,
	renderTextFact,
	renderUsdFact,
	renderUsdSum,
} from "../../core/telemetry/render.js";
import type { CallSettled, CallUsage, Payload } from "../../core/telemetry/schemas.js";
import type { FoldedAttempt } from "./folds.js";
import { foldCallJournal, foldCalls, foldFacts, foldRunJournal, sumFactSums, TELEMETRY_FOLD_VERSION } from "./folds.js";

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
}
export interface ReadOptions {
	now?: Date;
}

/** A journal read as the read model holds it; a run's journal keeps only records its run owns (#434). */
export function journalSourceFromRead(
	read: {
		records: ReadonlyArray<{ record: TelemetryRecord }>;
		modes?: readonly Mode[];
		skipped: number;
		damaged: number;
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
	records: TelemetryRecord[];
	attempts: Attempt[];
	byAttempt: Map<string, Attempt>;
	fold: ReturnType<typeof foldCallJournal>;
	/** Unknown contributions added to every whole-scope sum: an incomplete read and unattributed aggregates. */
	gap: number;
	runs: Map<string, Run>;
}

const EPOCH = "1970-01-01T00:00:00.000Z";
const notApplicable: Fact<number> = { kind: "absent", reason: "not-applicable" };
const unobserved = { kind: "unknown", reason: "not-observed" } as const satisfies Fact<number>;
const localClock = (value: number): Fact<number> => ({ kind: "measured", value, source: "local-clock" });
const counted = (value: number): FactSum => foldFacts([{ kind: "measured", value, source: "local-count" }]);
const unknownSum = (count: number): FactSum => foldFacts(Array.from({ length: count }, () => unobserved));
const header = (options: ReadOptions) => ({
	v: TELEMETRY_DTO_VERSION as typeof TELEMETRY_DTO_VERSION,
	foldVersion: TELEMETRY_FOLD_VERSION,
	generatedAt: (options.now ?? new Date()).toISOString(),
});

function attemptsOf(records: readonly TelemetryRecord[], attempts: readonly FoldedAttempt[]): Attempt[] {
	const meta = new Map<string, { startedAt?: string; settledAt?: string; ctx?: TelemetryContext; ids: Set<string> }>();
	for (const record of records) {
		if (record.k !== "call.started" && record.k !== "call.settled") continue;
		const entry = meta.get(record.data.attemptId) ?? { ids: new Set<string>() };
		entry.ids.add(record.id);
		entry.ctx ??= record.ctx;
		if (record.k === "call.started") {
			if (entry.startedAt === undefined || record.t < entry.startedAt) entry.startedAt = record.t;
		} else if (entry.settledAt === undefined || record.t < entry.settledAt) entry.settledAt = record.t;
		meta.set(record.data.attemptId, entry);
	}
	return attempts
		.map((attempt) => {
			const entry = meta.get(attempt.started.attemptId);
			return {
				...attempt,
				startedAt: entry?.startedAt ?? entry?.settledAt ?? EPOCH,
				settledAt: attempt.settled ? (entry?.settledAt ?? null) : null,
				ctx: entry?.ctx ?? null,
				recordIds: [...(entry?.ids ?? [])].sort(),
			};
		})
		.sort((a, b) =>
			a.startedAt === b.startedAt
				? a.started.attemptId.localeCompare(b.started.attemptId)
				: a.startedAt < b.startedAt
					? -1
					: 1,
		);
}

const unavailable: JournalSource = { present: false, records: [], modes: [], skipped: 0, damaged: 0 };
const POLICY_GAPS: ReadonlySet<string> = new Set(["mode-filtered", "research-cap"]);

function analyzeRun(runId: string, source: JournalSource, reference?: TelemetryRecord): Run {
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
	return {
		runId,
		source,
		fold,
		attempts,
		byAttempt: new Map(attempts.map((attempt) => [attempt.started.attemptId, attempt])),
		settled,
		firstAt,
		lastAt,
		sessionId: source.records[0]?.ctx.sessionId ?? reference?.ctx.sessionId ?? null,
		turnId: reference?.ctx.turnId ?? null,
		referencedAt: reference?.t ?? null,
		gap: !source.present || source.skipped > 0 || source.damaged > 0 ? 1 : 0,
	};
}

function analyzeRecords(
	sessionId: string,
	records: TelemetryRecord[],
	runSources: ReadonlyMap<string, JournalSource>,
	gap: number,
): Analysis {
	const fold = foldCallJournal(records);
	const attempts = attemptsOf(records, fold.attempts);
	const references = new Map<string, TelemetryRecord>();
	for (const record of records)
		if ((record.k === "run.ref" || record.k === "call.ref") && !references.has(record.data.runId))
			references.set(record.data.runId, record);
	const runs = new Map<string, Run>();
	for (const runId of [...new Set([...references.keys(), ...runSources.keys()])].sort())
		runs.set(runId, analyzeRun(runId, runSources.get(runId) ?? unavailable, references.get(runId)));
	return {
		sessionId,
		records,
		attempts,
		byAttempt: new Map(attempts.map((attempt) => [attempt.started.attemptId, attempt])),
		fold,
		// A mode-filtered or research-cap gap is policy: only research or content kinds go uncaptured, never
		// accountability, so neither makes a total partial (#434, R10).
		gap: gap + (records.some((record) => record.k === "gap" && !POLICY_GAPS.has(record.data.reason)) ? 1 : 0),
		runs,
	};
}

const analyses = new WeakMap<SessionSource, Analysis>();
function analyze(source: SessionSource): Analysis {
	let analysis = analyses.get(source);
	if (!analysis) {
		const read = source.journal.skipped > 0 || source.journal.damaged > 0 ? 1 : 0;
		analysis = analyzeRecords(
			source.sessionId,
			[...source.journal.records, ...source.legacy.records],
			source.runs,
			read + source.legacy.aggregates,
		);
		analyses.set(source, analysis);
	}
	return analysis;
}

/** A child's journal holds only its own calls; ancestors contribute theirs once, deduplicated by the fold (#434). */
const lineages = new WeakMap<SessionSource, Analysis>();
function analyzeLineage(source: SessionSource): Analysis {
	let analysis = lineages.get(source);
	if (analysis) return analysis;
	const records: TelemetryRecord[] = [];
	const runs = new Map<string, JournalSource>();
	let gap = 0;
	for (let node: SessionSource | null = source, depth = 0; node && depth < 128; depth += 1) {
		const own = analyze(node);
		records.push(...own.records);
		for (const [runId, run] of own.runs) if (!runs.has(runId)) runs.set(runId, run.source);
		gap += own.gap;
		if (node.parent && !node.parent.source) gap += 1;
		node = node.parent?.source ?? null;
	}
	analysis = analyzeRecords(source.sessionId, records, runs, gap);
	lineages.set(source, analysis);
	return analysis;
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
	run?: Run;
	gap: number;
}
interface Selection {
	parts: Part[];
	attempt?: Attempt;
	describe: string;
}

type View = { session: SessionSource } | { run: Run };
/** An absent run journal is already one unknown contribution; a damaged one adds its own. */
const runGap = (run: Run) => (run.source.present ? run.gap : 0);

function select(view: View, ref: ParsedFactRef): Selection | null {
	const group = ref.group;
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
		parts.push({
			attempts: group ? analysis.attempts.filter((attempt) => attemptInGroup(attempt, group)) : analysis.attempts,
			gap: analysis.gap,
		});
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
		default:
			// The cache-break bill and other unrecorded facts stay unknown until a call records them (#434 P2).
			return unobserved;
	}
}

function attemptsSum(attempts: readonly Attempt[], metric: FactMetric): FactSum {
	const totals = foldCalls(attempts);
	switch (metric) {
		case "calls":
			return counted(totals.logicalCalls);
		case "attempts":
			return counted(totals.attempts);
		case "neverSent":
		case "sentUnsettled":
		case "settledNoUsage":
		case "settled":
		case "incomplete":
			return counted(totals[metric]);
		case "input":
		case "output":
		case "cacheRead":
		case "cacheWrite":
		case "cacheWrite1h":
		case "reasoning":
			return totals.usage[metric];
		case "prompt":
			return totals.promptTokens;
		case "total":
			return totals.totalTokens;
		case "usd":
			return totals.usd;
		case "apiCalls":
			return counted(totals.settled + totals.settledNoUsage + totals.sentUnsettled);
		case "missingTokenCalls":
			return counted(foldCalls(attempts.filter(invoked)).totalTokens.unknownCount);
		case "runs":
			return counted(0);
		case "repairRounds":
			return foldFacts([]);
		default:
			return foldFacts(attempts.map((attempt) => attemptFact(attempt, metric)));
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
		for (const attempt of (part.attempts ?? []).filter(invoked)) {
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
		return {
			quantity: {
				fact,
				display: display(metric, fact, attempt.settled?.pricing.pricedBy === "free", attempt.settled?.pricing.pricedBy),
				ref: encoded,
			},
			selection,
		};
	}
	const sums = selection.parts.map((part) =>
		withGap(part.run ? runSum(part.run, ref.metric) : attemptsSum(part.attempts ?? [], ref.metric), part.gap),
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

type PricedBy = CallSettled["pricing"]["pricedBy"];
function pricedByCounts(parts: readonly Part[]): Record<PricedBy, number> {
	const counts: Record<PricedBy, number> = { provider: 0, "target-rates": 0, catalog: 0, free: 0, none: 0 };
	for (const part of parts) {
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

function journalCoverage(source: JournalSource, fold: ReturnType<typeof foldCallJournal>, aggregates = 0) {
	return {
		present: source.present,
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
	let closed: SessionTelemetryV1["lifetime"]["closed"] = null;
	let firstAt: string | null = null;
	let lastAt: string | null = null;
	for (const record of source.journal.records) {
		if (firstAt === null || record.t < firstAt) firstAt = record.t;
		if (lastAt === null || record.t > lastAt) lastAt = record.t;
		if (record.k === "session.closed" && (!closed || record.t >= closed.at))
			closed = { at: record.t, reason: record.data.reason };
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
		lifetime: { firstRecordAt: firstAt, lastRecordAt: lastAt, closed },
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

export function timeline(
	source: SessionSource,
	range: { from: string; to: string } | null = null,
	options: ReadOptions = {},
): TimelineV1 {
	const view: View = { session: source };
	const analysis = analyze(source);
	const id = source.sessionId;
	const entries: TimelineEntry[] = [];
	for (const attempt of analysis.attempts) {
		const q = (metric: FactMetric) => quantity(view, own(id, metric, { attemptId: attempt.started.attemptId }));
		entries.push({
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
			tokens: q("total"),
			usd: q("usd"),
			cacheVerdict: attempt.settled?.cache.verdict ?? "unknown",
		});
	}
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
		}
	}
	for (const run of analysis.runs.values())
		if (run.settled)
			entries.push({
				kind: "run",
				at: run.settled.at,
				runId: run.runId,
				event: "settled",
				terminalReason: run.settled.data.terminalReason,
			});
	const order: Record<TimelineEntry["kind"], number> = { session: 0, gap: 1, call: 2, compaction: 3, run: 4, turn: 5 };
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

export function runTelemetry(runId: string, source: JournalSource, options: ReadOptions = {}): RunTelemetryV1 {
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
	};
}

export function whyStopped(source: SessionSource, options: ReadOptions = {}): WhyStoppedV1 {
	const view: View = { session: source };
	const analysis = analyze(source);
	const id = source.sessionId;
	let last: { at: string; record: Extract<TelemetryRecord, { k: "turn.settled" }> } | null = null;
	let closedAt: string | null = null;
	for (const record of source.journal.records) {
		if (record.k === "turn.settled" && (!last || record.t >= last.at)) last = { at: record.t, record };
		if (record.k === "session.closed" && (!closedAt || record.t > closedAt)) closedAt = record.t;
	}
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
		findings,
	};
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
