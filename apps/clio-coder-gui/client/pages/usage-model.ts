// The usage report's own order, in the operator's words. `facts[].values` is `Record<string,
// unknown>` on the wire because the CLI's schema is experimental, so every key is read defensively
// here and anything this module does not know about is handed back for <Facts> rather than dropped.
// Pure, so the wording and the ordering are testable without a browser.

import type { UsageReport } from "../../contracts/reports.js";
import { formatCost, formatDay, formatTokens } from "../api/clock.js";
import { humanizeKey, scalarText } from "../design/facts-model.js";
import { emptyState } from "../design/panel-model.js";

export interface UsageFigure {
	label: string;
	value: string;
	note?: string;
}

export interface UsageBar {
	label: string;
	value: string;
	/** Width relative to the largest bar, 0 to 1. Never a share of the total: these fields overlap. */
	share: number;
}

export interface UsageGroup {
	name: string;
	label: string;
	values: Record<string, unknown>;
	/** A fact whose whole content is one count reads as the figure, not as a "Value" row. */
	single: string | null;
}

/**
 * Facts that repeat, such as one `session-cache` row per session, read as one table rather than as
 * one card each. A month of real use records dozens of them, and a card apiece made the page thirty
 * screens tall.
 */
export interface UsageTable {
	name: string;
	label: string;
	total: number;
	columns: string[];
	rows: string[][];
	/** Rows beyond the display bound. */
	omitted: number;
	/** Columns beyond the display bound. */
	omittedColumns: number;
}
export const USAGE_TABLE_LIMITS = { rows: 24, columns: 6 } as const;

export interface UsageView {
	window: string;
	headline: UsageFigure[];
	bars: UsageBar[];
	barsCaveat: string;
	knownSubtotals: string | null;
	origins: UsageFigure[];
	originsNote: string;
	missingStores: string[];
	models: UsageGroup[];
	skillsActivated: UsageGroup[];
	skillsDormant: string[];
	/** Facts recorded once, shown as a card each. */
	rest: UsageGroup[];
	/** Facts recorded more than once, shown as one table per name. */
	tables: UsageTable[];
}

/** Bars compare token fields with one another. Provider accounting can report the same tokens twice. */
export const BARS_CAVEAT =
	"Bars compare token fields with one another; they are not additive percentages. Provider accounting can overlap cache and reasoning fields.";

const TOKEN_BARS: ReadonlyArray<readonly [string, string]> = [
	["input", "Input"],
	["output", "Output"],
	["cacheRead", "Cache read"],
	["cacheWrite", "Cache write"],
	["reasoningTokens", "Reasoning"],
];

const ORIGINS: ReadonlyArray<readonly [string, string]> = [
	["turns", "Conversation and compaction calls"],
	["sideQuestions", "Side questions"],
	["handoffs", "Handoffs"],
	["prewarms", "Pre-warms"],
	["backgroundMemorySteps", "Background memory steps"],
	["failedCompactionCalls", "Failed compaction calls"],
	["systemOneCalls", "System One calls"],
	["safetyJudgeCalls", "Safety judge calls"],
];

/** These four are read out of the report by name; everything else keeps its wire shape. */
const CLAIMED = new Set([
	"tokens",
	"all-recorded-tokens",
	"worker-model-usage",
	"sessions",
	"dispatch-runs",
	"session-store-missing",
	"receipt-store-missing",
	"model-usage",
	"skill-activated",
	"skill-never-activated",
]);

const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const single = (values: Record<string, unknown>): string | null => {
	const keys = Object.keys(values);
	const only = keys.length === 1 && keys[0] === "value" ? number(values.value) : null;
	return only === null ? null : only.toLocaleString("en-US");
};
const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/**
 * Words for a wire key, used only for the facts this module does not name itself. It is the same
 * humanizer the fact renderer uses, so one vocabulary covers every inspector.
 */
export const usageLabel = humanizeKey;

