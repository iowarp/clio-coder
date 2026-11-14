// What the command palette offers, decided here so the shell only supplies the handlers.
//
// The list is built from destinations this app actually routes to and from actions that are already
// wired end to end. The open task's own commands come in as data (`situation.catalog`, the catalog the
// task announced) and run through the composer, the same path a typed `/name` takes; a command that
// needs arguments is not run from here but put in the composer for the operator to finish.
//
// Every row here is therefore either a route this client renders or a mutation this client already
// sends from a visible button. A row that cannot run right now is marked unavailable and the palette
// hides it, rather than showing it greyed and inviting the question of why.

import type { AgentCapabilities } from "../../contracts/capabilities.js";
import type { SessionSnapshot } from "../../contracts/sessions.js";
import type { CommandCatalog } from "../../contracts/steering.js";
import { menuActions, type SlashAction } from "../chat/slash-actions.js";
import type { SessionControlTarget } from "../pages/session-control-model.js";
import { taskTitle } from "../shell/shell-model.js";
import type { KeybindingId } from "./keybindings.js";

/**
 * Structurally the palette's `Command`. It is redeclared here rather than imported because
 * `CommandPalette.tsx` pulls in a stylesheet, and this module has to stay loadable by node:test.
 * `app.tsx` passes this array straight to the palette, so any divergence is a typecheck failure
 * there rather than a surprise at runtime.
 */
export interface Command {
	readonly id: string;
	readonly title: string;
	readonly group: string;
	readonly keywords?: readonly string[];
	readonly binding?: KeybindingId;
	/** False hides the row entirely; a command that cannot run is never shown greyed. */
	readonly available: boolean;
	run(): void;
}

export interface Destination {
	readonly label: string;
	readonly path: string;
	/** Extra words the matcher searches but does not print. */
	readonly keywords?: readonly string[];
}

/**
 * The navigable views. Primary destinations mirror `client/design/navigation.tsx`; the rest are
 * routed views with no navigation entry, which is precisely the set a launcher earns its place on.
 */
export const DESTINATIONS: readonly Destination[] = [
	{ label: "Traces", path: "/traces", keywords: ["runs", "forensics"] },
	{ label: "Toolchain", path: "/toolchain", keywords: ["tools", "install"] },
	{ label: "Sessions", path: "/sessions", keywords: ["tasks", "conversations", "history", "resume"] },
	{ label: "Machines", path: "/machines", keywords: ["hosts", "remote", "servers", "attach"] },
	{ label: "Settings", path: "/settings", keywords: ["configuration", "preferences"] },
	{ label: "General settings", path: "/settings/general", keywords: ["theme", "appearance", "install", "app"] },
	{ label: "Model settings", path: "/settings/models", keywords: ["model", "default", "thinking", "connection"] },
	{
		label: "Safety settings",
		path: "/settings/safety",
		keywords: ["approval", "permissions", "limits", "autonomy", "spending"],
	},
	{ label: "Context and memory settings", path: "/settings/context", keywords: ["compaction", "memory", "window"] },
	{ label: "All settings", path: "/settings/advanced", keywords: ["advanced", "registry", "search", "everything"] },
	{ label: "Fleet", path: "/fleet", keywords: ["dispatch", "workers", "runs"] },
	{ label: "Evidence", path: "/evidence", keywords: ["records", "trust"] },
	{ label: "Arena", path: "/arena", keywords: ["compare", "models", "vote", "bench"] },
	{ label: "Research", path: "/research", keywords: ["hill", "climb", "optimize", "metric", "campaign", "ratchet"] },
	{ label: "Skills", path: "/skills", keywords: ["instructions", "components", "capabilities"] },
	{ label: "Library", path: "/library", keywords: ["packages", "skills", "components", "agents", "extensions"] },
	{ label: "System", path: "/system", keywords: ["doctor", "health", "paths"] },
	{ label: "Usage", path: "/usage", keywords: ["tokens", "cost", "spend", "report"] },
	{ label: "Targets", path: "/settings/targets", keywords: ["providers", "models"] },
	{ label: "Routing", path: "/settings/routing", keywords: ["profiles", "bindings", "offline"] },
	{ label: "Effective settings", path: "/settings/effective", keywords: ["values", "layers", "origin"] },
	{ label: "Why these settings", path: "/settings/why", keywords: ["provenance", "source"] },
	{ label: "Other coding agents", path: "/system/interop", keywords: ["interop", "agents", "mcp", "external"] },
];

