import type { ContextActivityPayload, ContextOperation, ContextOperationFact } from "../../contracts/wire.js";
import type { StatusTone } from "../design/status.js";

/** One fact of the summary line: a verb and what it applied to, either counted or named. */
export interface ContextWorkPart {
	key: string;
	verb: string;
	value: string;
	/** A path or file name, drawn in the code face. */
	code: boolean;
}

/** Presentation values only; the ACP projection supplies the operation's actual evidence. */
export interface ContextWorkView {
	id: string;
	title: string;
	label: string;
	tone: StatusTone;
	live: boolean;
	/** Elapsed time for the header: `21s` once measured by the runtime, `~2s` while the clock estimates it. */
	elapsed: string | null;
	/** The one sentence a live or unavailable operation says; a result speaks through `summary` and `issues`. */
	message: string | null;
	/** `step 2 of 5` while the runtime reports more than one stage. */
	step: string | null;
	/** The item being worked on, for example a file path. */
	current: string | null;
	progress: { current: number; total: number; text: string } | null;
	/** What a finished operation did, most useful first, bounded for one or two lines. */
	summary: readonly ContextWorkPart[];
	/** Facts the summary line left for the details. */
	more: number;
	/** What went wrong or was worth a warning, as the runtime reported it. */
	issues: { kind: "warning" | "failure" | "stopped"; items: readonly string[]; hidden: number } | null;
	details: ContextWorkDetails;
}

/** The collapsed surface: everything the header and summary do not say, stated once. */
export interface ContextWorkDetails {
	rows: readonly { term: string; text: string; code: boolean }[];
	facts: readonly { key: string; verb: string; value: string; paths: readonly string[] }[];
	phases: readonly { key: string; label: string; current: boolean }[];
	/** Every warning, including those the card shows inline. */
	warnings: readonly string[];
}

export const CONTEXT_PHASE_LABELS: Readonly<Record<string, string>> = {
	scan: "Read repository",
	codewiki: "Index source",
	generate: "Draft context",
	"clio-md": "Project instructions",
	state: "Record state",
	compact: "Prepare compaction",
	summarize: "Summarize history",
	done: "Result",
};

const TITLES: Readonly<Record<ContextOperation["kind"], string>> = {
	"context-init": "Project context",
	"context-clear": "Context reset",
	"context-refresh": "Context refresh",
	"context-recall": "Context recall",
	"context-recover": "Context recovery",
	compaction: "Context compaction",
};
const OUTCOMES: Readonly<Record<NonNullable<ContextOperation["outcome"]>, { label: string; tone: StatusTone }>> = {
	completed: { label: "Complete", tone: "success" },
	previewed: { label: "Preview", tone: "neutral" },
	unchanged: { label: "Unchanged", tone: "neutral" },
	cancelled: { label: "Stopped", tone: "neutral" },
	failed: { label: "Failed", tone: "fail" },
};

// Preview changes are prospective; reads, summaries and recalls report work already performed.
const FACT_VERBS: Readonly<Record<ContextOperationFact["kind"], readonly [string, string]>> = {
	created: ["Created", "Would create"],
	updated: ["Updated", "Would update"],
	indexed: ["Indexed", "Would index"],
	ingested: ["Ingested", "Would ingest"],
	preserved: ["Preserved", "Would preserve"],
	omitted: ["Omitted", "Would omit"],
	removed: ["Removed", "Would remove"],
	read: ["Read", "Read"],
	summarized: ["Summarized", "Summarized"],
	recalled: ["Recalled", "Recalled"],
};

const FACT_UNITS: Readonly<Record<ContextOperationFact["unit"], readonly [string, string]>> = {
	paths: ["path", "paths"],
	"source-files": ["source file", "source files"],
	rules: ["rule", "rules"],
	messages: ["message", "messages"],
	entries: ["entry", "entries"],
	observations: ["observation", "observations"],
};

/** The summary line holds a handful of facts; the rest wait in the details. */
const SUMMARY_PARTS = 4;
/** Warnings beyond these wait in the details, announced by a count. */
const INLINE_ISSUES = 3;
// The operator's own request reads as noise beside "Requested by you".
const PLAIN_REASON = /^(?:operator(?: command)?|manual request)$/i;

const number = (value: number): string => value.toLocaleString("en-US");

