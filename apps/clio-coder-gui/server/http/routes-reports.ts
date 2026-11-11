import type { Hono } from "hono";
import { routes } from "../../contracts/routes.js";
import type { EventHub } from "../services/event-hub.js";
import type { ProblemReportsService } from "../services/problem-reports.js";
import type { ReportsService } from "../services/reports.js";
import { register } from "./validate.js";
export function reportRoutes(app: Hono, hub: EventHub, reports: ReportsService, problems?: ProblemReportsService) {
	register(app, hub, routes.usage, ({ params }) => reports.usage(params.id));
	if (!problems) return;
	register(app, hub, routes.problemReports, ({ params }) => problems.status(params.id));
	register(app, hub, routes.problemReportPlan, ({ params, body }) => problems.plan(params.id, body));
	register(app, hub, routes.problemReportUpdate, ({ params, body }) => problems.update(params.id, params.draft, body));
	register(app, hub, routes.problemReportSend, ({ params, body }) => problems.send(params.id, params.draft, body));
	register(app, hub, routes.problemReportBundle, ({ params, body }) => problems.bundle(params.id, params.draft, body));
	register(app, hub, routes.problemReportOffer, ({ params, body }) => problems.offer(params.id, body.sessionId));
}
