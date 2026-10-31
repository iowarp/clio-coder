// What this conversation spent and what each provider reports about its plan, before any of it is drawn.
// The read model's DTOs carry every figure with its display (#434 §11.2); the v1 counts beside them are
// legacy until P5 retires them. Nothing is summed, suffixed or inferred here.

import type { LiveUsage } from "../../contracts/session-telemetry.js";
import type { SessionUsage } from "../../contracts/usage.js";
import type { SessionTelemetryV1 } from "../../contracts/wire.js";
import type { StatusTone } from "../design/status.js";
import { countText, type Explainable } from "../telemetry/quantity-model.js";

type Cost = SessionUsage["session"]["cost"];

export function costText(cost: Cost): string {
	return cost.display ?? "not measured";
}

const BARE_COUNT = /^~?\d[\d,]*$/;

/**
 * A token display with its unit. The unit follows a bare count ("5,120 tokens"); a display that carries its own gap
 * or method clause ("≥5,120 (1 call unknown)") takes the unit as a label instead, because a unit after the clause
 * misreads. The display is the server's and is never split or reworded (#434).
 */
export function tokensText(display: string, unit: "tokens" | "tok" = "tokens"): string {
	return BARE_COUNT.test(display) ? `${display} ${unit}` : `Tokens: ${display}`;
}

/**
 * Whether a session DTO holds any call the fold could count. A session the host knows but never journaled answers
 * unknown coverage (R9): no measured or estimated attempt, only the gap. Such a DTO says nothing a surface can show
 * in place of the legacy counts, so the legacy counts stand until a journal exists.
 */
export function hasJournalFacts(session: SessionTelemetryV1 | null | undefined): session is SessionTelemetryV1 {
	if (!session) return false;
	const attempts = session.own.counts.attempts.fact;
	return "kind" in attempts
		? attempts.kind === "measured" || attempts.kind === "estimated"
		: attempts.coverage.measured + attempts.coverage.estimated > 0;
}

export interface Spend {
	/** The server's wording for the tokens; null when nothing reported them. */
	readonly tokens: string | null;
	readonly cost: string | null;
	readonly calls: string | null;
	/** `telemetry`: the read model's fold, every unknown kept. `legacy`: the v1 counts, which retire in P5. */
	readonly source: "telemetry" | "legacy" | "none";
	/** Legacy only: calls the v1 counts could not cover, named beside them and never folded into them. */
	readonly missingTokenCalls?: number;
	/** The read model's reference behind each figure, which explain() resolves; the v1 counts carry none. */
	readonly refs: SpendRefs;
}

export interface SpendRefs {
	readonly tokens: string | null;
	readonly cost: string | null;
	readonly calls: string | null;
}
const NO_REFS: SpendRefs = { tokens: null, cost: null, calls: null };

/**
 * One spend figure for every surface. The read model wins wherever it is present: on the usage read for an open
 * session, or from the cold telemetry route for a closed one. The v1 counts are the fallback for an agent build
 * that carries no telemetry, and a session with neither shows no spend rather than a figure folded outside the read
 * model (#434).
 */
export function sessionSpend(input: {
	usage?: SessionUsage | undefined;
	live?: LiveUsage | undefined;
	cold?: SessionTelemetryV1 | null | undefined;
}): Spend {
	const session = [input.usage?.telemetry?.session, input.cold].find(hasJournalFacts) ?? null;
	if (session)
		return {
			tokens: session.totals.tokens.display,
			cost: session.totals.usd.display,
			calls: session.own.counts.calls.display,
			source: "telemetry",
			refs: {
				tokens: session.totals.tokens.ref ?? null,
				cost: session.totals.usd.ref ?? null,
				calls: session.own.counts.calls.ref ?? null,
			},
		};
	const live = input.live?.session;
	if (live)
		return {
			tokens: countText(live.totalTokens),
			cost: live.costDisplay ?? "not measured",
			calls: live.calls === undefined ? null : countText(live.calls),
			source: "legacy",
			refs: NO_REFS,
			...(live.missingTokenCalls ? { missingTokenCalls: live.missingTokenCalls } : {}),
		};
	if (input.usage) {
		const legacy = input.usage.session;
		return {
			tokens: countText(legacy.tokens),
			cost: costText(legacy.cost),
			calls: countText(legacy.cost.calls),
			source: "legacy",
			refs: NO_REFS,
			...(legacy.missingTokenCalls ? { missingTokenCalls: legacy.missingTokenCalls } : {}),
		};
	}
	return { tokens: null, cost: null, calls: null, source: "none", refs: NO_REFS };
}

export interface SpendTotal extends Explainable {
	label: string;
}

