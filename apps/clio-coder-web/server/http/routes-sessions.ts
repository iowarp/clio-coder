import type { Hono } from "hono";
import { routes } from "../../contracts/routes.js";
import type { Commands } from "../services/commands.js";
import type { EventHub } from "../services/event-hub.js";
import type { SessionService } from "../services/sessions.js";
import { idempotencyKey, register } from "./validate.js";
export function sessionRoutes(
	app: Hono,
	hub: EventHub,
	sessions: SessionService,
	commands: Commands,
	snapshotHold?: () => Promise<void>,
) {
	const { supervisor, workspaces } = sessions;
	register(app, hub, routes.workspaces, () => workspaces.list());
	register(app, hub, routes.workspace, ({ params }) => workspaces.get(params.id));
	register(app, hub, routes.openWorkspace, ({ body }, context) =>
		commands.run("workspace.open", idempotencyKey(context), body, () => workspaces.open(body.path)),
	);
	register(app, hub, routes.sessionHistory, ({ params }) => sessions.history(params.id));
	register(app, hub, routes.newSession, ({ params }, context) =>
		commands.run(`session.new:${params.id}`, idempotencyKey(context), {}, () => supervisor.open(params.id)),
	);
	register(app, hub, routes.loadSession, ({ params, body }, context) =>
		commands.run(`session.load:${params.id}`, idempotencyKey(context), body, () =>
			sessions.load(body.workspaceId, params.id),
		),
	);
	register(app, hub, routes.sessions, () => supervisor.list());
	register(app, hub, routes.session, async ({ params }, context) => {
		const snapshot = supervisor.get(params.id);
		context.header("X-Clio-Revision", String(snapshot.revision));
		await snapshotHold?.();
		return snapshot;
	});
	register(app, hub, routes.turn, ({ params, body }, context) =>
		commands.run(`turn:${params.id}`, idempotencyKey(context), body, async () =>
			supervisor.startTurn(params.id, body.text),
		),
	);
	register(app, hub, routes.closeSession, ({ params }, context) =>
		commands.run(`session.close:${params.id}`, idempotencyKey(context), {}, () => supervisor.close(params.id)),
	);
}
