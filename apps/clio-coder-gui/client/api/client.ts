import type { Problem } from "../../contracts/common.js";
import { machinePrefix } from "../../contracts/pages.js";
import { type Input, type Output, type Route, routes } from "../../contracts/runtime-routes.js";
import { tokenRejected } from "./auth-state.js";
import { clock } from "./clock.js";
import { CredentialProblem, type Credentials, createCredentials, unauthorizedProblem } from "./credentials.js";

export class ApiProblem extends Error {
	constructor(readonly problem: Problem) {
		super(problem.detail);
	}
}
/**
 * `prefix` is `/m/<id>` while this client drives a registered node's own GUI through the app on this
 * machine, which proxies every call there; empty for this machine's own app. `credentials` is the
 * document's one holder, shared with the unprefixed client, because this app issues every credential
 * and ticket the browser holds, whichever server the call reaches.
 */
export function createClient(
	token: string,
	fetcher: typeof fetch = fetch,
	prefix = "",
	credentials: Credentials = createCredentials(token, fetcher),
) {
	let epoch: string | undefined;
	return {
		token,
		/** Whether this document opened with anything that can open a client; the launch token alone no longer says so. */
		signedIn: credentials.available(),
		prefix,
		credentials,
		/** The registered node this client addresses, or null for this machine. */
		machine: machinePrefix(prefix)?.id ?? null,
		currentEpoch: () => epoch ?? null,
		/** The event stream establishes which server may answer reads in this document (GUI-03). */
		adoptEpoch(value: string) {
			epoch = value;
		},
		/** The event stream's address: a ticket from this app opens it, never a bearer in the URL. */
		async eventsUrl(after?: string) {
			let ticket: string;
			try {
				ticket = await credentials.ticket();
			} catch (error) {
				throw error instanceof CredentialProblem ? new ApiProblem(error.problem) : error;
			}
			const query = new URLSearchParams({ ticket });
			if (after !== undefined) query.set("after", after);
			return `${prefix}${routes.events.path}?${query}`;
		},
		/** `signal` cancels the request itself; a cancelled call rejects with the abort, never as "server unavailable". */
		async call<R extends Route>(
			route: R,
			input: Input<R>,
			key?: string,
			signal?: AbortSignal,
			expectedEpoch?: string,
		): Promise<Output<R>> {
			// A refused token only recovers through a reload, so nothing else is read in this document.
			if (tokenRejected()) throw new ApiProblem(unauthorizedProblem());
			// Retained requests pin their original preflight epoch. The server checks it before
			// admitting a write, including a restart that raced the preflight response.
			const commandEpoch = expectedEpoch ?? epoch;
			const path = route.path.replace(/:([A-Za-z0-9]+)/g, (_, name: string) =>
				encodeURIComponent(String((input.params as Record<string, unknown>)[name])),
			);
			const query = new URLSearchParams();
			const idempotency = crypto.randomUUID();
			for (const [name, value] of Object.entries(input.query as Record<string, unknown>)) {
				if (value !== undefined) query.set(name, String(value));
			}
			let response: Response | undefined;
			// A 401 means the server refused the credential before handling the request, so a retry with a
			// fresh one cannot run it twice. A second refusal, or the exchange's own, settles it.
			for (let attempt = 0; attempt < 2; attempt += 1) {
				let bearer: string;
				try {
					bearer = await credentials.bearer();
				} catch (error) {
					throw error instanceof CredentialProblem ? new ApiProblem(error.problem) : error;
				}
				try {
					response = await fetcher(`${prefix}${path}${query.size ? `?${query}` : ""}`, {
						method: route.method,
						headers: {
							Authorization: `Bearer ${bearer}`,
							...(route.method !== "GET" ? { "Content-Type": "application/json", "Idempotency-Key": key ?? idempotency } : {}),
							...(route.method !== "GET" && commandEpoch !== undefined ? { "X-Clio-Epoch": commandEpoch } : {}),
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
				// 421 (wrong host) is also "unauthorized" but says nothing about the credential.
				if (response.status !== 401) break;
				credentials.refused(bearer);
				if (attempt === 0) await response.body?.cancel().catch(() => {});
			}
			if (!response) throw new ApiProblem(unauthorizedProblem());
			if (!response.ok) throw new ApiProblem((await response.json()) as Problem);
			const value = (await response.json()) as Output<R>;
			if (signal?.aborted) throw signal.reason;
			const responseEpoch = response.headers.get("X-Clio-Epoch");
			if (epoch !== undefined && responseEpoch !== null && responseEpoch !== epoch)
				throw new ApiProblem({
					type: "urn:clio-coder:problem:unavailable",
					title: "Server changed",
					status: 503,
					code: "unavailable",
					detail: "Clio Coder restarted while this request was in flight. Refresh the task before continuing.",
					instance: "browser",
				});
			return value;
		},
	};
}
export type Client = ReturnType<typeof createClient>;
export const emptyInput = { params: {}, query: {}, body: {} };
