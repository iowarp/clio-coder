import type { WorkerTelemetryContext } from "../../core/telemetry/context.js";
import type { FailureCause } from "../../core/telemetry/enums.js";
import type { TelemetryRecord } from "../../core/telemetry/envelope.js";
import { makeTelemetryRecord } from "../../core/telemetry/envelope.js";
import type { EstimateMethod, Fact, FactSum } from "../../core/telemetry/fact.js";
import { readWorkerTelemetryRecord } from "../../core/telemetry/forwarder.js";
import { type RunSpendSums, sumFacts, unobservedRunUsageFacts } from "../../core/telemetry/pricing.js";
import { abandonedSettlement } from "../../core/telemetry/producer.js";
import type { CallSettled, RunUsageFacts } from "../../core/telemetry/schemas.js";
import type { CallTotals, FoldOptions } from "../telemetry/folds.js";
import { addCallTotals, emptyCallTotals, foldRunJournal } from "../telemetry/folds.js";

export interface RunCallUsage {
	callIds: string[];
	callFacts: CallTotals;
	usageFacts: CallTotals["usage"];
	/** The journal may hold calls this fold could not count: a gap, an unclosed attempt or an unresolved reference. */
	coverageUnknown: boolean;
	/** The run's spend as sums over its calls, so a budget counts the priced part of a partly priced run (#434). */
	sums: RunSpendSums;
	/** The same fold as one fact per quantity, as run.settled records it (#434). */
	facts: RunUsageFacts;
}

export type { RunUsageFacts };

const notObserved: Fact<number> = { kind: "unknown", reason: "not-observed" };

export { unobservedRunUsageFacts };

type Provenance = { methods: Set<EstimateMethod>; sources: Set<MeasuredSource> };
type MeasuredSource = Extract<Fact<number>, { kind: "measured" }>["source"];

/** Where each quantity's facts came from, keyed by field name, so a collapsed fact names a real method or source. */
function provenanceOf(payloads: readonly unknown[]): Map<string, Provenance> {
	const found = new Map<string, Provenance>();
	const note = (key: string, method: EstimateMethod | undefined, source: MeasuredSource | undefined) => {
		const entry = found.get(key) ?? { methods: new Set(), sources: new Set() };
		if (method !== undefined) entry.methods.add(method);
		if (source !== undefined) entry.sources.add(source);
		found.set(key, entry);
	};
	const visit = (value: unknown, key: string, pricedBy: unknown) => {
		if (value === null || typeof value !== "object") return;
		const fact = value as { kind?: unknown; method?: unknown; source?: unknown; coverage?: unknown };
		if (fact.kind === "estimated" || fact.kind === "measured") {
			if (fact.kind === "estimated") note(key, fact.method as EstimateMethod, undefined);
			else note(key, undefined, fact.source as MeasuredSource);
			return;
		}
		// A reported scope's sums carry no method of their own; its pricing says who priced it (#434).
		if (fact.coverage !== undefined && "unknownCount" in fact) {
			const sum = value as FactSum;
			const usd = key === "usd";
			if (sum.coverage.estimated > 0)
				note(key, usd && (pricedBy === "catalog" || pricedBy === "target-rates") ? pricedBy : "peer-report", undefined);
			if (sum.coverage.measured > 0)
				note(key, undefined, key === "apiCalls" || (usd && pricedBy === "target-rates") ? "local-count" : "provider");
			return;
		}
		const priced = (value as { pricing?: { pricedBy?: unknown } }).pricing?.pricedBy ?? pricedBy;
		// A cache bill prices re-prefill, which is not the run's spend.
		for (const [child, item] of Object.entries(value)) if (child !== "cache") visit(item, child, priced);
	};
	for (const payload of payloads) visit(payload, "", undefined);
	return found;
}

/**
 * One fact for a folded quantity: unknown when any contribution is, estimated when any was, else measured. The
 * read model's fold over the same calls keeps the per-call coverage this collapses (#434).
 */
