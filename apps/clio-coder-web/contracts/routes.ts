import { type Static, type TSchema, Type } from "typebox";
import { Empty, Id } from "./common.js";
import { EventCursor } from "./events.js";
import { Meta } from "./meta.js";
import { Accepted, Operation } from "./operations.js";
import { Install, Tools } from "./toolchain.js";
import {
	RowCursor,
	TraceEnvelope,
	TraceEventsPage,
	TraceEventsQuery,
	TraceGate,
	TraceParams,
	TracePhase,
	TraceProcess,
	TraceReceipt,
	TraceRun,
	TraceRunsPage,
	TraceRunsQuery,
	TraceStatus,
} from "./traces.js";

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
	traceStatus: defineRoute({
		...get,
		path: "/api/traces/status",
		response: TraceStatus,
		summary: "Trace availability and retention",
	}),
	traceRuns: defineRoute({
		...get,
		path: "/api/traces/runs",
		query: TraceRunsQuery,
		response: TraceRunsPage,
		summary: "Paginated trace history",
	}),
	traceRun: defineRoute({
		...get,
		path: "/api/traces/runs/:runId",
		params: TraceParams,
		response: TraceRun,
		summary: "Trace run",
	}),
	tracePhases: defineRoute({
		...get,
		path: "/api/traces/runs/:runId/phases",
		params: TraceParams,
		response: Type.Array(TracePhase),
		summary: "Run phases",
	}),
	traceGates: defineRoute({
		...get,
		path: "/api/traces/runs/:runId/gates",
		params: TraceParams,
		response: Type.Array(TraceGate),
		summary: "Run gates",
	}),
	traceEnvelopes: defineRoute({
		...get,
		path: "/api/traces/runs/:runId/envelopes",
		params: TraceParams,
		response: Type.Array(TraceEnvelope),
		summary: "Run envelopes",
	}),
	traceProcesses: defineRoute({
		...get,
		path: "/api/traces/runs/:runId/processes",
		params: TraceParams,
		response: Type.Array(TraceProcess),
		summary: "Run processes",
	}),
	traceEvents: defineRoute({
		...get,
		path: "/api/traces/runs/:runId/events",
		params: TraceParams,
		query: TraceEventsQuery,
		response: TraceEventsPage,
		summary: "Run events by rowid",
	}),
	traceReceipt: defineRoute({
		...get,
		path: "/api/traces/runs/:runId/receipt",
		params: TraceParams,
		query: Type.Object({ include: Type.Optional(Type.Literal("full")) }, { additionalProperties: false }),
		response: TraceReceipt,
		summary: "Receipt and evidence summary; full payload on request",
	}),
	traceLive: defineRoute({
		...get,
		path: "/api/traces/runs/:runId/live",
		params: TraceParams,
		query: Type.Object(
			{ after: Type.Optional(RowCursor), token: Type.Optional(Type.String({ maxLength: 256 })) },
			{ additionalProperties: false },
		),
		response: Type.String(),
		stream: true,
		summary: "Live rowid event tail",
	}),
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
