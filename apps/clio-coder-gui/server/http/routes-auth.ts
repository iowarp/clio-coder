import type { Hono } from "hono";
import { routes } from "../../contracts/routes.js";
import type { ClientRegistry } from "../services/clients.js";
import type { EventHub } from "../services/event-hub.js";
import type { SessionControls } from "../services/session-control.js";
import { requestClient } from "./auth.js";
import { register } from "./validate.js";

/** The exchange the launch token opens, the rotation a credential asks for, the stream ticket and the sign-out. */
export function authRoutes(app: Hono, hub: EventHub, clients: ClientRegistry, controls: SessionControls) {
	register(app, hub, routes.authClients, ({ body }) => clients.open(body.label, body.resume));
	register(app, hub, routes.authRotate, (_input, context) => clients.rotate(requestClient(context)));
	register(app, hub, routes.eventTicket, (_input, context) => clients.ticket(requestClient(context)));
	register(app, hub, routes.authRevoke, (_input, context) => {
		const client = requestClient(context);
		// Released while the client is still known, so the event names it as the previous holder.
		controls.releaseAll(client.clientId);
		clients.revoke(client);
		return {};
	});
}
