import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Operation } from "../../contracts/operations.js";
import { routes } from "../../contracts/runtime-routes.js";
import type { Client } from "./client.js";

export function useOperation(client: Client, id: string | null) {
	const queries = useQueryClient();
	return useQuery({
		queryKey: ["operation", id],
		enabled: id !== null,
		retry: false,
		queryFn: async () => {
			const result = await client.call(routes.operation, { params: { id: id ?? "" }, query: {}, body: {} });
			const current = queries.getQueryData<Operation>(["operation", id]);
			return current && current.revision > result.revision ? current : result;
		},
	});
}

/**
 * The saved-task list costs the server an agent process per read and changes only when a task is renamed, closed or
 * deleted, each of which invalidates it. An unsupported answer is final too, so a mount does not retry it.
 */
export const SESSION_HISTORY_FRESHNESS = {
	staleTime: 5 * 60_000,
	refetchOnWindowFocus: false,
	retry: false,
	retryOnMount: false,
} as const;

/** Reads a task switch would repeat; each is asked of the agent and changes only through events that invalidate it. */
export const SWITCH_FRESHNESS = { staleTime: 60_000, refetchOnWindowFocus: false } as const;
