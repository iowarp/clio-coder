import type { Hono } from "hono";
import { routes } from "../../contracts/routes.js";
import type { EventHub } from "../services/event-hub.js";
import type { ProjectReviewService } from "../services/project-review.js";
import { register } from "./validate.js";

/** Project trust and pending memory lessons, each read and decided through the CLI the terminal uses. */
export function reviewRoutes(app: Hono, hub: EventHub, review: ProjectReviewService) {
	register(app, hub, routes.trustPreview, ({ params }) => review.trustPreview(params.id, params.surface));
	register(app, hub, routes.trustApprove, ({ params, body }) =>
		review.trustApprove(params.id, params.surface, body.hash),
	);
	register(app, hub, routes.memoryPending, ({ params }) => review.memoryPending(params.id));
	register(app, hub, routes.memoryDecide, ({ params, body }) =>
		review.memoryDecide(params.id, params.memoryId, body.decision),
	);
}
