import type { Hono } from "hono";
import { routes } from "../../contracts/routes.js";
import type { EventHub } from "../services/event-hub.js";
import type { SetupService } from "../services/setup.js";
import type { TargetsService } from "../services/targets-cli.js";
import { idempotencyKey, register } from "./validate.js";

export function targetsRoutes(app: Hono, hub: EventHub, targets: TargetsService, setup: SetupService) {
	register(app, hub, routes.setupStatus, () => setup.status());
	register(app, hub, routes.setupStart, ({ body }, context) => setup.start(body, idempotencyKey(context)));
	register(app, hub, routes.setupState, ({ params }) => setup.snapshot(params.id));
	register(app, hub, routes.setupAnswer, ({ params, body }, context) =>
		setup.answer(params.id, body, idempotencyKey(context)),
	);
	register(app, hub, routes.setupCancel, ({ params }) => setup.cancel(params.id));
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
