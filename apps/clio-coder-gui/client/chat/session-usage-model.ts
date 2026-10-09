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

function dollars(value: number): string {
	// Sub-cent spend is common on cheap models; two decimals would round it to a claim of nothing.
	return value > 0 && value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

export function costText(cost: Cost): string {
	if (cost.calls === 0) return "Nothing recorded yet";
	if (cost.free) return "$0.00, every call free";
	if (cost.unknown && cost.knownUsd === 0) return "Cost not measured";
	if (cost.unknown) return `${cost.estimated ? "about " : ""}${dollars(cost.knownUsd)} subtotal, some calls unpriced`;
	if (cost.estimated) return `about ${dollars(cost.knownUsd)}`;
	return dollars(cost.knownUsd);
}

export function usageTotals(usage: SessionUsage): Array<{ label: string; value: string }> {
	return [
		{ label: "Cost", value: costText(usage.session.cost) },
		{
			label: "Tokens",
			value: `${tokens(usage.session.tokens)}${usage.session.missingTokenCalls ? ` +? (${tokens(usage.session.missingTokenCalls)} call${usage.session.missingTokenCalls === 1 ? "" : "s"} missing usage)` : ""}`,
		},
		{ label: "Model calls", value: tokens(usage.session.cost.calls) },
	];
}

const counted = (value: number, one: string, many: string) =>
	value > 0 ? [`${value} ${value === 1 ? one : many}`] : [];

export function usageRows(usage: SessionUsage) {
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
		];
		const cache = row.tokens.cacheRead + row.tokens.cacheWrite;
		return {
			key: `${row.provider}/${row.model}`,
			route: `${row.provider} · ${row.model}`,
			tokens: [
				`${tokens(row.tokens.input)} in`,
				`${tokens(row.tokens.output)} out`,
				...(cache > 0 ? [`${tokens(cache)} cache`] : []),
				...(row.tokens.reasoning > 0 ? [`${tokens(row.tokens.reasoning)} reasoning`] : []),
			].join(" · "),
			cost: costText(row.cost),
			beside: beside.length > 0 ? beside.join(", ") : null,
		};
	});
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
): Spend {
	if (live?.session) {
		const totals = live.session;
		const cost =
			totals.costProvenance === "unknown"
				? totals.costUsd > 0
					? `${totals.hasEstimatedCost ? "~" : ""}${dollars(totals.costUsd)} +?`
					: null
				: `${totals.costProvenance === "estimated" ? "~" : ""}${dollars(totals.costUsd)}`;
		return {
			tokens: totals.totalTokens,
			cost,
			source: "clio",
			...(totals.missingTokenCalls ? { missingTokenCalls: totals.missingTokenCalls } : {}),
		};
	}
	if (usage) {
		const cost = usage.session.cost;
		const priced =
			cost.calls === 0 || (cost.unknown && cost.knownUsd === 0)
				? null
				: cost.free
					? "$0.00"
					: `${cost.estimated ? "~" : ""}${dollars(cost.knownUsd)}${cost.unknown ? " +?" : ""}`;
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
		cost:
			overview.costUsd !== null && overview.costUsd > 0
				? `${overview.hasEstimatedCost ? "~" : ""}${dollars(overview.costUsd)}${overview.hasUnknownCost ? " +?" : ""}`
				: null,
		...(overview.missingTokenCalls ? { missingTokenCalls: overview.missingTokenCalls } : {}),
		source: "turns",
	};
}

export function usageSummary(
	sessionOpen: boolean,
	turns: SessionSnapshot["turns"],
	usage: SessionUsage | undefined,
	recorded: LiveUsage | undefined,
) {
	const hasSnapshot = !!recorded?.session || turns.some((turn) => !!turn.usage);
	const spend = sessionSpend(turns, usage, recorded);
	const totals =
		!recorded?.session && usage
			? usageTotals(usage)
			: hasSnapshot
				? [
						{ label: "Cost", value: spend.cost ?? "Unpriced" },
						{
							label: "Tokens",
							value: `${tokens(spend.tokens)}${spend.missingTokenCalls ? ` +? (${tokens(spend.missingTokenCalls)} call${spend.missingTokenCalls === 1 ? "" : "s"} missing usage)` : ""}`,
						},
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
