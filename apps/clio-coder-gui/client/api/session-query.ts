import { queryOptions } from "@tanstack/react-query";
import { routes } from "../../contracts/routes.js";
import type { Client } from "./client.js";
import { sessionBuffer } from "./sessions.js";

/** Opening a prefetched session shares both its read and the revision rules used by the live view. */
export function sessionQuery(client: Client, id: string) {
	return queryOptions({
		queryKey: ["session", id],
		queryFn: async ({ signal }) => {
			const snapshot = await client.call(routes.session, { params: { id }, query: {}, body: {} }, undefined, signal);
			return sessionBuffer(id).snapshot(snapshot) ?? snapshot;
		},
		staleTime: 5_000,
	});
}
