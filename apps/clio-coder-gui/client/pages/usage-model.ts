// The usage report's own order, in the operator's words. `facts[].values` is `Record<string,
// unknown>` on the wire because the CLI's schema is experimental, so every key is read defensively
// here and anything this module does not know about is handed back for <Facts> rather than dropped.
// Pure, so the wording and the ordering are testable without a browser.

import type { UsageReport } from "../../contracts/reports.js";
import type { CacheReportV1, CostReportV1, SessionTelemetryV1 } from "../../contracts/wire.js";
import { formatDay } from "../api/clock.js";
import { humanizeKey, scalarText } from "../design/facts-model.js";
import { countText, type Explainable, explainable, quantityParts } from "../telemetry/quantity-model.js";

export interface UsageFigure extends Explainable {
	label: string;
	note?: string;
}

export interface UsageBar extends Explainable {
	label: string;
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
 * Facts that repeat, such as one `top-tool` row per tool, read as one table rather than as
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

type TokenQuantities = SessionTelemetryV1["own"]["tokens"];
const TOKEN_BARS: ReadonlyArray<readonly [keyof TokenQuantities, string]> = [
	["input", "Input"],
	["output", "Output"],
	["cacheRead", "Cache read"],
	["cacheWrite", "Cache write"],
	["reasoning", "Reasoning"],
];

/** The read model's agent roles in the operator's words; a role added later reads through the humanizer. */
const ORIGINS: Readonly<Record<string, string>> = {
	main: "Conversation calls",
	coordinator: "Coordinator calls",
	compaction: "Compaction calls",
	btw: "Side questions",
	handoff: "Handoffs",
	prewarm: "Pre-warms",
	memory: "Background memory steps",
	"system-one": "System One calls",
	"safety-judge": "Safety judge calls",
	helper: "Helper calls",
	worker: "Worker run calls",
};

/** These are read out of the report by name; everything else keeps its wire shape. */
const CLAIMED = new Set([
	"telemetry-cost",
	"telemetry-cache",
	"telemetry-tokens",
	"sessions",
	"dispatch-runs",
	"skill-activated",
	"skill-never-activated",
]);

/**
 * The report's spend for one group-by: the read model's cost report over the window, every figure carrying the
 * canonical renderer's display. The server checked its shape (#434 §11.3).
 */
export function costReportOf(report: UsageReport, groupBy: "role" | "model"): CostReportV1 | null {
	const fact = report.facts.find((item) => item.name === "telemetry-cost" && item.values.groupBy === groupBy);
	const value = fact?.values.report as CostReportV1 | undefined;
	return value?.kind === "cost" ? value : null;
}

/** The window's token fields as the read model measured them over the same scope as the cost reports. */
export function tokenQuantitiesOf(report: UsageReport): TokenQuantities | null {
	const value = report.facts.find((item) => item.name === "telemetry-tokens")?.values.tokens as
		| TokenQuantities
		| undefined;
	return value?.total ? value : null;
}

/** One read-model cache report per session that recorded a cache verdict, in session order. */
export function cacheReportsOf(report: UsageReport): CacheReportV1[] {
	return report.facts.flatMap((item) => {
		const value = item.name === "telemetry-cache" ? (item.values.report as CacheReportV1 | undefined) : undefined;
		return value?.kind === "cache" ? [value] : [];
	});
}

function costNote(total: CostReportV1["total"]): string {
	const usd = quantityParts(total.usd);
	const { free, ...priced } = total.pricedBy;
	if (!usd.known)
		return usd.unknown > 0 ? "No call in this window was priced" : "No priced calls recorded in this window";
	if (usd.unknown > 0) return "Known subtotal; some calls are unpriced";
	if (usd.estimated > 0) return "Includes estimated prices";
	return free > 0 && Object.values(priced).every((count) => count === 0)
		? "Every recorded call is known free"
		: "Recorded prices";
}

const number = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const single = (values: Record<string, unknown>): string | null => {
	const keys = Object.keys(values);
	const only = keys.length === 1 && keys[0] === "value" ? number(values.value) : null;
	return only === null ? null : countText(only);
};
const text = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/**
 * Words for a wire key, used only for the facts this module does not name itself. It is the same
 * humanizer the fact renderer uses, so one vocabulary covers every inspector.
 */
export const usageLabel = humanizeKey;

/** One cell. A nested record reads as `hot 0 · cold 13`, never as JSON. */
function cell(key: string, value: unknown, costDisplay?: string): string {
	if (Array.isArray(value)) return value.length ? value.map((item) => cell(key, item)).join(", ") : "None";
	if (value && typeof value === "object")
		return (
			Object.entries(value)
				.filter(([key]) => key !== "costDisplay")
				.map(
					([inner, item]) =>
						`${humanizeKey(inner).toLowerCase()} ${cell(inner, item, text((value as Record<string, unknown>).costDisplay) ?? undefined)}`,
				)
				.join(" · ") || "None"
		);
	return scalarText(key, value as string | number | boolean | null | undefined, costDisplay).text;
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
		const keys = [
			...new Set(members.flatMap((member) => Object.keys(member.values).filter((key) => key !== "costDisplay"))),
		];
		const shown = keys.slice(0, USAGE_TABLE_LIMITS.columns);
		tables.push({
			name,
			label: first.label,
			total: members.length,
			columns: shown.map(humanizeKey),
			rows: members
				.slice(0, USAGE_TABLE_LIMITS.rows)
				.map((member) => shown.map((key) => cell(key, member.values[key], text(member.values.costDisplay) ?? undefined))),
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
	const byOrigin = costReportOf(report, "role");

	const store = (name: string, label: string): UsageFigure => {
		const display = text(first(name)?.display);
		return { label, ...explainable(display === null ? null : { display }) };
	};

	const total = byOrigin?.total;
	const headline: UsageFigure[] = [
		total
			? { label: "Tokens", ...explainable(total.tokens), note: `API calls: ${total.calls.display}` }
			: { label: "Tokens", value: countText(null), factRef: null },
		total
			? { label: "Cost", ...explainable(total.usd), note: costNote(total) }
			: { label: "Cost", value: "not measured", note: "No spend was measured in this window", factRef: null },
		store("sessions", "Sessions"),
		store("dispatch-runs", "Dispatch runs"),
	];

	const tokens = tokenQuantitiesOf(report);
	// Each bar is one server fact against the widest; a field that is a lower bound draws its known part (#434).
	const fields = TOKEN_BARS.map(([key, label]) => ({ label, quantity: tokens?.[key] ?? null }));
	const amounts = fields.map((field) => (field.quantity ? quantityParts(field.quantity).amount : null));
	const widest = Math.max(0, ...amounts.map((amount) => amount ?? 0));
	const bars: UsageBar[] = fields.map((field, index) => {
		const amount = amounts[index] ?? null;
		return {
			label: field.label,
			...explainable(field.quantity, countText(null)),
			share: amount !== null && widest > 0 ? amount / widest : 0,
		};
	});
	const partialFields = fields.some((field) => field.quantity && quantityParts(field.quantity).unknown > 0);

	const origins = (byOrigin?.groups ?? []).map((group) => ({
		label: Object.hasOwn(ORIGINS, group.key) ? (ORIGINS[group.key] as string) : humanizeKey(group.key),
		...explainable(group.calls),
	}));
	const leftover = tablesOf(rows.filter((row) => !CLAIMED.has(row.name)));
	return {
		window: `from ${formatDay(report.from)} through ${formatDay(report.to)}`,
		headline,
		bars,
		barsCaveat: `${BARS_CAVEAT}${partialFields ? " Some calls lack token fields; displayed fields are known subtotals, and absent amounts do not mean zero." : ""}`,
		// The displays already carry the marker; this names what a lower bound means here, never how many (#434).
		knownSubtotals:
			total && (quantityParts(total.tokens).unknown > 0 || quantityParts(total.calls).unknown > 0)
				? "Token amounts are known subtotals: some recorded calls lack token usage or a call count, and missing usage is not zero. Reports cover retained local records, not provider invoices."
				: null,
		origins,
		originsNote: origins.length
			? "Calls by what asked for them, in one fold over the window's sessions and runs. Worker calls come from each run's journal. A tool loop can make several conversation calls."
			: byOrigin
				? "No call was recorded in this window."
				: "Call origins were not recorded in this window.",
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