function spendTotals(spend: Spend, unknownCallCoverageRuns = 0): SpendTotal[] {
	if (spend.source === "none") return spend.cost ? [{ label: "Cost", value: spend.cost, ref: null }] : [];
	return [
		{ label: "Cost", value: spend.cost ?? "not measured", ref: spend.refs.cost },
		{ label: "Tokens", value: spend.tokens ?? "not recorded", ref: spend.refs.tokens },
		...(spend.calls === null ? [] : [{ label: "Model calls", value: spend.calls, ref: spend.refs.calls }]),
		...(spend.missingTokenCalls
			? [{ label: "Calls missing usage", value: countText(spend.missingTokenCalls), ref: null }]
			: []),
		...(unknownCallCoverageRuns > 0
			? [{ label: "Runs with unknown call coverage", value: countText(unknownCallCoverageRuns), ref: null }]
			: []),
	];
}

const journaled = (usage: SessionUsage | undefined) => hasJournalFacts(usage?.telemetry?.session);

export function usageTotals(usage: SessionUsage): Array<{ label: string; value: string }> {
	return spendTotals(sessionSpend({ usage }), journaled(usage) ? 0 : (usage.session.cost.unknownCallCoverageRuns ?? 0));
}

const counted = (value: number, one: string, many: string) =>
	value > 0 ? [`${value} ${value === 1 ? one : many}`] : [];

export interface UsageRow {
	key: string;
	route: string;
	tokens: string;
	cost: string;
	calls: string | null;
	beside: string | null;
	/** The read model's references behind the row's figures; the v1 rows carry none. */
	refs: { tokens: string | null; cost: string | null };
}

/** Per-model rows: the read model's cost report by model when the usage read carries it, else the v1 rows. */
export function usageRows(usage: SessionUsage, detail: "summary" | "fields" = "summary"): UsageRow[] {
	if (usage.telemetry && journaled(usage))
		return usage.telemetry.cost.groups.map((group) => ({
			key: group.key,
			route: group.key,
			tokens: tokensText(group.tokens.display),
			cost: group.usd.display,
			calls: group.calls.display,
			beside: null,
			refs: { tokens: group.tokens.ref ?? null, cost: group.usd.ref ?? null },
		}));
	return usage.session.rows.map((row) => {
		const beside = [
			...counted(row.beside.sideQuestions, "side question", "side questions"),
			...counted(row.beside.handoffs, "handoff round", "handoff rounds"),
			...counted(row.beside.prewarms, "pre-warm", "pre-warms"),
			...counted(row.beside.backgroundMemory, "memory step", "memory steps"),
			...counted(row.beside.systemOne ?? 0, "System One call", "System One calls"),
			...counted(row.beside.failedCompaction ?? 0, "failed compaction call", "failed compaction calls"),
			...counted(row.beside.compactions ?? 0, "compaction call", "compaction calls"),
			...counted(row.beside.workers ?? 0, "worker call", "worker calls"),
			...counted(row.missingTokenCalls ?? 0, "call missing token usage", "calls missing token usage"),
			...counted(
				row.cost.unknownCallCoverageRuns ?? 0,
				"run with unknown call coverage",
				"runs with unknown call coverage",
			),
		];
		// Legacy v1 fields: cache read and write stay separate, since a v1 count cannot say which is unknown.
		return {
			key: `${row.provider}/${row.model}`,
			route: `${row.provider} · ${row.model}`,
			tokens: (detail === "fields"
				? [
						`${countText(row.tokens.total)} total`,
						`${countText(row.tokens.input)} input`,
						`${countText(row.tokens.output)} output`,
						`${countText(row.tokens.cacheRead)} cache read`,
						`${countText(row.tokens.cacheWrite)} cache write`,
						...(row.tokens.reasoning > 0 ? [`${countText(row.tokens.reasoning)} reasoning`] : []),
					]
				: [
						`${countText(row.tokens.input)} in`,
						`${countText(row.tokens.output)} out`,
						...(row.tokens.cacheRead > 0 ? [`${countText(row.tokens.cacheRead)} cache read`] : []),
						...(row.tokens.cacheWrite > 0 ? [`${countText(row.tokens.cacheWrite)} cache write`] : []),
						...(row.tokens.reasoning > 0 ? [`${countText(row.tokens.reasoning)} reasoning`] : []),
					]
			).join(" · "),
			cost: costText(row.cost),
			calls: countText(row.calls),
			beside: beside.length > 0 ? beside.join(", ") : null,
			refs: { tokens: null, cost: null },
		};
	});
}

export function usageCoverageNotes(usage: SessionUsage): string[] {
	return [
		...(usage.session.truncated
			? ["The model list is truncated. Session totals include models beyond the displayed rows."]
			: []),
		...(usage.session.missingTokenCalls
			? ["Token fields are known subtotals because some calls are missing usage. Missing usage does not mean zero."]
			: []),
		"Cache reads and writes are separate model prompt-cache fields. Provider token fields can overlap, so they do not establish additive shares, a cache hit rate, or cost savings.",
	];
}

const STATUS: Record<string, [StatusTone, string]> = {
	ok: ["success", "Read"],
	no_credentials: ["neutral", "Not signed in"],
	expired: ["warn", "Sign-in expired"],
	error: ["fail", "Failed"],
	loading: ["running", "Reading"],
};

