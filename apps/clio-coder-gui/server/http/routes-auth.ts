import type { Hono } from "hono";
import { routes } from "../../contracts/routes.js";
import { answerLaunchProof, sameSecret } from "../launch-proof.js";
import type { ClientRegistry } from "../services/clients.js";
import type { EventHub } from "../services/event-hub.js";
import { AppProblem } from "../services/problem.js";
import type { SessionControls } from "../services/session-control.js";
import { requestClient } from "./auth.js";
import { register } from "./validate.js";

/** The exchange the launch token opens, the rotation a credential asks for, the stream ticket and the sign-out. */
export function authRoutes(
	app: Hono,
	hub: EventHub,
	clients: ClientRegistry,
	controls: SessionControls,
	launch: { token: string; origin: () => string },
) {
	register(app, hub, routes.authChallenge, () => clients.launchChallenge());
	register(app, hub, routes.authClients, ({ body }, context) => {
		const authorization = context.req.header("authorization");
		const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
		// The challenge is spent whatever the proof, so each one admits at most one guess. The proof is
		// checked with this listener's own port, so a proof a squatter relays from the other port is refused.
		const answer =
			!bearer &&
			body.ticket === undefined &&
			body.challenge !== undefined &&
			body.proof !== undefined &&
			clients.redeemChallenge(body.challenge)
				? answerLaunchProof(launch.token, body.challenge, body.proof, Number(new URL(launch.origin()).port))
				: null;
		const admitted = bearer
			? // The launch token as a bearer is what launchers and links from before 0.7.1 send; remove in 0.7.3.
				// A live credential is a window of this browser opening its own client, which buys nothing it lacks.
				sameSecret(launch.token, bearer) || clients.authenticate(bearer) !== null
			: body.ticket !== undefined
				? clients.redeemLaunch(body.ticket)
				: answer !== null;
		if (!admitted)
			throw new AppProblem(
				"unauthorized",
				body.ticket !== undefined ? "The launch ticket is unknown, used or expired." : "A valid launch token is required.",
			);
		const opened = clients.open(body.label, body.resume);
		return answer === null ? opened : { ...opened, serverProof: answer };
	});
	register(app, hub, routes.authLaunchTicket, () => clients.launchTicket());
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