function duration(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Progress text can carry file names and provider output; one tidy line is all a status needs. */
function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function sentence(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

function factPart(fact: ContextOperationFact, previewed: boolean): Omit<ContextWorkPart, "key"> {
	const verb = FACT_VERBS[fact.kind][previewed ? 1 : 0];
	const paths = fact.paths ?? [];
	const count = fact.count ?? (fact.unit === "paths" && paths.length > 0 ? paths.length : null);
	const [singular, plural] = FACT_UNITS[fact.unit];
	// One named file reads better than "1 path": "Preserved CLIO-CODER.md".
	const only = paths.length === 1 ? paths[0] : undefined;
	if (only !== undefined && (count === null || count === 1)) return { verb, value: only, code: true };
	return { verb, value: count === null ? plural : `${number(count)} ${count === 1 ? singular : plural}`, code: false };
}

function tokenPart(tokens: NonNullable<ContextOperation["tokens"]>): ContextWorkPart {
	const change = tokens.after - tokens.before;
	const delta = change === 0 ? "no change" : `${change < 0 ? "−" : "+"}${number(Math.abs(change))}`;
	return {
		key: "tokens",
		verb: "Estimated tokens",
		value: `${number(tokens.before)} → ${number(tokens.after)} (${delta})`,
		code: false,
	};
}

function originText(operation: ContextOperation): string {
	const reason = operation.reason.trim();
	if (operation.origin === "automatic") return reason ? `Started automatically: ${reason}` : "Started automatically";
	return reason && !PLAIN_REASON.test(reason) ? `Requested by you: ${reason}` : "Requested by you";
}

/** Elapsed during live work is a clock estimate; a completed span comes from the owning runtime. */
export function contextWorkView(
	operation: ContextOperation,
	activity?: ContextActivityPayload,
	nowMs = 0,
	available = true,
): ContextWorkView {
	const live = operation.outcome === undefined && available;
	const result = operation.outcome ? OUTCOMES[operation.outcome] : null;
	const reported = operation.warnings ?? [];
	const failure = operation.outcome === "failed";
	const stopped = operation.outcome === "cancelled";
	// The runtime appends the terminal cause of a failed or stopped operation after its other warnings, so it
	// is found by position before duplicates are dropped, and it always keeps its place at the end.
	const cause = (failure || stopped) && reported.length > 0 ? reported[reported.length - 1] : undefined;
	const others = [...new Set(cause === undefined ? reported : reported.slice(0, -1))].filter(
		(warning) => warning !== cause,
	);
	const warnings = cause === undefined ? others : [...others, cause];
	const elapsed = operation.elapsedMs ?? (live && nowMs > 0 ? nowMs - Date.parse(operation.startedAt) : null);
	const measured = operation.elapsedMs !== undefined;
	const clock =
		elapsed !== null && Number.isFinite(elapsed) && elapsed >= 1000 ? `${measured ? "" : "~"}${duration(elapsed)}` : null;
	const stage = activity?.phase;
	const previewed = operation.outcome === "previewed";
	const phases = (activity?.stages ?? (stage && stage !== "done" ? [stage] : [])).map((key) => ({
		key,
		label: CONTEXT_PHASE_LABELS[key] ?? key,
		current: key === stage,
	}));
	const position = phases.findIndex((phase) => phase.current);

	const facts = (operation.facts ?? []).map((fact, index) => ({
		fact,
		part: { key: `${fact.kind}:${fact.unit}:${index}`, ...factPart(fact, previewed) },
	}));
	// A zero says nothing a result needs to lead with; it stays in the details.
	const leading = facts.filter(({ fact }) => fact.count !== 0 || (fact.paths?.length ?? 0) > 0);
	const worth = leading.length > 0 ? leading : facts;
	const parts: ContextWorkPart[] = worth.slice(0, SUMMARY_PARTS).map(({ part }) => part);
	if (operation.tokens) parts.push(tokenPart(operation.tokens));
	// The details add what the summary line could not say: facts it left out and the paths behind a count.
	const summarized = new Set(parts.map((part) => part.key));
	const detailFacts = facts
		.filter(({ fact, part }) => !summarized.has(part.key) || ((fact.paths?.length ?? 0) > 0 && !part.code))
		.map(({ fact, part }) => ({ key: part.key, verb: part.verb, value: part.value, paths: fact.paths ?? [] }));

	const current = activity?.detail ? oneLine(activity.detail) : "";
	const inline = cause === undefined ? warnings.slice(0, INLINE_ISSUES) : [...others.slice(0, INLINE_ISSUES - 1), cause];
	const rows: { term: string; text: string; code: boolean }[] = [
		{ term: "Origin", text: originText(operation), code: false },
	];
	if (clock !== null && elapsed !== null)
		rows.push({
			term: "Time",
			text: measured
				? `${duration(elapsed)}, measured by the context runtime`
				: `About ${duration(elapsed)} so far, from this browser's clock`,
			code: false,
		});
	if (operation.tokens)
		rows.push({
			term: "Tokens",
			text: "Estimated by the runtime from its own accounting. Provider usage is not measured here.",
			code: false,
		});
	if (live && current) rows.push({ term: "Now", text: current, code: true });
	rows.push({ term: "Operation", text: operation.id, code: true });
	rows.push({ term: "Started", text: operation.startedAt, code: true });
	rows.push({ term: "Workspace", text: operation.cwd, code: true });

	return {
		id: operation.id,
		title: TITLES[operation.kind],
		label:
			operation.outcome === "completed" && warnings.length > 0
				? `Complete, ${warnings.length} ${warnings.length === 1 ? "warning" : "warnings"}`
				: (result?.label ?? (live ? "Running" : "Status unavailable")),
		tone: result
			? result.tone === "success" && warnings.length > 0
				? "warn"
				: result.tone
			: live
				? "running"
				: "unverified",
		live,
		elapsed: clock,
		message: result
			? null
			: live
				? sentence(oneLine(activity?.message ?? "")) || "Working on context…"
				: "The operation's final result was not reported.",
		step: live && phases.length > 1 && position >= 0 ? `step ${position + 1} of ${phases.length}` : null,
		current: live && current ? current : null,
		progress:
			live &&
			activity?.current !== undefined &&
			activity.total !== undefined &&
			activity.total > 0 &&
			activity.current >= 0 &&
			activity.current <= activity.total
				? {
						current: activity.current,
						total: activity.total,
						text: `${number(activity.current)} of ${number(activity.total)}`,
					}
				: null,
		summary: result ? parts : [],
		more: result ? Math.max(0, worth.length - SUMMARY_PARTS) : 0,
		issues:
			warnings.length > 0
				? {
						kind: failure ? "failure" : stopped ? "stopped" : "warning",
						items: inline,
						hidden: warnings.length - inline.length,
					}
				: null,
		details: {
			rows,
			facts: detailFacts,
			phases: live ? phases : [],
			warnings,
		},
	};
}
