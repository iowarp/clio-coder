import type { Context, MiddlewareHandler } from "hono";
import { machinePrefix } from "../../contracts/pages.js";
import { routes } from "../../contracts/routes.js";
import { sameSecret as same } from "../launch-proof.js";
import type { ClientRecord, ClientRegistry } from "../services/clients.js";
import { AppProblem } from "../services/problem.js";
import { SECURITY_HEADERS } from "./security-headers.js";

declare module "hono" {
	interface ContextVariableMap {
		/** The client this request is attributed to; set for every authenticated API request. */
		clioClient: ClientRecord;
	}
}

const streams = Object.values(routes)
	.filter((route) => route.stream)
	.map((route) => new RegExp(`^${route.path.replace(/:[A-Za-z0-9]+/g, "[^/]+")}$`));

/** The API path a request names, on this server or through a node prefix; null for a page or asset. */
function apiPath(path: string): string | null {
	const rest = machinePrefix(path)?.rest ?? path;
	return rest === "/api" || rest.startsWith("/api/") ? rest : null;
}

/** The client an authenticated API request came from. */
export function requestClient(context: Context): ClientRecord {
	const client = context.get("clioClient");
	if (!client) throw new AppProblem("unauthorized", "This request carries no client credential.");
	return client;
}

/**
 * POST /api/auth/clients, which issues the caller its own credential, admits its caller itself
 * (`routes-auth.ts`): a launcher's proof of the launch token, a launch ticket, a live credential, or
 * the launch token as a bearer. Every other API request names its client with that credential, and the
 * event stream, which a browser cannot give a header, with a single-use ticket.
 */
export function auth(token: string, origin: () => string, clients: ClientRegistry): MiddlewareHandler {
	return async (context, next) => {
		const expected = new URL(origin());
		const host = context.req.header("host") ?? new URL(context.req.url).host;
		if (host !== expected.host) throw new AppProblem("unauthorized", "Host must match this loopback listener.", 421);
		const requestOrigin = context.req.header("origin");
		if (requestOrigin && requestOrigin !== expected.origin)
			throw new AppProblem("unauthorized", "Origin must match this loopback listener.");
		// One set for API responses, problem responses, the SSE stream and static
		// assets alike; a second copy anywhere else would only drift from this one.
		for (const [name, value] of Object.entries(SECURITY_HEADERS)) context.header(name, value);
		const api = apiPath(context.req.path);
		if (api !== null) {
			context.header("Cache-Control", "no-store");
			const authorization = context.req.header("authorization");
			const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
			if (context.req.path !== routes.authClients.path || context.req.method !== "POST") {
				const ticket = streams.some((pattern) => pattern.test(api)) ? context.req.query("ticket") : undefined;
				const client = bearer ? clients.authenticate(bearer) : ticket ? clients.redeem(ticket) : null;
				if (!client)
					throw new AppProblem(
						"unauthorized",
						bearer && same(token, bearer)
							? "The launch token only opens a client at POST /api/auth/clients; send that client's credential instead."
							: ticket
								? "The event stream ticket is unknown, used or expired."
								: "A valid client credential is required.",
					);
				context.set("clioClient", client);
				context.header("X-Clio-Client", client.clientId);
			}
		}
		await next();
		// Re-asserted on the settled response so no downstream handler can weaken the
		// policy by setting its own copy of one of these headers.
		for (const [name, value] of Object.entries(SECURITY_HEADERS)) context.res.headers.set(name, value);
	};
}
