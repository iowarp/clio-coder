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
	register(app, hub, routes.sessionInterview, ({ params }) => supervisor.interview(params.id));
	register(app, hub, routes.answerInterview, ({ params, body }, context) =>
		commands.run(`interview:${params.id}:${params.roundId}`, idempotencyKey(context), body, async () =>
			supervisor.answerInterview(params.id, params.roundId, body),
		),
	);
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
	register(app, hub, routes.sessionBoard, ({ params }) => supervisor.board(params.id));
	// A retried supersede or proposal answers from the ledger; the agent also finds an already
	// superseded decision or an existing candidate rather than writing a second.
	register(app, hub, routes.supersedeDecision, ({ params, body }, context) =>
		commands.run(`decision.supersede:${params.id}`, idempotencyKey(context), body, () =>
			supervisor.supersedeDecision(params.id, body),
		),
	);
	register(app, hub, routes.proposeMemory, ({ params, body }, context) =>
		commands.run(`memory.propose:${params.id}`, idempotencyKey(context), body, () =>
			supervisor.proposeMemory(params.id, body),
		),
	);
	register(app, hub, routes.sessionTree, ({ params }) => supervisor.tree(params.id));
	// A branch change resets the conversation, so a retried request answers from
	// the command ledger instead of switching or forking a second time.
	register(app, hub, routes.switchSessionBranch, ({ params, body }, context) =>
		commands.run(`branch:${params.id}`, idempotencyKey(context), body, () =>
			supervisor.switchTurn(params.id, body.turnId),
		),
	);
	register(app, hub, routes.forkSession, ({ params, body }, context) =>
		commands.run(`fork:${params.id}`, idempotencyKey(context), body, () => supervisor.fork(params.id, body.turnId)),
	);
	register(app, hub, routes.sessionExtensions, ({ params }) => supervisor.extensions(params.id));
	register(app, hub, routes.reloadSessionExtensions, ({ params }, context) =>
		commands.run(`extensions.reload:${params.id}`, idempotencyKey(context), {}, () =>
			supervisor.reloadExtensions(params.id),
		),
	);
	register(app, hub, routes.sessionArtifacts, ({ params }) => supervisor.artifacts(params.id));
	register(app, hub, routes.sessionArtifact, ({ params, body }) => supervisor.artifact(params.id, body));
	register(app, hub, routes.sessionUsage, ({ params }) => supervisor.usage(params.id));
	// A retried side question or draft answers from the ledger instead of billing a second round.
	register(app, hub, routes.askAside, ({ params, body }, context) =>
		commands.run(`aside.ask:${params.id}`, idempotencyKey(context), body, () =>
			supervisor.askAside(params.id, body.question),
		),
	);
	register(app, hub, routes.draftAside, ({ params, body }, context) =>
		commands.run(`aside.draft:${params.id}`, idempotencyKey(context), body, () => supervisor.draftAside(params.id, body)),
	);
	register(app, hub, routes.cancelAside, ({ params }) => supervisor.cancelAside(params.id));
	register(app, hub, routes.sessionContext, ({ params }) => supervisor.contextLedger(params.id));
	register(app, hub, routes.previewFleetRun, ({ params, body }) => supervisor.fleetPreview(params.id, body));
	// A retried start answers from the ledger rather than starting the plan twice.
	register(app, hub, routes.startFleetRun, ({ params, body }, context) =>
		commands.run(`fleet.run:${params.id}`, idempotencyKey(context), body, () => supervisor.fleetRun(params.id, body)),
	);
	// A retried draft answers from the ledger rather than spending a second model round.
	register(app, hub, routes.prepareHandoff, ({ params, body }, context) =>
		commands.run(`handoff:${params.id}`, idempotencyKey(context), body, () =>
			supervisor.prepareHandoff(params.id, body.goal),
		),
	);
	register(app, hub, routes.commitHandoff, ({ params, body }, context) =>
		commands.run(`handoff.commit:${params.id}`, idempotencyKey(context), body, () =>
			supervisor.commitHandoff(params.id, body.handoffId, body.document),
		),
	);
	register(app, hub, routes.cancelHandoff, ({ params, body }, context) =>
		commands.run(`handoff.cancel:${params.id}`, idempotencyKey(context), body, () =>
			supervisor.cancelHandoff(params.id, body.handoffId),
		),
	);
	register(app, hub, routes.sessionCommands, ({ params }) => supervisor.commands(params.id));
	register(app, hub, routes.invokeSessionCommand, ({ params, body }, context) =>
		commands.run(`command:${params.id}:${body.command}`, idempotencyKey(context), body, () =>
			supervisor.invokeCommand(params.id, body),
		),
	);
	register(app, hub, routes.sessionSettings, ({ params }) => supervisor.settings(params.id));
	register(app, hub, routes.setSessionConfig, ({ params, body }, context) =>
		commands.run(`config:${params.id}`, idempotencyKey(context), body, () => supervisor.setConfig(params.id, body)),
	);
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
	// Both register before routes.workspace: "complete" and "pick" would otherwise match its :id segment.
	register(app, hub, routes.workspacePathComplete, ({ query }) => workspaces.complete(query.input, query.hidden));
	register(app, hub, routes.workspacePick, (_input, context) => workspaces.pick(context.req.raw.signal));
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
			supervisor.startTurn(params.id, body.text, body.images, body.files),
		),
	);
	register(app, hub, routes.closeSession, ({ params }, context) =>
		commands.run(`session.close:${params.id}`, idempotencyKey(context), {}, () => supervisor.close(params.id)),
	);
}
