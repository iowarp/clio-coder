import type { Hono } from "hono";
import { routes } from "../../contracts/routes.js";
import type { EventHub } from "../services/event-hub.js";
import type { ReportsService } from "../services/reports.js";
import { register } from "./validate.js";
export function reportRoutes(app: Hono, hub: EventHub, reports: ReportsService) {
	register(app, hub, routes.usage, ({ params }) => reports.usage(params.id));
}
