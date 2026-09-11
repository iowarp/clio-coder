import type { Hono } from "hono";
import { routes } from "../../contracts/routes.js";
import type { EventHub } from "../services/event-hub.js";
import type { TargetsService } from "../services/targets-cli.js";
import { idempotencyKey, register } from "./validate.js";

export function targetsRoutes(app: Hono, hub: EventHub, targets: TargetsService) {
	register(app, hub, routes.targetsList, ({ params }) => targets.list(params.id));
	register(app, hub, routes.routing, ({ params }) => targets.routing(params.id));
	register(app, hub, routes.targetsProbe, async ({ params }, context) => ({
		operationId: await targets.mutate(params.id, params.targetId, "probe", idempotencyKey(context)),
	}));
	register(app, hub, routes.targetsUse, async ({ params }, context) => ({
		operationId: await targets.mutate(params.id, params.targetId, "use", idempotencyKey(context)),
	}));
	register(app, hub, routes.targetsRemove, async ({ params }, context) => ({
		operationId: await targets.mutate(params.id, params.targetId, "remove", idempotencyKey(context)),
	}));
}
