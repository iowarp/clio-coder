// What this conversation spent and what each provider reports about its plan, before any of it is drawn.
// The read model's DTOs carry every figure with its display (#434 §11.2); the v1 counts beside them are
// legacy until P5 retires them. Nothing is summed, suffixed or inferred here.

import type { LiveUsage } from "../../contracts/session-telemetry.js";
import type { SessionUsage } from "../../contracts/usage.js";
import type { SessionTelemetryV1 } from "../../contracts/wire.js";
import type { StatusTone } from "../design/status.js";
import { countText } from "../telemetry/quantity-model.js";

type Cost = SessionUsage["session"]["cost"];

export function costText(cost: Cost): string {
	return cost.display ?? "not measured";
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
}

/**
 * One spend figure for every surface. The read model wins wherever it is present: on the usage read for an open
 * session, or from the cold telemetry route for a closed one. The v1 counts are the fallback for an agent build
 * that carries no telemetry, and a session with neither shows only its recorded cost.
 */
export function sessionSpend(input: {
	usage?: SessionUsage | undefined;
	live?: LiveUsage | undefined;
	cold?: SessionTelemetryV1 | null | undefined;
	recordedCostDisplay?: string | undefined;
}): Spend {
	const session = [input.usage?.telemetry?.session, input.cold].find(hasJournalFacts) ?? null;
	if (session)
		return {
			tokens: session.totals.tokens.display,
			cost: session.totals.usd.display,
			calls: session.own.counts.calls.display,
			source: "telemetry",
		};
	const live = input.live?.session;
	if (live)
		return {
			tokens: countText(live.totalTokens),
			cost: live.costDisplay ?? "not measured",
			calls: live.calls === undefined ? null : countText(live.calls),
			source: "legacy",
			...(live.missingTokenCalls ? { missingTokenCalls: live.missingTokenCalls } : {}),
		};
	if (input.usage) {
		const legacy = input.usage.session;
		return {
			tokens: countText(legacy.tokens),
			cost: costText(legacy.cost),
			calls: countText(legacy.cost.calls),
			source: "legacy",
			...(legacy.missingTokenCalls ? { missingTokenCalls: legacy.missingTokenCalls } : {}),
		};
	}
	return { tokens: null, cost: input.recordedCostDisplay ?? null, calls: null, source: "none" };
}

function spendTotals(spend: Spend, unknownCallCoverageRuns = 0): Array<{ label: string; value: string }> {
	if (spend.source === "none") return spend.cost ? [{ label: "Cost", value: spend.cost }] : [];
	return [
		{ label: "Cost", value: spend.cost ?? "not measured" },
		{ label: "Tokens", value: spend.tokens ?? "not recorded" },
		...(spend.calls === null ? [] : [{ label: "Model calls", value: spend.calls }]),
		...(spend.missingTokenCalls ? [{ label: "Calls missing usage", value: countText(spend.missingTokenCalls) }] : []),
		...(unknownCallCoverageRuns > 0
			? [{ label: "Runs with unknown call coverage", value: countText(unknownCallCoverageRuns) }]
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
}

/** Per-model rows: the read model's cost report by model when the usage read carries it, else the v1 rows. */
export function usageRows(usage: SessionUsage, detail: "summary" | "fields" = "summary"): UsageRow[] {
	if (usage.telemetry && journaled(usage))
		return usage.telemetry.cost.groups.map((group) => ({
			key: group.key,
			route: group.key,
			tokens: `${group.tokens.display} tokens`,
			cost: group.usd.display,
			calls: group.calls.display,
			beside: null,
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

export function quotaCards(
	usage: SessionUsage,
): { status: "read"; cards: QuotaCard[] } | { status: "failed"; reason: string } {
	if (usage.quota.status === "failed")
		return { status: "failed", reason: `Quota could not be read: ${usage.quota.reason}` };
	return {
		status: "read",
		cards: usage.quota.providers.map((provider) => {
			const [tone, word] = STATUS[provider.status] ?? (["neutral", provider.status] as [StatusTone, string]);
			const note = [
				...(provider.plan ? [provider.plan] : []),
				...(provider.stale ? ["last good reading, not refreshed"] : []),
				...(provider.retryAfterSeconds !== null ? [`provider asked to wait ${provider.retryAfterSeconds}s`] : []),
			].join(" · ");
			return {
				key: provider.provider,
				name: provider.name,
				word,
				tone,
				note: note === "" ? null : note,
				message: provider.message,
				credits: provider.credits
					? `${provider.credits.display}${provider.credits.usedPct === null ? "" : ` · ${Math.round(provider.credits.usedPct)}% used`}`
					: null,
				windows: provider.windows.map((window) => ({
					label: window.scope ? `${window.label} (${window.scope})` : window.label,
					used: `${Math.round(window.usedPct)}%`,
					share: window.usedPct,
					resetsAt: window.resetsAt,
					binding: window.active,
				})),
			};
		}),
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
	recordedCostDisplay?: string,
	cold?: SessionTelemetryV1 | null,
) {
	const spend = sessionSpend({ usage, live: recorded, cold, recordedCostDisplay });
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
