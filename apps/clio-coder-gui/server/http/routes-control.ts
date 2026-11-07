import type { Hono, MiddlewareHandler } from "hono";
import { routes } from "../../contracts/routes.js";
import type { EventHub } from "../services/event-hub.js";
import type { SessionControls } from "../services/session-control.js";
import { requestClient } from "./auth.js";
import { problemResponse } from "./problem.js";
import { register } from "./validate.js";

const sessionPath = /^\/api\/sessions\/([^/]+)(?:\/(.*))?$/;
/**
 * Requests a viewer may still make. A sighting, an artifact page, a fleet preview and a target probe
 * read without changing the session; load and control settle control themselves.
 */
const viewerPaths = [
	/^view$/,
	/^artifacts\/read$/,
	/^fleet\/preview$/,
	/^targets\/[^/]+\/probe$/,
	/^load$/,
	/^control$/,
];

/** Every other request that would change a session needs its controller, or no present one. */
export function controlGuard(controls: SessionControls): MiddlewareHandler {
	return async (context, next) => {
		const method = context.req.method;
		if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
		const match = sessionPath.exec(context.req.path);
		const sessionId = match?.[1];
		if (!sessionId || sessionId === "overview") return next();
		const rest = match?.[2] ?? "";
		if (viewerPaths.some((path) => path.test(rest))) return next();
		try {
			controls.admit(decodeURIComponent(sessionId), requestClient(context).clientId);
		} catch (error) {
			return problemResponse(error, context);
		}
		return next();
	};
}

/** `live` throws not_found for a session this server does not hold, so no id from a path is held blindly. */
export function controlRoutes(app: Hono, hub: EventHub, controls: SessionControls, live: (id: string) => unknown) {
	register(app, hub, routes.sessionControl, ({ params }, context) => {
		live(params.id);
		return controls.view(params.id, requestClient(context).clientId);
	});
	register(app, hub, routes.takeSessionControl, ({ params }, context) => {
		live(params.id);
		return controls.take(params.id, requestClient(context).clientId);
	});
}
