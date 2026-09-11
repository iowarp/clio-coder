import type { Context } from "hono";
import { problemOf } from "../services/problem.js";
export function problemResponse(error: unknown, context: Context) {
	const problem = problemOf(error);
	return context.newResponse(JSON.stringify(problem), problem.status as 400, {
		"Content-Type": "application/problem+json",
		"Cache-Control": "no-store",
		...(problem.code === "unavailable" ? { "Retry-After": "1" } : {}),
	});
}