export interface QuotaCard {
	key: string;
	name: string;
	word: string;
	tone: StatusTone;
	note: string | null;
	message: string | null;
	credits: string | null;
	windows: Array<{ label: string; used: string; share: number; resetsAt: string | null; binding: boolean }>;
}

type QuotaWindow = QuotaCard["windows"][number];

/** A v1 window's label with its scope, worded as the read model's quota fold words it, so the two match. */
const windowLabel = (window: { label: string; scope: string | null }) =>
	window.scope ? `${window.label} (${window.scope})` : window.label;
type FoldedQuota = NonNullable<SessionUsage["telemetryQuota"]>["providers"][number];

/** A folded window's fill: its share when one is known; an unknown share draws an empty bar beside its words. */
const fill = (usedPct: FoldedQuota["windows"][number]["usedPct"]) =>
	usedPct.fact.kind === "measured" || usedPct.fact.kind === "estimated" ? usedPct.fact.value : 0;

function foldedWindows(row: FoldedQuota, bound: (label: string | null) => boolean): QuotaWindow[] {
	return row.windows.map((window) => ({
		label: window.label ?? window.key,
		used: window.usedPct.display,
		share: fill(window.usedPct),
		resetsAt: window.resetsAt,
		binding: bound(window.label),
	}));
}

/**
 * One card per provider. A window's share is the read model's quota fold wherever it holds the provider, so quota
 * reads like every other spend figure (#434); the v1 read names the card's status, plan and credits, and its own
 * shares, worded on the server, stand only for an agent that sends no fold. An account only the session's journal
 * still holds, such as one a resumed session last saw, keeps its own card.
 */
export function quotaCards(
	usage: SessionUsage,
): { status: "read"; cards: QuotaCard[] } | { status: "failed"; reason: string } {
	const folded = usage.telemetryQuota?.providers ?? [];
	const providers = usage.quota.status === "read" ? usage.quota.providers : [];
	if (usage.quota.status === "failed" && folded.length === 0)
		return { status: "failed", reason: `Quota could not be read: ${usage.quota.reason}` };
	const journaledOnly = folded
		.filter((row) => !providers.some((provider) => provider.provider === row.provider))
		.map(
			(row): QuotaCard => ({
				key: row.provider,
				name: row.provider,
				word: row.stale ? "Last reading" : "Read",
				tone: row.stale ? "neutral" : "success",
				note: row.stale ? "last recorded reading, not refreshed" : null,
				message: null,
				credits: null,
				windows: foldedWindows(row, () => false),
			}),
		);
	return {
		status: "read",
		cards: [
			...providers.map((provider, index): QuotaCard => {
				const [tone, word] = STATUS[provider.status] ?? (["neutral", provider.status] as [StatusTone, string]);
				const note = [
					...(provider.plan ? [provider.plan] : []),
					...(provider.stale ? ["last good reading, not refreshed"] : []),
					...(provider.retryAfterSeconds !== null ? [`provider asked to wait ${provider.retryAfterSeconds}s`] : []),
				].join(" · ");
				const words = usage.quotaDisplay?.[index];
				const row = folded.find((entry) => entry.provider === provider.provider);
				return {
					key: provider.provider,
					name: provider.name,
					word,
					tone,
					note: note === "" ? null : note,
					message: provider.message,
					credits: provider.credits
						? `${provider.credits.display}${words?.credits ? ` · ${words.credits} used` : ""}`
						: null,
					windows: row
						? foldedWindows(row, (label) => provider.windows.some((window) => windowLabel(window) === label && window.active))
						: provider.windows.map((window, at) => ({
								label: windowLabel(window),
								used: words?.windows[at] ?? "share not reported",
								share: window.usedPct,
								resetsAt: window.resetsAt,
								binding: window.active,
							})),
				};
			}),
			...journaledOnly,
		],
	};
}

/** A quota window's fill tone, on the same steps as the context meter so a nearly spent window reads alike. */
export function quotaTone(share: number): "ok" | "warn" | "full" {
	return share >= 85 ? "full" : share >= 65 ? "warn" : "ok";
}

export function usageSummary(
	sessionOpen: boolean,
	usage: SessionUsage | undefined,
	recorded: LiveUsage | undefined,
	cold?: SessionTelemetryV1 | null,
) {
	const spend = sessionSpend({ usage, live: recorded, cold });
	const totals = spendTotals(spend, usage && !journaled(usage) ? (usage.session.cost.unknownCallCoverageRuns ?? 0) : 0);
	return {
		totals,
		details: sessionOpen && !!usage,
		source: spend.source,
		note: !sessionOpen
			? totals.length > 0
				? "Last recorded totals. Open this task to refresh model details and provider quota."
				: "No usage totals were recorded. Open this task to read its usage."
			: spend.source === "telemetry"
				? "The read model's figures for this conversation; a partial sum reads as a lower bound with its gap."
				: recorded?.session
					? "Live totals. Model details below update when the turn finishes."
					: "Clio Coder’s own accounting for this conversation.",
	};
}
