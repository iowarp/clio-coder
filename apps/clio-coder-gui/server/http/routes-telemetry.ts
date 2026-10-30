import type { Hono } from "hono";
import { routes } from "../../contracts/routes.js";
import type { TelemetryCallsQuery } from "../../contracts/telemetry.js";
import { CallFilterSchema } from "../../contracts/wire.js";
import type { EventHub } from "../services/event-hub.js";
import { AppProblem } from "../services/problem.js";
import type { TelemetryService } from "../services/telemetry.js";
import { parse, register } from "./validate.js";

/** Query strings are flat; the list filters arrive comma-separated and are checked as the read model's CallFilter. */
function callFilter(query: TelemetryCallsQuery) {
	const list = (value: string | undefined) => value?.split(",");
	return parse(CallFilterSchema, {
		...(query.labels !== undefined ? { labels: list(query.labels) } : {}),
		...(query.dispositions !== undefined ? { dispositions: list(query.dispositions) } : {}),
		...(query.turnIds !== undefined ? { turnIds: list(query.turnIds) } : {}),
		...(query.runId !== undefined ? { runId: query.runId } : {}),
		...(query.from !== undefined ? { from: query.from } : {}),
		...(query.to !== undefined ? { to: query.to } : {}),
		...(query.limit !== undefined ? { limit: query.limit } : {}),
	});
}

export function telemetryRoutes(app: Hono, hub: EventHub, telemetry: TelemetryService) {
	register(app, hub, routes.telemetrySession, ({ params }) =>
		telemetry.read({ kind: "session", sessionId: params.id }, routes.telemetrySession.response),
	);
	register(app, hub, routes.telemetryCalls, ({ params, query }) =>
		telemetry.read({ kind: "calls", sessionId: params.id, filter: callFilter(query) }, routes.telemetryCalls.response),
	);
	register(app, hub, routes.telemetryCost, ({ params, query }) =>
		telemetry.read({ kind: "cost", sessionId: params.id, by: query.by ?? "label" }, routes.telemetryCost.response),
	);
	register(app, hub, routes.telemetryCache, ({ params }) =>
		telemetry.read({ kind: "cache", sessionId: params.id }, routes.telemetryCache.response),
	);
	register(app, hub, routes.telemetryTimeline, ({ params, query }) => {
		if ((query.from === undefined) !== (query.to === undefined))
			throw new AppProblem("validation", "A timeline range needs both from and to.");
		const range = query.from !== undefined && query.to !== undefined ? { from: query.from, to: query.to } : null;
		return telemetry.read({ kind: "timeline", sessionId: params.id, range }, routes.telemetryTimeline.response);
	});
	register(app, hub, routes.telemetryWhyStopped, ({ params }) =>
		telemetry.read({ kind: "why-stopped", sessionId: params.id }, routes.telemetryWhyStopped.response),
	);
	register(app, hub, routes.telemetryExplain, ({ query }) =>
		telemetry.read({ kind: "explain", ref: query.ref }, routes.telemetryExplain.response),
	);
}
