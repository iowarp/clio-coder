import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { routes } from "../../contracts/routes.js";
import { AppProblem } from "../services/problem.js";
import { SECURITY_HEADERS } from "./security-headers.js";

const streams = Object.values(routes)
	.filter((route) => route.stream)
	.map((route) => new RegExp(`^${route.path.replace(/:[A-Za-z0-9]+/g, "[^/]+")}$`));

export function auth(token: string, origin: () => string): MiddlewareHandler {
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
		if (context.req.path === "/api" || context.req.path.startsWith("/api/")) {
			const authorization = context.req.header("authorization");
			const supplied =
				(authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined) ??
				(streams.some((pattern) => pattern.test(context.req.path)) ? context.req.query("token") : undefined) ??
				"";
			const a = Buffer.from(token),
				b = Buffer.from(supplied);
			if (a.length !== b.length || !timingSafeEqual(a, b))
				throw new AppProblem("unauthorized", "A valid launch token is required.");
			context.header("Cache-Control", "no-store");
		}
		await next();
		// Re-asserted on the settled response so no downstream handler can weaken the
		// policy by setting its own copy of one of these headers.
		for (const [name, value] of Object.entries(SECURITY_HEADERS)) context.res.headers.set(name, value);
	};
}
