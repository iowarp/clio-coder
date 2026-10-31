import type { LiveUsage } from "../../contracts/session-telemetry.js";
import type { SessionUsage } from "../../contracts/usage.js";
import type { SessionTelemetryV1 } from "../../contracts/wire.js";
import type { StatusTone } from "../design/status.js";
import type { Explainable } from "../telemetry/quantity-model.js";

const BARE_COUNT = /^~?\d[\d,]*$/;

/**
 * A token display with its unit. The unit follows a bare count ("5,120 tokens"); a display that carries its own gap
 * or method clause ("≥5,120 (1 call unknown)") takes the unit as a label instead, because a unit after the clause
 * misreads. The display is the server's and is never split or reworded (#434).
 */
export function tokensText(display: string, unit: "tokens" | "tok" = "tokens"): string {
	return BARE_COUNT.test(display) ? `${display} ${unit}` : `Tokens: ${display}`;
}

export interface Spend {
	readonly tokens: string | null;
	readonly cost: string | null;
	readonly calls: string | null;
	readonly source: "telemetry" | "none";
	readonly refs: SpendRefs;
}
export interface SpendRefs {
	readonly tokens: string | null;
	readonly cost: string | null;
	readonly calls: string | null;
}
const NO_REFS: SpendRefs = { tokens: null, cost: null, calls: null };

export function sessionSpend(input: {
	usage?: SessionUsage | undefined;
	live?: LiveUsage | undefined;
	cold?: SessionTelemetryV1 | null | undefined;
}): Spend {
	const session = input.live?.session ?? input.usage?.telemetry.session ?? input.cold;
	return session
		? {
				tokens: session.totals.tokens.display,
				cost: session.totals.usd.display,
				calls: session.own.counts.calls.display,
				source: "telemetry",
				refs: {
					tokens: session.totals.tokens.ref ?? null,
					cost: session.totals.usd.ref ?? null,
					calls: session.own.counts.calls.ref ?? null,
				},
			}
		: { tokens: null, cost: null, calls: null, source: "none", refs: NO_REFS };
}

export interface SpendTotal extends Explainable {
	label: string;
}

function spendTotals(spend: Spend): SpendTotal[] {
	return spend.source === "none"
		? []
		: [
				{ label: "Cost", value: spend.cost ?? "not measured", factRef: spend.refs.cost },
				{ label: "Tokens", value: spend.tokens ?? "not recorded", factRef: spend.refs.tokens },
				{ label: "Model calls", value: spend.calls ?? "not recorded", factRef: spend.refs.calls },
			];
}
export function usageTotals(usage: SessionUsage): SpendTotal[] {
	return spendTotals(sessionSpend({ usage }));
}
export interface UsageRow {
	key: string;
	route: string;
	tokens: string;
	cost: string;
	calls: string | null;
	beside: string | null;
	refs: { tokens: string | null; cost: string | null };
}
export function usageRows(usage: SessionUsage, _detail: "summary" | "fields" = "summary"): UsageRow[] {
	return usage.telemetry.cost.groups.map((group) => ({
		key: group.key,
		route: group.key,
		tokens: tokensText(group.tokens.display),
		cost: group.usd.display,
		calls: group.calls.display,
		beside: null,
		refs: { tokens: group.tokens.ref ?? null, cost: group.usd.ref ?? null },
	}));
}
export function usageCoverageNotes(_usage: SessionUsage): string[] {
	return [
		"Cache reads and writes are separate model prompt-cache fields. Provider token fields can overlap, so they do not establish additive shares, a cache hit rate, or cost savings.",
	];
}

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

export function quotaCards(usage: SessionUsage): { status: "read"; cards: QuotaCard[] } {
	return {
		status: "read",
		cards: usage.telemetryQuota.providers.map((provider) => ({
			key: provider.provider,
			name: provider.provider,
			word: provider.stale ? "Last reading" : "Read",
			tone: provider.stale ? "neutral" : "success",
			note: provider.stale ? "last recorded reading, not refreshed" : null,
			message: null,
			credits: null,
			windows: provider.windows.map((window) => ({
				label: window.label ?? window.key,
				used: window.usedPct.display,
				share: "value" in window.usedPct.fact ? window.usedPct.fact.value : 0,
				resetsAt: window.resetsAt,
				binding: false,
			})),
		})),
	};
}

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
	const totals = spendTotals(spend);
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
