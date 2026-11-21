import { queryOptions } from "@tanstack/react-query";
import { routes } from "../../contracts/runtime-routes.js";
import { ApiProblem, type Client } from "./client.js";
import { sessionBuffer } from "./sessions.js";

/**
 * A task this server has not opened, said the way the snapshot route says it, so the page's search for its project
 * starts exactly as before. No request carried it: the presence read answered first.
 */
function notOpenHere(id: string): ApiProblem {
	return new ApiProblem({
		type: "urn:clio-coder:problem:not_found",
		title: "not found",
		status: 404,
		detail: "Session is not open in this server.",
		code: "not_found",
		instance: id,
	});
}

/**
 * Opening a prefetched session shares both its read and the revision rules used by the live view. A first read with
 * no snapshot held asks whether the server holds the task at all: a saved task, or one live in a terminal, is
 * answered there instead of by a 404 the browser logs as an error.
 */
export function sessionQuery(client: Client, id: string) {
	return queryOptions({
		queryKey: ["session", id],
		queryFn: async ({ signal, client: queries, queryKey }) => {
			if (queries.getQueryData(queryKey) === undefined) {
				const presence = await client.call(
					routes.sessionPresence,
					{ params: { id }, query: {}, body: {} },
					undefined,
					signal,
				);
				if (!presence.open) throw notOpenHere(id);
			}
			const snapshot = await client.call(routes.session, { params: { id }, query: {}, body: {} }, undefined, signal);
			return sessionBuffer(id).snapshot(snapshot) ?? snapshot;
		},
		// The event stream keeps the snapshot current: deltas fold into it, a revision gap and a reconnect
		// invalidate it, and invalidation refetches an active query whatever its staleTime.
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});
}
