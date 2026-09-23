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
	register(app, hub, routes.permission, ({ params, body }, context) =>
		commands.run(`permission:${params.id}:${params.permissionId}`, idempotencyKey(context), body, async () =>
			supervisor.decide(params.id, params.permissionId, body.decision),
		),
	);
	register(app, hub, routes.cancelTurn, ({ params }, context) =>
		commands.run(`cancel:${params.id}:${params.turnId}`, idempotencyKey(context), {}, () =>
			supervisor.cancel(params.id, params.turnId),
		),
	);
	register(app, hub, routes.sessionCapabilities, ({ params }) => supervisor.capabilities(params.id));
	// Steering, interrupt and command invocation all mutate one live turn, so
	// each is keyed per session in the command ledger: a double-submitted steer
	// must queue once, not twice. The queue read is a plain GET.
	register(app, hub, routes.steerSession, ({ params, body }, context) =>
		commands.run(`steer:${params.id}`, idempotencyKey(context), body, () => supervisor.steer(params.id, body)),
	);
	register(app, hub, routes.sessionQueue, ({ params }) => supervisor.queue(params.id));
	register(app, hub, routes.clearSessionQueue, ({ params }, context) =>
		commands.run(`queue.clear:${params.id}`, idempotencyKey(context), {}, () => supervisor.clearQueue(params.id)),
	);
	register(app, hub, routes.interruptSession, ({ params, body }, context) =>
		commands.run(`interrupt:${params.id}`, idempotencyKey(context), body, () =>
			supervisor.interrupt(params.id, body.reason),
		),
	);
	register(app, hub, routes.steerDispatchRun, ({ params, body }, context) =>
		commands.run(`dispatch.steer:${params.id}:${body.runId}`, idempotencyKey(context), body, () =>
			supervisor.steerDispatchRun(params.id, body),
		),
	);
	register(app, hub, routes.sessionCommands, ({ params }) => supervisor.commands(params.id));
	register(app, hub, routes.invokeSessionCommand, ({ params, body }, context) =>
		commands.run(`command:${params.id}:${body.command}`, idempotencyKey(context), body, () =>
			supervisor.invokeCommand(params.id, body),
		),
	);
	register(app, hub, routes.sessionSettings, ({ params }) => supervisor.settings(params.id));
	register(app, hub, routes.patchSessionSettings, ({ params, body }, context) =>
		commands.run(`settings:${params.id}`, idempotencyKey(context), body, () => supervisor.settings(params.id, body)),
	);
	register(app, hub, routes.sessionTargets, ({ params }) => supervisor.targets(params.id));
	register(app, hub, routes.probeSessionTarget, ({ params }, context) =>
		commands.run(`probe:${params.id}:${params.targetId}`, idempotencyKey(context), {}, () =>
			supervisor.probe(params.id, params.targetId),
		),
	);
	register(app, hub, routes.sessionAutonomy, ({ params }) => supervisor.autonomy(params.id));
	register(app, hub, routes.setSessionAutonomy, ({ params, body }, context) =>
		commands.run(`autonomy:${params.id}`, idempotencyKey(context), body, () =>
			supervisor.autonomy(params.id, body.level),
		),
	);
	register(app, hub, routes.labelSession, ({ params, body }, context) =>
		commands.run(`label:${params.id}`, idempotencyKey(context), body, () =>
			sessions.ledgerCommand(params.id, "label", body.workspaceId, body.label),
		),
	);
	register(app, hub, routes.deleteSession, ({ params, body }, context) =>
		commands.run(`delete:${params.id}`, idempotencyKey(context), body, () =>
			sessions.ledgerCommand(params.id, "delete", body.workspaceId),
		),
	);
	register(app, hub, routes.workspaces, () => workspaces.list());
	register(app, hub, routes.workspaceFolders, ({ query }) => workspaces.browse(query.path, query.hidden));
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