function collapse(sum: FactSum, provenance: Provenance | undefined, fallback: MeasuredSource): Fact<number> {
	if (sum.unknownCount > 0) return notObserved;
	if (sum.coverage.estimated > 0) {
		const method = [...(provenance?.methods ?? [])].sort()[0];
		return method === undefined ? notObserved : { kind: "estimated", value: sum.measured + sum.estimated, method };
	}
	if (sum.coverage.measured > 0)
		return { kind: "measured", value: sum.measured, source: [...(provenance?.sources ?? [])].sort()[0] ?? fallback };
	if (sum.absentCount > 0) return { kind: "absent", reason: "not-applicable" };
	return { kind: "measured", value: 0, source: "local-count" };
}

const PRICED_BY_STRENGTH: readonly RunUsageFacts["pricing"]["pricedBy"][] = [
	"none",
	"catalog",
	"target-rates",
	"provider",
];

/** The weakest pricing a set of priced contributions used, so a mixed run never claims more than its least source. */
function weakestPricedBy(used: Set<RunUsageFacts["pricing"]["pricedBy"]>): RunUsageFacts["pricing"]["pricedBy"] {
	if (used.size === 0) return "none";
	if (used.size === 1) return [...used][0] ?? "none";
	used.delete("free");
	return PRICED_BY_STRENGTH.find((strength) => used.has(strength)) ?? "none";
}

/** The pricing behind the contributions the fold counted: a whole-scope snapshot replaces calls and parts (#434). */
function pricedByOf(
	records: readonly TelemetryRecord[],
	folded: ReturnType<typeof foldRunJournal>,
): RunUsageFacts["pricing"]["pricedBy"] {
	if (folded.source === "conflict") return "none";
	if (folded.source === "aggregate") return folded.aggregate?.pricing.pricedBy ?? "none";
	const used = new Set<RunUsageFacts["pricing"]["pricedBy"]>();
	for (const attempt of folded.calls.attempts)
		if (attempt.settled && attempt.settled.disposition !== "never_sent") used.add(attempt.settled.pricing.pricedBy);
	if (folded.source === "parts")
		for (const record of records)
			if (record.k === "run.usage_reported" && record.data.partId !== undefined) used.add(record.data.pricing.pricedBy);
	return weakestPricedBy(used);
}

function runUsageFacts(records: readonly TelemetryRecord[], folded: ReturnType<typeof foldRunJournal>): RunUsageFacts {
	const provenance = provenanceOf(records.map((record) => record.data));
	const field = (key: string, sum: FactSum, fallback: MeasuredSource = "provider") =>
		collapse(sum, provenance.get(key), fallback);
	return {
		usage: {
			input: field("input", folded.usage.input),
			cacheRead: field("cacheRead", folded.usage.cacheRead),
			cacheWrite: field("cacheWrite", folded.usage.cacheWrite),
			cacheWrite1h: field("cacheWrite1h", folded.usage.cacheWrite1h),
			output: field("output", folded.usage.output),
			reasoning: field("reasoning", folded.usage.reasoning),
		},
		totalTokens: field("totalTokens", folded.totalTokens),
		apiCalls: field("apiCalls", folded.apiCalls, "local-count"),
		pricing: { usd: field("usd", folded.usd, "local-count"), pricedBy: pricedByOf(records, folded) },
	};
}

export type CallSpend = Pick<CallSettled, "disposition" | "usage" | "pricing">;

