import type { Hono } from "hono";
import { routes } from "../../contracts/routes.js";
import type { EventHub } from "../services/event-hub.js";
import type { MachinesService } from "../services/machines.js";
import { AppProblem } from "../services/problem.js";
import { idempotencyKey, register } from "./validate.js";

export function machinesRoutes(app: Hono, hub: EventHub, machines?: MachinesService) {
	const service = () => {
		if (!machines) throw new AppProblem("unsupported", "Machine management is not enabled on this host.");
		return machines;
	};
	register(app, hub, routes.machines, ({ params }) => service().list(params.id));
	register(app, hub, routes.machineMutation, async ({ params, body }, context) => ({
		operationId: await service().mutate(params.id, body, idempotencyKey(context)),
	}));
}
