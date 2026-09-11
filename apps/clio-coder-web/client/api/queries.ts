import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Operation } from "../../contracts/operations.js";
import { routes } from "../../contracts/routes.js";
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
