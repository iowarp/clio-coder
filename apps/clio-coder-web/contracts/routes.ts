import { type Static, type TSchema, Type } from "typebox";
import { Empty, Id } from "./common.js";
import { EventCursor } from "./events.js";
import { Meta } from "./meta.js";
import { Accepted, Operation } from "./operations.js";
import { Install, Tools } from "./toolchain.js";

export interface Route<
	P extends TSchema = TSchema,
	Q extends TSchema = TSchema,
	B extends TSchema = TSchema,
	R extends TSchema = TSchema,
> {
	method: "GET" | "POST";
	path: string;
	params: P;
	query: Q;
	body: B;
	response: R;
	status: 200 | 202;
	summary: string;
	stream?: true;
}
export function defineRoute<P extends TSchema, Q extends TSchema, B extends TSchema, R extends TSchema>(
	route: Route<P, Q, B, R>,
): Route<P, Q, B, R> {
	return route;
}
export type Input<R extends Route> = {
	params: Static<R["params"]>;
	query: Static<R["query"]>;
	body: Static<R["body"]>;
};
export type Output<R extends Route> = Static<R["response"]>;
const toolParams = Type.Object({ toolId: Id }, { additionalProperties: false });
const operationParams = Type.Object({ id: Id }, { additionalProperties: false });
const get = { method: "GET", params: Empty, query: Empty, body: Empty, status: 200 } as const;
const post = { method: "POST", query: Empty, body: Empty, status: 202 } as const;
export const routes = {
	meta: defineRoute({ ...get, path: "/api/meta", response: Meta, summary: "Application and Clio versions" }),
	openapi: defineRoute({
		...get,
		path: "/api/openapi.json",
		response: Type.Record(Type.String(), Type.Unknown()),
		summary: "OpenAPI contract",
	}),
	events: defineRoute({
		...get,
		path: "/api/events",
		query: Type.Object(
			{ after: Type.Optional(EventCursor), token: Type.Optional(Type.String({ maxLength: 256 })) },
			{ additionalProperties: false },
		),
		response: Type.String(),
		stream: true,
		summary: "Global event stream",
	}),
	tools: defineRoute({
		...get,
		path: "/api/toolchain/tools",
		response: Tools,
		summary: "Pinned tools in registry order",
	}),
	install: defineRoute({
		...post,
		path: "/api/toolchain/tools/:toolId/install",
		params: toolParams,
		body: Install,
		response: Accepted,
		summary: "Install the pinned tool",
	}),
	remove: defineRoute({
		...post,
		path: "/api/toolchain/tools/:toolId/remove",
		params: toolParams,
		response: Accepted,
		summary: "Remove vendored versions",
	}),
	operation: defineRoute({
		...get,
		path: "/api/operations/:id",
		params: operationParams,
		response: Operation,
		summary: "Operation snapshot",
	}),
	cancel: defineRoute({
		...post,
		status: 200,
		path: "/api/operations/:id/cancel",
		params: operationParams,
		response: Operation,
		summary: "Cancel a cancellable operation",
	}),
};
