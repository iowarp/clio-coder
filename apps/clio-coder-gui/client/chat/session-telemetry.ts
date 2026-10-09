// Pushed context and totals share the session snapshot; settled accounting still supplies model and quota details.

import { useQuery } from "@tanstack/react-query";
import type { ContextLedger } from "../../contracts/context-ledger.js";
import { routes } from "../../contracts/routes.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import type { SessionUsage } from "../../contracts/usage.js";
import type { Client } from "../api/client.js";
import { compactCount } from "./overview-model.js";

import type { Spend } from "./session-usage-model.js";

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

/** Context work is part of the same snapshot as chat and telemetry, including work between turns. */
export function useContextWork(client: Client, sessionId: string) {
	return useQuery({
		queryKey: ["session", sessionId],
		queryFn: () => client.call(routes.session, { params: { id: sessionId }, query: {}, body: {} }),
		enabled: false,
		select: (snapshot) => snapshot.contextWork,
	}).data;
}

export function useContextLedger(client: Client, sessionId: string, settled: number, enabled: boolean) {
	const live = useSessionTelemetry(client, sessionId)?.usage?.context;
	const operation = useContextWork(client, sessionId)?.latest;
	const query = useQuery({
		queryKey: ["session-context", sessionId, settled, operation?.id ?? null],
		queryFn: () => client.call(routes.sessionContext, { params: { id: sessionId }, query: {}, body: {} }),
		enabled,
		retry: false,
		// The previous turn's figure stays on screen while the next one is read, so nothing blinks.
		placeholderData: (previous: ContextLedger | undefined) => previous,
	});
	const data = live ?? query.data;
	return { ...query, data, isPending: !data && query.isPending, error: data ? null : query.error };
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

export function spendLine(spend: Spend): string | null {
	const parts = [
		spend.tokens > 0 || spend.missingTokenCalls
			? `${compactCount(spend.tokens)} tokens${spend.missingTokenCalls ? ` +? (${spend.missingTokenCalls} call${spend.missingTokenCalls === 1 ? "" : "s"} missing usage)` : ""}`
			: null,
		spend.cost,
	].filter(Boolean);
	return parts.length > 0 ? parts.join(" · ") : null;
}
