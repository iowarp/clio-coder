import type { Hono } from "hono";
import type { MachineAttachment } from "../../contracts/machines.js";
import { routes } from "../../contracts/routes.js";
import type { EventHub } from "../services/event-hub.js";
import type { MachinesService } from "../services/machines.js";
import { AppProblem } from "../services/problem.js";
import { idempotencyKey, register } from "./validate.js";

/** What the attach routes need from the per-machine supervisor. */
export interface MachineAttachmentsApi {
	list(): Promise<MachineAttachment[]>;
	attach(id: string): Promise<MachineAttachment>;
}

export function machinesRoutes(
	app: Hono,
	hub: EventHub,
	machines?: MachinesService,
	attachments?: MachineAttachmentsApi,
) {
	const service = () => {
		if (!machines) throw new AppProblem("unsupported", "Machine management is not enabled on this host.");
		return machines;
	};
	const attached = () => {
		if (!attachments) throw new AppProblem("unsupported", "Machine attachment is not enabled on this host.");
		return attachments;
	};
	register(app, hub, routes.machines, ({ params }) => service().list(params.id));
	register(app, hub, routes.machineMutation, async ({ params, body }, context) => ({
		operationId: await service().mutate(params.id, body, idempotencyKey(context)),
	}));
	register(app, hub, routes.machineAttachments, async () => ({ attachments: await attached().list() }));
	register(app, hub, routes.machineAttach, ({ params }) => attached().attach(params.id));
}
