import type { Hono } from "hono";
import { routes } from "../../contracts/routes.js";
import type { EventHub } from "../services/event-hub.js";
import type { TraceService } from "../services/traces.js";
import { register } from "./validate.js";

/** Trace history and one run's identity; a run's numbers and timeline are the telemetry routes' (#434). */
export function traceRoutes(app: Hono, hub: EventHub, traces: TraceService) {
	register(app, hub, routes.traceRuns, ({ query }) => traces.read({ kind: "runs", query }, routes.traceRuns.response));
	register(app, hub, routes.traceRun, ({ params }) => traces.read({ kind: "run", ...params }, routes.traceRun.response));
	register(app, hub, routes.traceRunRecord, ({ params, query }) =>
		traces.read({ kind: "run-record", ...params, full: query.include === "full" }, routes.traceRunRecord.response),
	);
}
