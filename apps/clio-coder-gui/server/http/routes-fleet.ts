import type { Hono } from "hono";
import { routes } from "../../contracts/routes.js";
import { type ArtifactWindow, MAX_SERVED_ARTIFACT_IDS, RUN_KINDS } from "../services/artifact-window.js";
import type { EventHub } from "../services/event-hub.js";
import type { FleetService } from "../services/fleet.js";
import { register } from "./validate.js";

export function fleetRoutes(app: Hono, hub: EventHub, fleet: FleetService, artifacts: ArtifactWindow) {
	register(app, hub, routes.fleetRoots, async ({ query }) => {
		const page = await fleet.read(
			// FleetPageQuery still admits 100, which no single window could hold; the
			// clamp is what makes an over-serve unreachable from HTTP.
			{ kind: "roots", ...query, limit: Math.min(query.limit ?? 40, MAX_SERVED_ARTIFACT_IDS) },
			routes.fleetRoots.response,
		);
		artifacts.page(
			"run",
			query.cursor,
			page.items.map((item) => item.id),
		);
		return page;
	});
	register(app, hub, routes.fleetRoot, ({ params }) =>
		fleet.read({ kind: "root", ...params }, routes.fleetRoot.response),
	);
	register(app, hub, routes.dispatchRuns, async ({ query }) => {
		const page = await fleet.read(
			{ kind: "dispatches", ...query, limit: Math.min(query.limit ?? 40, MAX_SERVED_ARTIFACT_IDS) },
			routes.dispatchRuns.response,
		);
		artifacts.page(
			"dispatch",
			query.cursor,
			page.items.map((item) => item.id),
		);
		return page;
	});
	register(app, hub, routes.dispatchRun, ({ params }) =>
		fleet.read({ kind: "dispatch", ...params }, routes.dispatchRun.response),
	);
	register(app, hub, routes.fleetReceipt, ({ params }) =>
		fleet.read({ kind: "receipt", id: artifacts.admitAny(RUN_KINDS, params.id) }, routes.fleetReceipt.response),
	);
	register(app, hub, routes.fleetCouncils, () => fleet.read({ kind: "councils" }, routes.fleetCouncils.response));
	register(app, hub, routes.fleetGates, () => fleet.read({ kind: "gates" }, routes.fleetGates.response));
}