export interface CommandSituation {
	/** The session the operator is looking at, or null when they are not in a conversation. */
	readonly sessionId: string | null;
	/** The turn running in that session right now, or null when none is. */
	readonly runningTurnId: string | null;
	/** False once the session is closed, which is when its actions stop being offerable. */
	readonly sessionOpen: boolean;
	/** True while at least one notice is on screen. */
	readonly hasNotices: boolean;
	/** Tasks the palette can jump to: open ones and the saved ones this shell already loaded. */
	readonly tasks?: readonly PaletteTask[];
	/** The command catalog the open task announced, once the palette has read it. */
	readonly catalog?: CommandCatalog | undefined;
	/** What the open task's agent announced it can do, which decides the session dialogs offered. */
	readonly capabilities?: AgentCapabilities | undefined;
}

export interface PaletteTask {
	readonly id: string;
	readonly title: string;
	/** The project it belongs to, searched but printed small. */
	readonly project: string;
	readonly open: boolean;
}

/** The palette stays a launcher, not a list of everything ever saved. */
export const PALETTE_TASK_LIMIT = 40;

export interface CommandHandlers {
	navigate(path: string): void;
	openHelp(): void;
	toggleSidebar(): void;
	dismissNotices(): void;
	cancelTurn(turnId: string): void;
	closeSession(): void;
	/** Offered only by a shell that has a project to start in. */
	newTask?(): void;
	openWorkspace?(): void;
	openTask?(id: string): void;
	/** Show the task on screen in a second window. */
	openWindow?(): void;
	/** The report dialog (R-24). */
	openReport?(): void;
	/** Run one of the open task's commands that needs no arguments; `name` is what follows the slash. */
	runTaskCommand?(name: string): void;
	/** Put `/name ` in the open task's composer for the operator to finish. */
	fillTaskCommand?(name: string): void;
	/** Open one of the open task's session dialogs: Branches, Side question, Drafts and the rest. */
	openSessionAction?(action: SlashAction): void;
}

/**
 * What a stop control stops, read from the snapshot at the moment it is pressed. A turn id captured
 * earlier can name a turn that already settled, and the server answers a stop for a settled turn with
 * success while the turn now running carries on; this reads the turn that is running now or nothing.
 */
export function liveStopTarget(sessionId: string, snapshot: SessionSnapshot | undefined): SessionControlTarget | null {
	const last = snapshot?.turns.at(-1);
	if (snapshot?.state !== "open" || last?.status !== "running") return null;
	return { id: sessionId, workspaceId: snapshot.workspaceId, title: taskTitle(snapshot), currentTurnId: last.id };
}

interface TaskCommand {
	readonly name: string;
	readonly summary: string;
	readonly needsArgs: boolean;
}

/** The catalog flattened the way the slash list shows it: each runnable name with its own summary. */
function taskCommands(catalog: CommandCatalog): readonly TaskCommand[] {
	const rows: TaskCommand[] = [];
	const required = (args: { readonly positionals?: readonly { readonly required: boolean }[] } | undefined) =>
		(args?.positionals ?? []).some((positional) => positional.required);
	for (const command of catalog.commands) {
		// A hub command's bare form is refused, so only its verbs are rows.
		if (!command.requiresSubcommand)
			rows.push({ name: command.name, summary: command.summary, needsArgs: required(command.args) });
		for (const [subcommand, args] of Object.entries(command.args.subcommands ?? {}))
			rows.push({
				name: `${command.name} ${subcommand}`,
				summary: command.subcommandSummaries?.[subcommand] ?? command.summary,
				needsArgs: required(args),
			});
	}
	return rows;
}

export const NO_SITUATION: CommandSituation = {
	sessionId: null,
	runningTurnId: null,
	sessionOpen: false,
	hasNotices: false,
};

/**
 * The palette's rows, in the order a launcher should rank ties: the conversation the operator is in,
 * then the views, then the app itself.
 */
