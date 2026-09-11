import type { Problem } from "../../contracts/common.js";
import type { Input, Output, Route } from "../../contracts/routes.js";
import { clock } from "./clock.js";

export class ApiProblem extends Error {
	constructor(readonly problem: Problem) {
		super(problem.detail);
	}
}
export function createClient(token: string, fetcher: typeof fetch = fetch) {
	return {
		token,
		async call<R extends Route>(route: R, input: Input<R>, key?: string): Promise<Output<R>> {
			const path = route.path.replace(/:([A-Za-z0-9]+)/g, (_, name: string) =>
				encodeURIComponent(String((input.params as Record<string, unknown>)[name])),
			);
			const query = new URLSearchParams();
			for (const [name, value] of Object.entries(input.query as Record<string, unknown>)) {
				if (value !== undefined) query.set(name, String(value));
			}
			let response: Response;
			try {
				response = await fetcher(`${path}${query.size ? `?${query}` : ""}`, {
					method: route.method,
					headers: {
						Authorization: `Bearer ${token}`,
						...(route.method === "POST"
							? { "Content-Type": "application/json", "Idempotency-Key": key ?? crypto.randomUUID() }
							: {}),
					},
					...(route.method === "POST" ? { body: JSON.stringify(input.body) } : {}),
				});
			} catch {
				throw new ApiProblem({
					type: "urn:clio-coder:problem:unavailable",
					title: "Server unavailable",
					status: 503,
					code: "unavailable",
					detail: "Cannot reach Clio Coder. Check that the server is running.",
					instance: "browser",
				});
			}
			clock.adopt(response.headers.get("date"));
			if (!response.ok) throw new ApiProblem((await response.json()) as Problem);
			return response.json() as Promise<Output<R>>;
		},
	};
}
export type Client = ReturnType<typeof createClient>;
export const emptyInput = { params: {}, query: {}, body: {} };
