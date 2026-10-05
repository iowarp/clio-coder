import type { QueryClient } from "@tanstack/react-query";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { AgentCapabilities } from "../../contracts/capabilities.js";
import { routes } from "../../contracts/routes.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import type { CommandRequest, CommandResult } from "../../contracts/steering.js";
import type { ContextOperationStatus } from "../../contracts/wire.js";
import type { Client } from "../api/client.js";
import type { ContextOperationRef } from "./context-command-model.js";
import {
	contextCommandKind,
	currentContextOperation,
	sameOperationRef,
	startedByCommand,
} from "./context-command-model.js";

/**
 * The session's latest operation as a value that changes only when its identity or outcome does. A progress
 * tick replaces the operation object without changing any of this, and the composer must not render for it.
 */
export function useContextOperationRef(work: ContextOperationStatus | undefined): ContextOperationRef | null {
	const next = currentContextOperation(work);
	const held = useRef(next);
	if (!sameOperationRef(held.current, next)) held.current = next;
	return held.current;
}

/**
 * Stopping context work. The server answers 200 once the stop is accepted, but the operation is over only
 * when the session reports its outcome, so the request stays "stopping" until then: it is remembered by
 * operation id, which ends it for that operation's conclusion and for any later run, and by a refusal.
 */
export function useStopContext(client: Client, sessionId: string) {
	const queries = useQueryClient();
	const [stopping, setStopping] = useState<string | null>(null);
	const mutation = useMutation({
		mutationFn: (operationId: string) =>
			client.call(routes.cancelSessionContext, { params: { id: sessionId }, query: {}, body: { operationId } }),
		onMutate: (operationId) => setStopping(operationId),
		onError: (_error, operationId) => setStopping((current) => (current === operationId ? null : current)),
		onSettled: () => void queries.invalidateQueries({ queryKey: ["session-context-work", sessionId] }),
	});
	return { stop: mutation.mutate, stopping, error: mutation.error };
}

/** The operation the session last reported, read before a command is sent. */
export function contextBaseline(queries: QueryClient, sessionId: string): string | null {
	return currentContextOperation(queries.getQueryData<SessionSnapshot>(["session", sessionId])?.contextWork)?.id ?? null;
}

/**
 * Runs a command and names the context operation it opened, if any. The event stream and the command reply
 * travel separately and may arrive in either order, so the operation is read from what the page already
 * holds and then, if it is not there yet, from the session's authoritative status.
 */
export async function invokeContextCommand({
	client,
	queries,
	sessionId,
	request,
	baseline,
	key,
}: {
	client: Client;
	queries: QueryClient;
	sessionId: string;
	request: CommandRequest;
	baseline: string | null;
	key?: string;
}): Promise<{ result: CommandResult; owner: ContextOperationRef | null }> {
	const result = await client.call(
		routes.invokeSessionCommand,
		{ params: { id: sessionId }, query: {}, body: request },
		key,
	);
	const kind = contextCommandKind(request);
	if (kind === null) return { result, owner: null };
	const find = (work: Parameters<typeof currentContextOperation>[0]) =>
		startedByCommand(kind, sessionId, baseline, currentContextOperation(work));
	const held = find(queries.getQueryData<SessionSnapshot>(["session", sessionId])?.contextWork);
	if (held?.outcome !== undefined) return { result, owner: held };
	const reported = queries.getQueryData<AgentCapabilities>(["session-capabilities", sessionId])?.context?.status;
	if (!reported) return { result, owner: held };
	try {
		const status = await client.call(routes.sessionContextStatus, { params: { id: sessionId }, query: {}, body: {} });
		return { result, owner: find(status) ?? held };
	} catch {
		// Ownership only decides whether the command repeats its card. Without an answer the command's own
		// output stays on screen, which is the safe side to fail on.
		return { result, owner: held };
	}
}
