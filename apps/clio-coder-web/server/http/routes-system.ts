import type { Hono } from "hono";
import { routes } from "../../contracts/routes.js";
import type { EventHub } from "../services/event-hub.js";
import type { SystemService } from "../services/system.js";
import { register } from "./validate.js";
export function systemRoutes(app: Hono, hub: EventHub, system: SystemService) {
	register(app, hub, routes.system, () => system.report());
	register(app, hub, routes.interop, ({ params }) => system.interop(params.id));
}
