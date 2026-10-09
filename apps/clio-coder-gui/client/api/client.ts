import type { Problem } from "../../contracts/common.js";
import type { Input, Output, Route } from "../../contracts/routes.js";
import { markTokenRejected, tokenRejected } from "./auth-state.js";
import { clock } from "./clock.js";
import { dropStoredToken } from "./token.js";

export class ApiProblem extends Error {
	constructor(readonly problem: Problem) {
		super(problem.detail);
	}
}
function unauthorized() {
	return new ApiProblem({
		type: "urn:clio-coder:problem:unauthorized",
		title: "unauthorized",
		status: 401,
		code: "unauthorized",
		detail: "A valid launch token is required.",
		instance: "browser",
	});
}
export function createClient(token: string, fetcher: typeof fetch = fetch) {
	return {
		token,
		/** `signal` cancels the request itself; a cancelled call rejects with the abort, never as "server unavailable". */
		async call<R extends Route>(route: R, input: Input<R>, key?: string, signal?: AbortSignal): Promise<Output<R>> {
			// A refused token only recovers through a reload, so nothing else is read in this document.
			if (tokenRejected()) throw unauthorized();
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
						...(route.method !== "GET"
							? { "Content-Type": "application/json", "Idempotency-Key": key ?? crypto.randomUUID() }
							: {}),
					},
					...(route.method !== "GET" ? { body: JSON.stringify(input.body) } : {}),
					...(signal ? { signal } : {}),
				});
			} catch (error) {
				if (signal?.aborted) throw signal.reason ?? error;
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
			if (response.status === 401) {
				// 421 (wrong host) is also "unauthorized" but says nothing about the token.
				dropStoredToken();
				markTokenRejected();
			}
			if (!response.ok) throw new ApiProblem((await response.json()) as Problem);
			return response.json() as Promise<Output<R>>;
		},
	};
}
export type Client = ReturnType<typeof createClient>;
export const emptyInput = { params: {}, query: {}, body: {} };