/** A run's spend from settlements a host holds outside a run journal, such as a headless main agent's calls (#434). */
export function runUsageFromCalls(calls: readonly CallSpend[]): { facts: RunUsageFacts; sums: RunSpendSums } {
	const totals = emptyCallTotals();
	for (const call of calls) addCallTotals(totals, call);
	const provenance = provenanceOf(calls);
	const field = (key: string, sum: FactSum, fallback: MeasuredSource = "provider") =>
		collapse(sum, provenance.get(key), fallback);
	const sent = calls.filter((call) => call.disposition !== "never_sent");
	const apiCalls: Fact<number> = { kind: "measured", value: sent.length, source: "local-count" };
	const facts: RunUsageFacts = {
		usage: {
			input: field("input", totals.usage.input),
			cacheRead: field("cacheRead", totals.usage.cacheRead),
			cacheWrite: field("cacheWrite", totals.usage.cacheWrite),
			cacheWrite1h: field("cacheWrite1h", totals.usage.cacheWrite1h),
			output: field("output", totals.usage.output),
			reasoning: field("reasoning", totals.usage.reasoning),
		},
		totalTokens: field("total", totals.totalTokens),
		apiCalls,
		pricing: {
			usd: field("usd", totals.usd, "local-count"),
			pricedBy: weakestPricedBy(new Set(sent.map((call) => call.pricing.pricedBy))),
		},
	};
	return {
		facts,
		sums: { usage: totals.usage, totalTokens: totals.totalTokens, apiCalls: sumFacts([apiCalls]), usd: totals.usd },
	};
}

/** Live meters and run settlement project the same fold as session replay; unknown facts retain coverage (#434). */
export function runUsageFromCallRecords(input: Iterable<TelemetryRecord>, options: FoldOptions = {}): RunCallUsage {
	const records = [...input];
	const folded = foldRunJournal(records, options);
	return {
		callIds: [...new Set(folded.calls.attempts.map(({ started }) => started.callId))].sort(),
		callFacts: folded.calls.totals,
		usageFacts: folded.usage,
		coverageUnknown: folded.unknownCoverage,
		sums: { usage: folded.usage, totalTokens: folded.totalTokens, apiCalls: folded.apiCalls, usd: folded.usd },
		facts: runUsageFacts(records, folded),
	};
}

/** The receipt path drains this same stream before sealing; display replay never updates this projection (#434). */
export function createRunCallUsage(context: WorkerTelemetryContext) {
	const records: TelemetryRecord[] = [];
	let snapshot: RunCallUsage | undefined;
	return {
		observe(frame: unknown): boolean {
			const record = readWorkerTelemetryRecord(frame, context);
			if (!record) return false;
			if (record.k === "process.started") {
				snapshot ??= runUsageFromCallRecords(records);
				return true;
			}
			if (
				record.k !== "call.started" &&
				record.k !== "call.settled" &&
				record.k !== "run.usage_reported" &&
				record.k !== "journal.gap"
			)
				return true;
			records.push(record);
			snapshot = runUsageFromCallRecords(records);
			return true;
		},
		gap(count = 1): void {
			if (!snapshot || count < 1) return;
			records.push(
				makeTelemetryRecord("journal.gap", { sink: "worker-ndjson", reason: "writer-drop", count }, context, {
					t: new Date().toISOString(),
					mono: performance.now(),
				}),
			);
			snapshot = runUsageFromCallRecords(records);
		},
		/**
		 * Settle every attempt the worker started and never settled, once its stream has ended. A killed worker cannot
		 * settle its own, and the host cannot see its stages, so each reads as sent with its spend unknown (#434).
		 */
		settleOpen(cause: FailureCause): TelemetryRecord<"call.settled">[] {
			const settledAttempts = new Set(
				records.flatMap((record) => (record.k === "call.settled" ? [record.data.attemptId] : [])),
			);
			const open = new Map<string, TelemetryRecord<"call.started">>();
			for (const record of records)
				if (record.k === "call.started" && !settledAttempts.has(record.data.attemptId))
					open.set(record.data.attemptId, record);
			const settled = [...open.values()].map((started) =>
				makeTelemetryRecord(
					"call.settled",
					{ ...started.data, ...abandonedSettlement(true, cause), stages: { settle: null } },
					started.ctx,
					{ t: new Date().toISOString(), mono: performance.now() },
				),
			);
			if (settled.length === 0) return settled;
			records.push(...settled);
			snapshot = runUsageFromCallRecords(records);
			return settled;
		},
		snapshot: () => snapshot,
	};
}
