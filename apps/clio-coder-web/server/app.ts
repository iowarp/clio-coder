import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { API_VERSION, APP_VERSION } from "../contracts/meta.js";
import { openapi } from "../contracts/openapi.js";
import { routes } from "../contracts/routes.js";
import { getVersionInfo } from "./clio/http-shims.js";
import { auth } from "./http/auth.js";
import { problemResponse } from "./http/problem.js";
import { sessionRoutes } from "./http/routes-sessions.js";
import { traceRoutes } from "./http/routes-traces.js";
import { events } from "./http/sse.js";
import { staticClient } from "./http/static.js";
import { idempotencyKey, register } from "./http/validate.js";
import { Commands } from "./services/commands.js";
import type { EventHub } from "./services/event-hub.js";
import type { OperationRegistry } from "./services/operations.js";
import { AppProblem } from "./services/problem.js";
import type { SessionService } from "./services/sessions.js";
import type { ToolchainService } from "./services/toolchain.js";
import type { TraceService } from "./services/traces.js";

export function createApp(options: {
	token: string;
	origin: () => string;
	hub: EventHub;
	operations: OperationRegistry;
	toolchain: ToolchainService;
	traces: TraceService;
	sessions: SessionService;
	snapshotHold?: () => Promise<void>;
	clientDir?: string;
	diagnostics?: boolean;
}) {
	const app = new Hono();
	const { hub, operations, toolchain } = options;
	app.onError(problemResponse);
	app.use("*", auth(options.token, options.origin));
	app.use(
		"/api/*",
		bodyLimit({
			maxSize: 64 * 1024,
			onError: (context) => problemResponse(new AppProblem("validation", "Request body exceeds 64 KiB."), context),
		}),
	);
	register(app, hub, routes.meta, () => ({
		clio: getVersionInfo().clio,
		app: APP_VERSION,
		apiVersion: API_VERSION as 1,
		epoch: hub.epoch,
	}));
	register(app, hub, routes.openapi, () => openapi());
	register(app, hub, routes.events, ({ query }, context) => events(context, hub, query.after));
	register(app, hub, routes.tools, async (_input, context) => {
		const result = await toolchain.list();
		if (options.diagnostics) context.header("X-Clio-Worker-Thread", String(result.threadId));
		return result.tools;
	});
	register(app, hub, routes.install, async ({ params, body }, context) => ({
		operationId: await toolchain.mutate("install", params.toolId, body, idempotencyKey(context)),
	}));
	register(app, hub, routes.remove, async ({ params }, context) => ({
		operationId: await toolchain.mutate("remove", params.toolId, {}, idempotencyKey(context)),
	}));
	register(app, hub, routes.operation, ({ params }, context) => {
		const record = operations.get(params.id);
		context.header("X-Clio-Revision", String(record.revision));
		return record;
	});
	register(app, hub, routes.cancel, ({ params }) => operations.cancel(params.id));
	traceRoutes(app, hub, options.traces);
	sessionRoutes(app, hub, options.sessions, new Commands(), options.snapshotHold);
	app.all("/api/*", (context) => {
		if (
			Object.values(routes).some((route) =>
				new RegExp(`^${route.path.replace(/:[A-Za-z0-9]+/g, "[^/]+")}$`).test(context.req.path),
			)
		)
			throw new AppProblem("unsupported", "Method is not supported for this API route.", 405);
		throw new AppProblem("not_found", "API route was not found.");
	});
	app.notFound((context) => problemResponse(new AppProblem("not_found", "Route was not found."), context));
	if (options.clientDir) staticClient(app, options.clientDir);
	return app;
}
