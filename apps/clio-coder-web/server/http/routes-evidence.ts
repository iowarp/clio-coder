import type { Hono } from "hono";
import { routes } from "../../contracts/routes.js";
import type { EventHub } from "../services/event-hub.js";
import type { EvidenceService } from "../services/evidence.js";
import { idempotencyKey, register } from "./validate.js";

export function evidenceRoutes(app: Hono, hub: EventHub, evidence: EvidenceService) {
	register(app, hub, routes.evidenceList, ({ query }) =>
		evidence.read({ kind: "list", ...query, limit: query.limit ?? 40 }, routes.evidenceList.response),
	);
	register(app, hub, routes.evidenceDetail, ({ params }) =>
		evidence.read({ kind: "detail", id: params.id }, routes.evidenceDetail.response),
	);
	register(app, hub, routes.evidenceBuild, async ({ params }, context) => ({
		operationId: await evidence.execute(params.id, params.runId, "build", idempotencyKey(context)),
	}));
	register(app, hub, routes.receiptVerify, async ({ params }, context) => ({
		operationId: await evidence.execute(params.id, params.runId, "verify", idempotencyKey(context)),
	}));
}
