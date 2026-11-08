import type { Hono } from "hono";
import { routes } from "../../contracts/routes.js";
import type { EventHub } from "../services/event-hub.js";
import type { ResearchService } from "../services/research.js";
import { idempotencyKey, register } from "./validate.js";

export function researchRoutes(app: Hono, hub: EventHub, research: ResearchService) {
	register(app, hub, routes.researchCampaigns, ({ params }, context) =>
		research.list(params.id, context.req.raw.signal),
	);
	register(app, hub, routes.researchCampaign, ({ params }, context) =>
		research.status(params.id, params.campaignId, context.req.raw.signal),
	);
	register(app, hub, routes.researchReport, ({ params }, context) =>
		research.report(params.id, params.campaignId, context.req.raw.signal),
	);
	register(app, hub, routes.researchStart, async ({ params, body }, context) => ({
		operationId: await research.start(params.id, body, idempotencyKey(context)),
	}));
}
