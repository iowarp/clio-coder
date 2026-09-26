import type { Hono } from "hono";
import { routes } from "../../contracts/routes.js";
import type { Supervisor } from "../acp/supervisor.js";
import type { EventHub } from "../services/event-hub.js";
import type { LibraryService } from "../services/library.js";
import { register } from "./validate.js";
export function libraryRoutes(app: Hono, hub: EventHub, library: LibraryService, supervisor?: Supervisor) {
	register(app, hub, routes.library, ({ params }) => library.read(params.id, "inventory", routes.library.response));
	register(app, hub, routes.libraryExtensions, ({ params }) =>
		library.read(params.id, "extensions", routes.libraryExtensions.response),
	);
	register(app, hub, routes.libraryPlan, ({ params, body }) => library.plan(params.id, body));
	// A committed change reaches the project's open conversations by asking each to reload, as
	// /library reload does in a terminal; the response says which did.
	register(app, hub, routes.libraryPlanApply, async ({ params }) => {
		const result = await library.apply(params.id, params.planId);
		if (result.committed === 0 || supervisor === undefined) return result;
		return { ...result, refresh: await supervisor.reloadLibrary(params.id) };
	});
	register(app, hub, routes.libraryPlanRelease, ({ params }) => library.release(params.id, params.planId));
	register(app, hub, routes.libraryAgents, ({ params }) => library.agents(params.id));
	register(app, hub, routes.libraryVerifiers, ({ params }) => library.verifiers(params.id));
}