/** One cell. A nested record reads as `hot 0 · cold 13`, never as JSON. */
function cell(key: string, value: unknown): string {
	if (Array.isArray(value)) return value.length ? value.map((item) => cell(key, item)).join(", ") : "None";
	if (value && typeof value === "object")
		return (
			Object.entries(value)
				.map(([inner, item]) => `${humanizeKey(inner).toLowerCase()} ${cell(inner, item)}`)
				.join(" · ") || "None"
		);
	return scalarText(key, value as string | number | boolean | null | undefined).text;
}

function tablesOf(rows: UsageGroup[]): { singles: UsageGroup[]; tables: UsageTable[] } {
	const byName = new Map<string, UsageGroup[]>();
	for (const row of rows) byName.set(row.name, [...(byName.get(row.name) ?? []), row]);
	const singles: UsageGroup[] = [];
	const tables: UsageTable[] = [];
	for (const [name, members] of byName) {
		const first = members[0];
		if (!first) continue;
		if (members.length === 1) {
			singles.push(first);
			continue;
		}
		const keys = [...new Set(members.flatMap((member) => Object.keys(member.values)))];
		const shown = keys.slice(0, USAGE_TABLE_LIMITS.columns);
		tables.push({
			name,
			label: first.label,
			total: members.length,
			columns: shown.map(humanizeKey),
			rows: members.slice(0, USAGE_TABLE_LIMITS.rows).map((member) => shown.map((key) => cell(key, member.values[key]))),
			omitted: Math.max(0, members.length - USAGE_TABLE_LIMITS.rows),
			omittedColumns: keys.length - shown.length,
		});
	}
	return { singles, tables };
}