export function appCommands(situation: CommandSituation, handlers: CommandHandlers): readonly Command[] {
	const commands: Command[] = [];
	const { runningTurnId, sessionId, sessionOpen } = situation;
	const { newTask, openWorkspace, openTask } = handlers;
	if (newTask)
		commands.push({
			id: "task.new",
			title: "New task",
			group: "Task",
			keywords: ["start", "conversation", "chat", "session", "compose"],
			binding: "newTask",
			available: true,
			run: newTask,
		});
	if (openWorkspace)
		commands.push({
			id: "workspace.open",
			title: "Open workspace",
			group: "Task",
			keywords: ["project", "folder", "directory", "add"],
			binding: "openWorkspace",
			available: true,
			run: openWorkspace,
		});
	if (openTask)
		for (const task of (situation.tasks ?? []).slice(0, PALETTE_TASK_LIMIT))
			commands.push({
				id: `task.${task.id}`,
				title: task.title,
				group: task.project,
				keywords: [task.project, task.open ? "open" : "saved", "task", "conversation"],
				available: task.id !== sessionId,
				run: () => openTask(task.id),
			});
	if (sessionId !== null && handlers.openWindow)
		commands.push({
			id: "session.window",
			title: "Open this task in a new window",
			group: "Session",
			keywords: ["second", "another", "split", "side"],
			binding: "newWindow",
			available: true,
			run: handlers.openWindow,
		});
	if (sessionId !== null) {
		commands.push({
			id: "session.cancel",
			title: "Stop the running turn",
			group: "Session",
			keywords: ["cancel", "interrupt", "halt"],
			binding: "cancelTurn",
			available: runningTurnId !== null,
			run: () => {
				if (runningTurnId !== null) handlers.cancelTurn(runningTurnId);
			},
		});
		commands.push({
			id: "session.close",
			title: "Close this session",
			group: "Session",
			keywords: ["end", "finish"],
			// Closing mid-turn would race the turn's own completion, so it is offered only at rest.
			available: sessionOpen && runningTurnId === null,
			run: handlers.closeSession,
		});
		// The task page reads these from the URL: the dialog says when the engine offers no snapshots.
		commands.push({
			id: "session.rewind",
			title: "Restore files from a snapshot",
			group: "Session",
			keywords: ["rewind", "undo", "snapshot", "revert"],
			available: sessionOpen,
			run: () => handlers.navigate(`/sessions/${sessionId}?rewind=1`),
		});
		for (const [format, name] of [
			["html", "HTML"],
			["markdown", "Markdown"],
		] as const)
			commands.push({
				id: `session.download.${format}`,
				title: `Download transcript as ${name}`,
				group: "Session",
				keywords: ["export", "save", "transcript", format],
				available: sessionOpen,
				run: () => handlers.navigate(`/sessions/${sessionId}?download=${format}`),
			});
	}
	const { openSessionAction } = handlers;
	if (sessionId !== null && sessionOpen && openSessionAction)
		for (const spec of menuActions(situation.capabilities))
			commands.push({
				id: `session.action.${spec.action}`,
				title: `${spec.title}…`,
				group: "Session",
				keywords: [spec.name, ...spec.summary.toLowerCase().split(" ")],
				available: true,
				run: () => openSessionAction(spec.action),
			});
	const { runTaskCommand, fillTaskCommand } = handlers;
	if (sessionId !== null && sessionOpen && situation.catalog && runTaskCommand && fillTaskCommand)
		for (const row of taskCommands(situation.catalog))
			commands.push({
				id: `task-command.${row.name}`,
				// A row that will ask for more says so, the way a menu item that opens a dialog does.
				title: row.needsArgs ? `${row.summary}…` : row.summary,
				group: "This task",
				keywords: [row.name, ...row.name.split(" "), "command"],
				available: true,
				run: () => (row.needsArgs ? fillTaskCommand(row.name) : runTaskCommand(row.name)),
			});
	for (const destination of DESTINATIONS)
		commands.push({
			id: `go.${destination.path}`,
			title: destination.label,
			group: "Go to",
			keywords: destination.keywords ?? [],
			available: true,
			run: () => handlers.navigate(destination.path),
		});
	commands.push({
		id: "app.help",
		title: "Keyboard and vocabulary reference",
		group: "App",
		keywords: ["help", "documentation", "docs", "shortcuts", "keys", "glossary"],
		binding: "help",
		available: true,
		run: handlers.openHelp,
	});
	if (handlers.openReport)
		commands.push({
			id: "app.report",
			title: "Report a problem",
			group: "App",
			keywords: ["report", "bug", "issue", "problem", "feedback"],
			available: true,
			run: handlers.openReport,
		});
	commands.push({
		id: "app.sidebar",
		title: "Collapse or expand the sidebar",
		group: "App",
		keywords: ["navigation", "rail", "menu", "hide", "show"],
		binding: "sidebar",
		available: true,
		run: handlers.toggleSidebar,
	});
	commands.push({
		id: "app.dismiss-notices",
		title: "Dismiss all notifications",
		group: "App",
		keywords: ["clear", "toasts", "errors"],
		available: situation.hasNotices,
		run: handlers.dismissNotices,
	});
	return commands;
}
