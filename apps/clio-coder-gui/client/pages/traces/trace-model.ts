// What a run's journal says, before any of it is drawn: its status, the read model's totals, where each call and
// stage falls on the run's span, and what each timeline entry is called. Pure, so ordering and wording are testable
// without a browser. Every number shown is a server display; geometry is the only arithmetic here (#434).

import type { TraceRun, TraceRunStatus } from "../../../contracts/traces.js";
import type { CostReportV1, RunTelemetryV1, RunTimelineEntry } from "../../../contracts/wire.js";
import { formatDuration } from "../../api/clock.js";
import { omittedSentence } from "../../design/facts-model.js";
import type { StatusTone } from "../../design/status.js";
import { type Explainable, explainable } from "../../telemetry/quantity-model.js";

export interface RunTotal extends Explainable {
	label: string;
}

export interface HistogramRow {
	label: string;
	count: number;
	/** Width relative to the commonest kind, 0 to 1. */
	share: number;
}

export interface Histogram {
	rows: HistogramRow[];
	/** One sentence when rarer kinds were left out, empty when nothing was. */
	omitted: string;
}

export const HISTOGRAM_KINDS = 8;

const TONES: Record<TraceRunStatus, StatusTone> = {
	queued: "warn",
	running: "running",
	success: "success",
	fail: "fail",
	unknown: "neutral",
};
export function runTone(status: TraceRunStatus): StatusTone {
	return TONES[status];
}

/** A run the ledger still lists as in flight, so its journal and timeline keep growing. */
export const runIsLive = (status: TraceRunStatus | undefined) => status === "running" || status === "queued";

/** Where the run's span starts and ends: the ledger's times, else the journal's first and last records. */
export function runSpan(run: TraceRun, now: number): { start: number; end: number } | null {
	const start = Date.parse(run.identity?.startedAt ?? run.telemetry.firstAt ?? "");
	const ended = run.identity ? run.identity.endedAt : run.telemetry.lastAt;
	const end = ended ? Date.parse(ended) : runIsLive(run.status) ? now : Number.NaN;
	return Number.isFinite(start) && Number.isFinite(end) && end >= start ? { start, end } : null;
}

/** Tokens, cost and model calls from the run journal; wall time from the run's span; the runtime from the ledger. */
export function runTotals(run: TraceRun, detail: RunTelemetryV1 | undefined, now: number): RunTotal[] {
	const span = runSpan(run, now);
	return [
		{ label: "Tokens", ...explainable(detail?.tokens.total ?? run.telemetry.tokens) },
		{ label: "Cost", ...explainable(run.telemetry.usd) },
		{ label: "Model calls", ...explainable(detail?.counts.calls ?? run.telemetry.apiCalls) },
		{ label: "Wall time", value: span ? formatDuration(span.end - span.start) : "not recorded", factRef: null },
		{ label: "Runtime", value: run.identity?.runtimeId || "not recorded", factRef: null },
	];
}

/** The run's tokens by kind, then its cost and model calls: each the read model's quantity, explained (#434 §11.3). */
export function runSpend(detail: RunTelemetryV1): RunTotal[] {
	const tokens = detail.tokens;
	return [
		{ label: "Input", ...explainable(tokens.input) },
		{ label: "Output", ...explainable(tokens.output) },
		{ label: "Cache read", ...explainable(tokens.cacheRead) },
		{ label: "Cache write", ...explainable(tokens.cacheWrite) },
		{ label: "Cache write (1h)", ...explainable(tokens.cacheWrite1h) },
		{ label: "Reasoning", ...explainable(tokens.reasoning) },
		{ label: "Total tokens", ...explainable(tokens.total) },
		{ label: "Cost", ...explainable(detail.row.usd) },
		{ label: "Model calls", ...explainable(detail.counts.calls) },
	];
}

export interface ModelSpend {
	key: string;
	target: string;
	model: string;
	calls: Explainable;
	tokens: Explainable;
	cost: Explainable;
}

/**
 * The run's spend by the model each call settled on, from the read model's model groups: a fallback target is its
 * own row. A group's key is `<target>/<model>`; a target id holds no slash, while a model id may.
 */
export function runModelSpend(report: CostReportV1): ModelSpend[] {
	return report.groups.map((group) => {
		const slash = group.key.indexOf("/");
		return {
			key: group.key,
			target: (slash < 0 ? "" : group.key.slice(0, slash)) || "Unknown target",
			model: (slash < 0 ? group.key : group.key.slice(slash + 1)) || "Unknown model",
			calls: explainable(group.calls),
			tokens: explainable(group.tokens),
			cost: explainable(group.usd),
		};
	});
}

/** What the journal can and cannot vouch for, in one sentence; null when it read whole. */
export function journalNote(detail: RunTelemetryV1 | undefined): string | null {
	if (!detail) return null;
	const journal = detail.journal;
	if (!journal.present) return "No run journal was written for this run, so its calls and spend are unknown.";
	if (journal.skipped > 0 || journal.damaged > 0 || journal.gapRecords > 0 || journal.droppedRecords > 0)
		return "Part of this run's journal could not be read or was dropped; its totals are lower bounds.";
	return null;
}

/**
 * How many of each kind there were, commonest first. Ties order by name so two runs with the same
 * counts render identically.
 */
export function histogram(kinds: readonly string[], limit = HISTOGRAM_KINDS): Histogram {
	const counts = new Map<string, number>();
	for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
	const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	const shown = sorted.slice(0, limit);
	const widest = shown[0]?.[1] ?? 0;
	return {
		rows: shown.map(([label, count]) => ({ label, count, share: widest > 0 ? count / widest : 0 })),
		omitted: omittedSentence(sorted.length - shown.length, "kind"),
	};
}

