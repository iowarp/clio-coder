import type { Context, Hono } from "hono";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { Input, Output, Route } from "../../contracts/routes.js";
import type { EventHub } from "../services/event-hub.js";
import { AppProblem } from "../services/problem.js";

export function parse<S extends TSchema>(schema: S, value: unknown): Static<S> {
	if (!Value.Check(schema, value)) {
		const error = [...Value.Errors(schema, value)][0];
		throw new AppProblem(
			"validation",
			`Invalid request at ${error?.instancePath || "/"}: ${error?.message ?? "schema mismatch"}`,
		);
	}
	return value;
}
export function idempotencyKey(context: Context) {
	const key = context.req.header("Idempotency-Key");
	if (!key || key.length > 128 || !/^[\x21-\x7e]+$/.test(key))
		throw new AppProblem("validation", "Idempotency-Key must contain 1–128 printable characters.");
	return key;
}
export type Handler<R extends Route> = (
	input: Input<R>,
	context: Context,
) => Output<R> | Response | Promise<Output<R> | Response>;
export function register<R extends Route>(app: Hono, hub: EventHub, route: R, handler: Handler<R>) {
	app.on(route.method, route.path, async (context) => {
		const query: Record<string, unknown> = {};
		for (const [key, values] of Object.entries(context.req.queries())) {
			if (values.length !== 1) throw new AppProblem("validation", `Duplicate query parameter: ${key}`);
			query[key] = values[0];
		}
		let body: unknown = {};
		if (route.method === "POST") {
			idempotencyKey(context);
			if (context.req.header("content-type")?.split(";")[0] !== "application/json")
				throw new AppProblem("validation", "Expected an application/json body.");
			try {
				body = await context.req.json();
			} catch {
				throw new AppProblem("validation", "Invalid JSON body.");
			}
		}
		const input = {
			params: parse(route.params, context.req.param()),
			query: parse(route.query, Value.Convert(route.query, query)),
			body: parse(route.body, body),
		} as Input<R>;
		context.header("X-Clio-Epoch", hub.epoch);
		context.header("X-Clio-Seq", String(hub.seq));
		const result = await handler(input, context);
		return result instanceof Response ? result : context.json(result, route.status);
	});
}
