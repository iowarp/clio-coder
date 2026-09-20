import type { Hono } from "hono";
import { routes } from "../../contracts/routes.js";
import type { EventHub } from "../services/event-hub.js";
import type { FleetService } from "../services/fleet.js";
import { register } from "./validate.js";

export function fleetRoutes(app: Hono, hub: EventHub, fleet: FleetService) {
	register(app, hub, routes.fleetRoots, ({ query }) =>
		fleet.read({ kind: "roots", ...query, limit: query.limit ?? 40 }, routes.fleetRoots.response),
	);
	register(app, hub, routes.fleetRoot, ({ params }) =>
		fleet.read({ kind: "root", ...params }, routes.fleetRoot.response),
	);
	register(app, hub, routes.dispatchRuns, ({ query }) =>
		fleet.read({ kind: "dispatches", ...query, limit: query.limit ?? 40 }, routes.dispatchRuns.response),
	);
	register(app, hub, routes.dispatchRun, ({ params }) =>
		fleet.read({ kind: "dispatch", ...params }, routes.dispatchRun.response),
	);
	register(app, hub, routes.fleetReceipt, ({ params }) =>
		fleet.read({ kind: "receipt", ...params }, routes.fleetReceipt.response),
	);
	register(app, hub, routes.fleetCouncils, () => fleet.read({ kind: "councils" }, routes.fleetCouncils.response));
	register(app, hub, routes.fleetGates, () => fleet.read({ kind: "gates" }, routes.fleetGates.response));
}
