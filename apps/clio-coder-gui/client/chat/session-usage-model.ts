// What this conversation spent and what each provider reports about its plan, before any of it is drawn.
// Every number is the agent's own: cost and tokens are Clio Coder's accounting, folded per provider and
// model as the terminal's /usage folds them, and quota is each provider's report. Nothing is summed here.

import type { LiveUsage } from "../../contracts/session-telemetry.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import type { SessionUsage } from "../../contracts/usage.js";
import type { StatusTone } from "../design/status.js";
import { taskOverview } from "./overview-model.js";

type Cost = SessionUsage["session"]["cost"];

const tokens = (value: number) => value.toLocaleString("en-US");

export function costText(cost: Cost): string {
	return cost.display ?? "not measured";
}

export function usageTotals(usage: SessionUsage): Array<{ label: string; value: string }> {
	return [
		{ label: "Cost", value: costText(usage.session.cost) },
		{
			label: "Tokens",
			value: `${tokens(usage.session.tokens)}${usage.session.missingTokenCalls ? ` +? (${tokens(usage.session.missingTokenCalls)} call${usage.session.missingTokenCalls === 1 ? "" : "s"} missing usage)` : ""}`,
		},
		{
			label: "Model calls",
			value: usage.session.cost.unknownCallCoverageRuns
				? `${tokens(usage.session.cost.calls)} known; ${usage.session.cost.unknownCallCoverageRuns} runs with unknown call coverage`
				: tokens(usage.session.cost.calls),
		},
	];
}

const counted = (value: number, one: string, many: string) =>
	value > 0 ? [`${value} ${value === 1 ? one : many}`] : [];

export function usageRows(usage: SessionUsage, detail: "summary" | "fields" = "summary") {
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
		const cache = row.tokens.cacheRead + row.tokens.cacheWrite;
		const field = (value: number) => `${tokens(value)}${row.missingTokenCalls ? " +?" : ""}`;
		return {
			key: `${row.provider}/${row.model}`,
			route: `${row.provider} · ${row.model}`,
			tokens: (detail === "fields"
				? [
						`${field(row.tokens.total)} total`,
						`${field(row.tokens.input)} input`,
						`${field(row.tokens.output)} output`,
						`${field(row.tokens.cacheRead)} cache read`,
						`${field(row.tokens.cacheWrite)} cache write`,
						...(row.tokens.reasoning > 0 ? [`${field(row.tokens.reasoning)} reasoning`] : []),
					]
				: [
						`${tokens(row.tokens.input)} in`,
						`${tokens(row.tokens.output)} out`,
						...(cache > 0 ? [`${tokens(cache)} cache`] : []),
						...(row.tokens.reasoning > 0 ? [`${tokens(row.tokens.reasoning)} reasoning`] : []),
					]
			).join(" · "),
			cost: costText(row.cost),
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

export interface Spend {
	missingTokenCalls?: number;
	readonly tokens: number;
	/** "$0.42", "~$0.42" when estimated, "$0.42 +?" when some calls are unpriced; null when nothing is priced. */
	readonly cost: string | null;
	/** Clio's accounting covers side questions and handoffs; the turn sums cover only the transcript. */
	readonly source: "clio" | "turns";
}

/**
 * One spend figure for every surface. Clio's own accounting wins whenever the session reports it,
 * because it also counts what ran beside the conversation; the per-turn sums are the fallback for a
 * session that does not.
 */
export function sessionSpend(
	turns: SessionSnapshot["turns"],
	usage: SessionUsage | undefined,
	live?: LiveUsage,
	recordedCostDisplay?: string,
): Spend {
	if (live?.session) {
		const totals = live.session;
		const cost = totals.costDisplay ?? "not measured";
		return {
			tokens: totals.totalTokens,
			cost,
			source: "clio",
			...(totals.missingTokenCalls ? { missingTokenCalls: totals.missingTokenCalls } : {}),
		};
	}
	if (usage) {
		const cost = usage.session.cost;
		const priced = costText(cost);
		return {
			tokens: usage.session.tokens,
			cost: priced,
			source: "clio",
			...(usage.session.missingTokenCalls ? { missingTokenCalls: usage.session.missingTokenCalls } : {}),
		};
	}
	const overview = taskOverview(turns, 0);
	return {
		tokens: overview.tokens,
		cost: recordedCostDisplay ?? "not measured",
		...(overview.missingTokenCalls ? { missingTokenCalls: overview.missingTokenCalls } : {}),
		source: "turns",
	};
}

export function usageSummary(
	sessionOpen: boolean,
	turns: SessionSnapshot["turns"],
	usage: SessionUsage | undefined,
	recorded: LiveUsage | undefined,
	recordedCostDisplay?: string,
) {
	const hasSnapshot = !!recorded?.session || turns.some((turn) => !!turn.usage);
	const spend = sessionSpend(turns, usage, recorded, recordedCostDisplay);
	const totals =
		!recorded?.session && usage
			? usageTotals(usage)
			: hasSnapshot
				? [
						{ label: "Cost", value: spend.cost ?? "not measured" },
						{
							label: "Tokens",
							value: `${tokens(spend.tokens)}${spend.missingTokenCalls ? ` +? (${tokens(spend.missingTokenCalls)} call${spend.missingTokenCalls === 1 ? "" : "s"} missing usage)` : ""}`,
						},
						...(recorded?.session?.calls !== undefined
							? [
									{
										label: "Model calls",
										value: recorded.session.unknownCallCoverageRuns
											? `${tokens(recorded.session.calls)} known; ${recorded.session.unknownCallCoverageRuns} runs with unknown call coverage`
											: tokens(recorded.session.calls),
									},
								]
							: []),
					]
				: [];
	return {
		totals,
		details: sessionOpen && !!usage,
		note: !sessionOpen
			? totals.length > 0
				? "Last recorded totals. Open this task to refresh model details and provider quota."
				: "No usage totals were recorded. Open this task to read its usage."
			: recorded?.session
				? "Live totals. Model details below update when the turn finishes."
				: "Clio Coder’s own accounting for this conversation.",
	};
}
