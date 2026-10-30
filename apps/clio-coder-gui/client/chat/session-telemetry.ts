// Pushed context and totals share the session snapshot; settled accounting still supplies model and quota details.

import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ContextLedger } from "../../contracts/context-ledger.js";
import { routes } from "../../contracts/routes.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import type { Client } from "../api/client.js";
import { sessionReadScope } from "../api/sessions.js";

import { type Spend, tokensText } from "./session-usage-model.js";

type Turns = SessionSnapshot["turns"];
// A GET may supersede the push it began after, but cannot overwrite a newer push that raced it.
const contextReadBasis = new WeakMap<ContextLedger, number>();

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
	const queries = useQueryClient();
	const live = useSessionTelemetry(client, sessionId)?.usage?.context;
	const operation = useContextWork(client, sessionId)?.latest;
	const pushedRevision =
		useQuery<number>({
			queryKey: ["session-context-push", sessionId],
			queryFn: skipToken,
			enabled: false,
		}).data ?? 0;
	const scope = sessionReadScope(sessionId);
	const query = useQuery({
		queryKey: ["session-context", sessionId, settled, operation?.id ?? null, scope],
		queryFn: async ({ signal }) => {
			const basis = queries.getQueryData<number>(["session-context-push", sessionId]) ?? 0;
			const result = await client.call(
				routes.sessionContext,
				{ params: { id: sessionId }, query: {}, body: {} },
				undefined,
				signal,
			);
			contextReadBasis.set(result, basis);
			return result;
		},
		// Preserve the response identity used for freshness above, including an equal-valued refresh.
		structuralSharing: false,
		enabled,
		retry: false,
		// The previous turn's figure stays on screen while the next one is read, so nothing blinks.
		placeholderData: (previous, previousQuery) =>
			previousQuery?.queryKey[1] === sessionId && previousQuery.queryKey.at(-1) === scope ? previous : undefined,
	});
	const readIsCurrent = query.data && contextReadBasis.get(query.data) === pushedRevision;
	const data = readIsCurrent ? query.data : (live ?? query.data);
	return { ...query, data, isPending: !data && query.isPending };
}

export function useSessionUsage(client: Client, sessionId: string, settled: number, enabled: boolean) {
	const scope = sessionReadScope(sessionId);
	return useQuery({
		queryKey: ["session-usage", sessionId, settled, scope],
		queryFn: ({ signal }) =>
			client.call(routes.sessionUsage, { params: { id: sessionId }, query: {}, body: {} }, undefined, signal),
		enabled,
		retry: false,
		placeholderData: (previous, previousQuery) =>
			previousQuery?.queryKey[1] === sessionId && previousQuery.queryKey.at(-1) === scope ? previous : undefined,
	});
}

/** The read model's own session fold, read cold for a task that is not open (#434). */
export function useTelemetrySession(client: Client, sessionId: string, enabled: boolean) {
	return useQuery({
		meta: { errorSurface: "inline" },
		queryKey: ["telemetry", sessionId, "session"],
		queryFn: ({ signal }) =>
			client.call(routes.telemetrySession, { params: { id: sessionId }, query: {}, body: {} }, undefined, signal),
		enabled,
		retry: false,
		staleTime: 30_000,
	});
}

export function spendLine(spend: Spend): string | null {
	const missing = spend.missingTokenCalls
		? ` (${spend.missingTokenCalls} ${spend.missingTokenCalls === 1 ? "call" : "calls"} missing usage)`
		: "";
	const parts = [spend.tokens === null ? null : `${tokensText(spend.tokens)}${missing}`, spend.cost].filter(Boolean);
	return parts.length > 0 ? parts.join(" · ") : null;
}