type CallEntry = Extract<RunTimelineEntry, { kind: "call" }>;
/** A stable key per timeline entry: an attempt, a feed sequence, or the record's kind and time. */
export function entryKey(entry: RunTimelineEntry): string {
	switch (entry.kind) {
		case "call":
			return entry.attemptId;
		case "feed":
			return `feed:${entry.seq}`;
		case "process":
			return `process:${entry.event}:${entry.at}`;
		case "gap":
			return `gap:${entry.sink}:${entry.reason}:${entry.at}`;
		case "run":
			return `run:${entry.event}:${entry.at}`;
		case "route":
			return `route:${entry.decisionHash}:${entry.at}`;
	}
}

const FEED_NAMES: Record<string, string> = {
	agent_start: "Agent started",
	agent_end: "Agent finished",
	attempt_start: "Attempt started",
	message_end: "Message finished",
	thinking: "Thinking",
	route_warning: "Route warning",
	clio_coder_tool_start: "Tool started",
	clio_coder_tool_finish: "Tool finished",
	clio_coder_tool_observation: "Tool observation",
	clio_coder_permission_escalated: "Permission escalated",
	clio_coder_permission_resolved: "Permission resolved",
	clio_coder_run_outcome: "Run outcome",
	clio_coder_steer_received: "Steering received",
	unknown: "Unclassified event",
};

/** An entry's kind label and title, from the closed vocabularies the journal records. */
export function entryLabel(entry: RunTimelineEntry): { kind: string; title: string; tone: StatusTone } {
	switch (entry.kind) {
		case "call":
			return {
				kind: "call",
				title: `${entry.agent.role} call · ${entry.disposition.replaceAll("_", " ")}${entry.failure ? ` (${entry.failure})` : ""}`,
				tone: entry.failure || entry.disposition === "settled_no_usage" ? "fail" : "neutral",
			};
		case "feed": {
			const body = entry.body;
			if (body.kind === "event") {
				const name = FEED_NAMES[body.type] ?? body.type;
				return {
					kind: body.type,
					title: body.tool ? `${name}: ${body.tool}` : name,
					tone: body.outcome === "error" || body.outcome === "blocked" ? "fail" : "neutral",
				};
			}
			if (body.kind === "open") return { kind: "open", title: `Run opened for ${body.agentId}`, tone: "neutral" };
			if (body.kind === "journal_truncated")
				return { kind: "journal_truncated", title: "Feed truncated at the per-run size cap", tone: "warn" };
			return {
				kind: body.kind,
				title: `${body.kind === "result" ? "Result" : "Terminal outcome"}: ${body.outcome.replaceAll("_", " ")}`,
				tone: body.outcome === "succeeded" ? "success" : body.outcome === "unknown" ? "neutral" : "fail",
			};
		}
		case "process":
			return {
				kind: "process",
				title: entry.event === "started" ? "Worker process started" : `Worker process exited with code ${entry.exitCode}`,
				tone: entry.event === "exited" && entry.exitCode !== 0 ? "fail" : "neutral",
			};
		case "gap":
			return { kind: "gap", title: `Journal gap: ${entry.reason} in ${entry.sink}`, tone: "warn" };
		case "run":
			return {
				kind: "run",
				title: `Run ${entry.event}${entry.terminalReason ? `: ${entry.terminalReason.replaceAll("_", " ")}` : ""}`,
				tone: entry.terminalReason === "completed" ? "success" : entry.terminalReason ? "fail" : "neutral",
			};
		case "route":
			return {
				kind: "route",
				title: `Route ${entry.mode}: ${entry.executed.agentId} on ${entry.executed.targetId}/${entry.executed.modelId}${entry.differs ? " (policy differs)" : ""}`,
				tone: entry.executedAdmissible ? "neutral" : "fail",
			};
	}
}

/** A call's place on the run's span, as percentages of it; null when either end is missing. */
export function callPosition(
	call: CallEntry,
	span: { start: number; end: number },
	now: number,
): { left: number; width: number } | null {
	const start = Date.parse(call.at);
	const end = call.endAt ? Date.parse(call.endAt) : call.disposition === "incomplete" ? now : Number.NaN;
	const total = span.end - span.start;
	if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || total <= 0) return null;
	const left = Math.max(0, Math.min(100, ((start - span.start) / total) * 100));
	return { left, width: Math.max(0, Math.min(100 - left, ((end - start) / total) * 100)) };
}

export interface StageBar {
	stage: string;
	/** Percentages of the call's own bar. */
	left: number;
	width: number;
}

const STAGE_ORDER = ["admission", "auth", "transform", "connect", "send"] as const;
/**
 * A call's recorded stages as segments of its bar, from the offsets the journal holds; the model's time runs from
 * the first token to settle. An unrecorded stage draws nothing, so no stage is ever inferred.
 */
export function stageBars(call: CallEntry): StageBar[] {
	const stages = call.stages;
	if (!stages || stages.settle === null || stages.settle <= 0) return [];
	const total = stages.settle;
	const bar = (stage: string, from: number, to: number): StageBar[] =>
		to > from && from >= 0
			? [{ stage, left: (from / total) * 100, width: ((Math.min(to, total) - Math.min(from, total)) / total) * 100 }]
			: [];
	return [
		...STAGE_ORDER.flatMap((stage) => {
			const span = stages[stage];
			return span ? bar(stage, span.start, span.end) : [];
		}),
		...(stages.firstToken !== undefined ? bar("model", stages.firstToken, total) : []),
	];
}
