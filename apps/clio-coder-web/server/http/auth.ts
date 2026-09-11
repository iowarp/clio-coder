import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { AppProblem } from "../services/problem.js";

export function auth(token: string, origin: () => string): MiddlewareHandler {
	return async (context, next) => {
		const expected = new URL(origin());
		const host = context.req.header("host") ?? new URL(context.req.url).host;
		if (host !== expected.host) throw new AppProblem("unauthorized", "Host must match this loopback listener.", 421);
		const requestOrigin = context.req.header("origin");
		if (requestOrigin && requestOrigin !== expected.origin)
			throw new AppProblem("unauthorized", "Origin must match this loopback listener.");
		context.header("Referrer-Policy", "no-referrer");
		context.header("X-Content-Type-Options", "nosniff");
		if (context.req.path === "/api" || context.req.path.startsWith("/api/")) {
			const authorization = context.req.header("authorization");
			const supplied =
				(authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined) ??
				(context.req.path === "/api/events" ? context.req.query("token") : undefined) ??
				"";
			const a = Buffer.from(token),
				b = Buffer.from(supplied);
			if (a.length !== b.length || !timingSafeEqual(a, b))
				throw new AppProblem("unauthorized", "A valid launch token is required.");
			context.header("Cache-Control", "no-store");
		}
		await next();
	};
}
