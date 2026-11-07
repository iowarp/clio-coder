import type { Hono } from "hono";
import { routes } from "../../contracts/routes.js";
import type { ClientRegistry } from "../services/clients.js";
import type { EventHub } from "../services/event-hub.js";
import { requestClient } from "./auth.js";
import { register } from "./validate.js";

/** The exchange the launch token opens, the rotation a credential asks for, and the stream ticket. */
export function authRoutes(app: Hono, hub: EventHub, clients: ClientRegistry) {
	register(app, hub, routes.authClients, ({ body }) => clients.open(body.label, body.resume));
	register(app, hub, routes.authRotate, (_input, context) => clients.rotate(requestClient(context)));
	register(app, hub, routes.eventTicket, (_input, context) => clients.ticket(requestClient(context)));
}
