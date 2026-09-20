import type { Hono } from "hono";
import { routes } from "../../contracts/routes.js";
import { type ArtifactWindow, MAX_SERVED_ARTIFACT_IDS, RUN_KINDS } from "../services/artifact-window.js";
import type { EventHub } from "../services/event-hub.js";
import type { EvidenceService } from "../services/evidence.js";
import { idempotencyKey, register } from "./validate.js";

export function evidenceRoutes(app: Hono, hub: EventHub, evidence: EvidenceService, artifacts: ArtifactWindow) {
	register(app, hub, routes.evidenceList, async ({ query }) => {
		// Serving the page and recording what it showed are one act: an id becomes
		// referenceable only because this response claimed it exists.
		const page = await evidence.read(
			// FleetPageQuery still admits 100, which no single window could hold; the
			// clamp is what makes an over-serve unreachable from HTTP.
			{ kind: "list", ...query, limit: Math.min(query.limit ?? 40, MAX_SERVED_ARTIFACT_IDS) },
			routes.evidenceList.response,
		);
		artifacts.page(
			"evidence",
			query.cursor,
			page.items.map((item) => item.overview.evidenceId),
		);
		return page;
	});
	register(app, hub, routes.evidenceDetail, ({ params }) =>
		evidence.read({ kind: "detail", id: artifacts.admit("evidence", params.id) }, routes.evidenceDetail.response),
	);
	// Admission precedes the operation so a refused reference never creates a row.
	register(app, hub, routes.evidenceBuild, async ({ params }, context) => ({
		operationId: await evidence.execute(
			params.id,
			artifacts.admitAny(RUN_KINDS, params.runId),
			"build",
			idempotencyKey(context),
		),
	}));
	register(app, hub, routes.receiptVerify, async ({ params }, context) => ({
		operationId: await evidence.execute(
			params.id,
			artifacts.admitAny(RUN_KINDS, params.runId),
			"verify",
			idempotencyKey(context),
		),
	}));
}
