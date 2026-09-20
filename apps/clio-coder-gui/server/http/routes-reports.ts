import type { Hono } from "hono";
import { routes } from "../../contracts/routes.js";
import type { EventHub } from "../services/event-hub.js";
import type { ReportsService } from "../services/reports.js";
import { register } from "./validate.js";
export function reportRoutes(app: Hono, hub: EventHub, reports: ReportsService) {
	register(app, hub, routes.evals, ({ query }) =>
		reports.evals({ kind: "list", ...query, limit: query.limit ?? 40 }, routes.evals.response),
	);
	register(app, hub, routes.evalDetail, ({ params }) =>
		reports.evals({ kind: "detail", id: params.id }, routes.evalDetail.response),
	);
	register(app, hub, routes.usage, ({ params }) => reports.usage(params.id));
}
