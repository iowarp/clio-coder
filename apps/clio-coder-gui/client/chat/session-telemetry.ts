// Pushed context and totals share the session snapshot; settled accounting still supplies model and quota details.

import { useQuery } from "@tanstack/react-query";
import type { ContextLedger } from "../../contracts/context-ledger.js";
import { routes } from "../../contracts/routes.js";
import type { LiveUsage } from "../../contracts/session-telemetry.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import type { SessionUsage } from "../../contracts/usage.js";
import type { Client } from "../api/client.js";
import { compactCount, taskOverview } from "./overview-model.js";

type Turns = SessionSnapshot["turns"];

/** Changes when a turn settles, which is when the ledger and the accounting can have moved. */
export const settledTurns = (turns: Turns): number => turns.filter((turn) => turn.status !== "running").length;

export function useSessionCapabilities(client: Client, sessionId: string, open: boolean) {
	return useQuery({
		queryKey: ["session-capabilities", sessionId],
		queryFn: () => client.call(routes.sessionCapabilities, { params: { id: sessionId }, query: {}, body: {} }),
		enabled: open,
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
}

export function useSessionTelemetry(client: Client, sessionId: string) {
	return useQuery({
		queryKey: ["session", sessionId],
		queryFn: () => client.call(routes.session, { params: { id: sessionId }, query: {}, body: {} }),
		enabled: false,
		select: (snapshot) => snapshot.telemetry ?? null,
	}).data;
}

export function useContextLedger(client: Client, sessionId: string, settled: number, enabled: boolean) {
	const live = useSessionTelemetry(client, sessionId)?.usage?.context;
	const query = useQuery({
		queryKey: ["session-context", sessionId, settled],
		queryFn: () => client.call(routes.sessionContext, { params: { id: sessionId }, query: {}, body: {} }),
		enabled,
		retry: false,
		// The previous turn's figure stays on screen while the next one is read, so nothing blinks.
		placeholderData: (previous: ContextLedger | undefined) => previous,
	});
	return { ...query, data: live ?? query.data, isPending: !live && query.isPending, error: live ? null : query.error };
}

export function useSessionUsage(client: Client, sessionId: string, settled: number, enabled: boolean) {
	return useQuery({
		queryKey: ["session-usage", sessionId, settled],
		queryFn: () => client.call(routes.sessionUsage, { params: { id: sessionId }, query: {}, body: {} }),
		enabled,
		retry: false,
		placeholderData: (previous: SessionUsage | undefined) => previous,
	});
}

export interface Spend {
	readonly tokens: number;
	/** "$0.42", "~$0.42" when estimated, "$0.42+" when some calls are unpriced; null when nothing is priced. */
	readonly cost: string | null;
	/** Clio's accounting covers side questions and handoffs; the turn sums cover only the transcript. */
	readonly source: "clio" | "turns";
}

function dollars(value: number): string {
	// Sub-cent spend is common on cheap models; two decimals would round it to a claim of nothing.
	return value > 0 && value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/**
 * One spend figure for every surface. Clio's own accounting wins whenever the session reports it,
 * because it also counts what ran beside the conversation; the per-turn sums are the fallback for a
 * session that does not.
 */
export function sessionSpend(turns: Turns, usage: SessionUsage | undefined, live?: LiveUsage): Spend {
	if (live?.session) {
		const totals = live.session;
		const cost =
			totals.costProvenance === "unknown"
				? totals.costUsd > 0
					? `${dollars(totals.costUsd)}+`
					: null
				: `${totals.costProvenance === "estimated" ? "~" : ""}${dollars(totals.costUsd)}`;
		return { tokens: totals.totalTokens, cost, source: "clio" };
	}
	if (usage) {
		const cost = usage.session.cost;
		const priced =
			cost.calls === 0
				? null
				: cost.free
					? "$0.00"
					: `${cost.estimated ? "~" : ""}${dollars(cost.knownUsd)}${cost.unknown ? "+" : ""}`;
		return { tokens: usage.session.tokens, cost: priced, source: "clio" };
	}
	const overview = taskOverview(turns, 0);
	return {
		tokens: overview.tokens,
		cost: overview.costUsd !== null && overview.costUsd > 0 ? dollars(overview.costUsd) : null,
		source: "turns",
	};
}

export function spendLine(spend: Spend): string | null {
	const parts = [spend.tokens > 0 ? `${compactCount(spend.tokens)} tokens` : null, spend.cost].filter(Boolean);
	return parts.length > 0 ? parts.join(" · ") : null;
}