export function usageView(report: UsageReport): UsageView {
	const rows = report.facts.map((fact) => ({
		name: fact.name,
		label: usageLabel(fact.name),
		values: fact.values,
		single: single(fact.values),
	}));
	const first = (name: string) => rows.find((row) => row.name === name)?.values;
	const all = (name: string) => rows.filter((row) => row.name === name);
	const sessionTokens = first("tokens") ?? {};
	const overall = first("all-recorded-tokens");
	const workers = first("worker-tokens");
	const tokens = overall ?? sessionTokens;
	const cost = tokens.cost as
		| { knownUsd?: number; hasEstimated?: boolean; hasUnknown?: boolean; allKnownFree?: boolean; calls?: number }
		| undefined;
	const missing = number(overall?.missingTokenCalls ?? sessionTokens.missingTokenCalls) ?? 0;

	const missingStores: string[] = [];
	for (const [name, subject] of [
		["session-store-missing", "session history"],
		["receipt-store-missing", "dispatch receipt"],
	] as const) {
		const row = first(name);
		if (row) missingStores.push(emptyState.missingStore(subject, text(row.path)));
	}

	const store = (name: string, missing: string, label: string): UsageFigure => {
		const row = first(name);
		const count = number(row?.value);
		if (first(missing) || count === null) return { label, value: "—", note: emptyState.dash() };
		return { label, value: count.toLocaleString("en-US") };
	};

	const apiCalls = number(tokens.apiCalls);
	const measuredTokens = number(overall?.knownSubtotal ?? tokens.totalTokens);
	const totalTokens =
		measuredTokens === 0 && missing > 0 && apiCalls !== null && missing >= apiCalls ? null : measuredTokens;
	const headline: UsageFigure[] = [
		{
			label: "Tokens",
			value: formatTokens(totalTokens),
			...(apiCalls === null ? {} : { note: `${apiCalls.toLocaleString("en-US")} API calls` }),
		},
		{
			label: "Cost",
			value: cost
				? cost.calls === 0 || (cost.hasUnknown && !cost.knownUsd)
					? "—"
					: `${cost.hasEstimated ? "~" : ""}${formatCost(number(cost.knownUsd))}${cost.hasUnknown ? " +?" : ""}`
				: formatCost(number(tokens.costUsd)),
			note:
				cost?.calls === 0
					? "No priced calls recorded in this window"
					: cost?.hasUnknown
						? "Known subtotal; some calls are unpriced"
						: cost?.hasEstimated
							? "Includes estimated prices"
							: cost
								? cost.allKnownFree
									? "Every recorded call is known free"
									: "Recorded prices"
								: "Historical cost; pricing provenance unavailable",
		},
		store("sessions", "session-store-missing", "Sessions"),
		store("dispatch-runs", "receipt-store-missing", "Dispatch runs"),
	];

	const partialBreakdown = missing > 0 || (number(workers?.missingBreakdownRuns) ?? 0) > 0;
	const measured = TOKEN_BARS.map(([key, label]) => {
		const value = number(tokens[key]);
		return { label, tokens: value === 0 && partialBreakdown ? null : value };
	});
	const widest = Math.max(0, ...measured.map((bar) => bar.tokens ?? 0));
	const bars: UsageBar[] = measured.map((bar) => ({
		label: bar.label,
		value: `${formatTokens(bar.tokens)}${bar.tokens !== null && partialBreakdown ? " +?" : ""}`,
		share: bar.tokens && widest > 0 ? bar.tokens / widest : 0,
	}));

	const hasOriginSplit = ORIGINS.some(([key]) => Object.hasOwn(sessionTokens, key));
	const origins = ORIGINS.flatMap(([key, label]) => {
		if (!Object.hasOwn(sessionTokens, key)) return [];
		const value = number(sessionTokens[key]);
		return [{ label, value: value === null ? "Not recorded" : value.toLocaleString("en-US") }];
	});
	if (!hasOriginSplit && first("tokens") && workers) {
		const calls = number(sessionTokens.apiCalls);
		origins.push({
			label: "Session and side calls",
			value: calls === null ? "Not recorded" : calls.toLocaleString("en-US"),
		});
	}

	if (workers) {
		const calls = number(workers.apiCalls);
		origins.push({ label: "Worker calls", value: calls === null ? "Not recorded" : calls.toLocaleString("en-US") });
	}
	const leftover = tablesOf(rows.filter((row) => !CLAIMED.has(row.name)));
	return {
		window: `from ${formatDay(report.from)} through ${formatDay(report.to)}`,
		headline,
		bars,
		barsCaveat: `${BARS_CAVEAT}${partialBreakdown ? " Some calls lack token fields; displayed fields are known subtotals, and absent amounts do not mean zero." : ""}`,
		knownSubtotals:
			missing > 0 || sessionTokens.knownSubtotals === true || overall?.knownSubtotals === true
				? `${missing > 0 ? `${missing.toLocaleString("en-US")} recorded calls are missing token usage. ` : ""}Token amounts are known subtotals; missing usage is not zero. Reports cover retained local records, not provider invoices.`
				: null,
		origins,
		originsNote: origins.length
			? "Session and side-call counts come from session usage; worker calls come from disjoint receipt totals, including shadow and internal helpers. A tool loop can make several conversation calls."
			: first("tokens")
				? "No origin split was recorded. The total alone does not establish that every recorded call belongs to a turn."
				: "Call origins were not recorded in this window.",
		missingStores,
		models: [...all("model-usage"), ...all("worker-model-usage")],
		skillsActivated: all("skill-activated"),
		skillsDormant: all("skill-never-activated").flatMap((row) => {
			const name = text(row.values.skill);
			return name ? [name] : [];
		}),
		rest: leftover.singles,
		tables: leftover.tables,
	};
}

export function filterUsageFacts(facts: UsageReport["facts"], query: string): UsageReport["facts"] {
	const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
	return facts.filter((fact) => {
		const text = `${usageLabel(fact.name)} ${JSON.stringify(fact.values)}`.toLocaleLowerCase();
		return terms.every((term) => text.includes(term));
	});
}
