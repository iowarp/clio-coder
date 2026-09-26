// What this conversation spent and what each provider reports about its plan, before any of it is drawn.
// Every number is the agent's own: cost and tokens are Clio Coder's accounting, folded per provider and
// model as the terminal's /usage folds them, and quota is each provider's report. Nothing is summed here.

import type { SessionUsage } from "../../contracts/usage.js";
import type { StatusTone } from "../design/status.js";

type Cost = SessionUsage["session"]["cost"];

const tokens = (value: number) => value.toLocaleString("en-US");

function dollars(value: number): string {
	// Sub-cent spend is common on cheap models; two decimals would round it to a claim of nothing.
	return value > 0 && value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

export function costText(cost: Cost): string {
	if (cost.calls === 0) return "Nothing recorded yet";
	if (cost.free) return "$0.00, every call free";
	if (cost.unknown) return `${dollars(cost.knownUsd)} known, some calls unpriced`;
	if (cost.estimated) return `about ${dollars(cost.knownUsd)}`;
	return dollars(cost.knownUsd);
}

export function usageTotals(usage: SessionUsage): Array<{ label: string; value: string }> {
	return [
		{ label: "Cost", value: costText(usage.session.cost) },
		{ label: "Tokens", value: tokens(usage.session.tokens) },
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
