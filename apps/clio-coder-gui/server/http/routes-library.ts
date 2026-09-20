import type { Hono } from "hono";
import { routes } from "../../contracts/routes.js";
import type { EventHub } from "../services/event-hub.js";
import type { LibraryService } from "../services/library.js";
import { register } from "./validate.js";
export function libraryRoutes(app: Hono, hub: EventHub, library: LibraryService) {
	register(app, hub, routes.library, ({ params }) => library.read(params.id, "inventory", routes.library.response));
	register(app, hub, routes.libraryExtensions, ({ params }) =>
		library.read(params.id, "extensions", routes.libraryExtensions.response),
	);
	register(app, hub, routes.libraryPlan, ({ params, body }) => library.plan(params.id, body));
	register(app, hub, routes.libraryPlanApply, ({ params }) => library.apply(params.id, params.planId));
	register(app, hub, routes.libraryPlanRelease, ({ params }) => library.release(params.id, params.planId));
	register(app, hub, routes.libraryAgents, ({ params }) => library.agents(params.id));
	register(app, hub, routes.libraryVerifiers, ({ params }) => library.verifiers(params.id));
}
