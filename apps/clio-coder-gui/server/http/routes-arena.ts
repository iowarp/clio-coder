import type { Hono } from "hono";
import { routes } from "../../contracts/routes.js";
import type { ArenaService } from "../services/arena.js";
import type { EventHub } from "../services/event-hub.js";
import { idempotencyKey, register } from "./validate.js";

export function arenaRoutes(app: Hono, hub: EventHub, arena: ArenaService) {
	register(app, hub, routes.arenaMatches, ({ params }, context) => arena.list(params.id, context.req.raw.signal));
	register(app, hub, routes.arenaMatch, ({ params }, context) =>
		arena.show(params.id, params.matchId, context.req.raw.signal),
	);
	register(app, hub, routes.arenaStandings, ({ params, query }, context) =>
		arena.standings(params.id, query.suite, context.req.raw.signal),
	);
	register(app, hub, routes.arenaStart, async ({ params, body }, context) => ({
		operationId: await arena.start(params.id, body, idempotencyKey(context)),
	}));
	register(app, hub, routes.arenaVote, ({ params, body }) => arena.vote(params.id, params.matchId, body));
}
