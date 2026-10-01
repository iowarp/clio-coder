// What the command palette offers, decided here so the shell only supplies the handlers.
//
// The list is built from destinations this app actually routes to and from actions that are already
// wired end to end. It is deliberately NOT built from `GET /api/sessions/:id/commands`: that catalog
// belongs to one session and needs that session's arguments, which the conversation's command panel
// collects. A palette row has neither, and a row that refuses teaches the operator that the whole
// surface is a guess.
//
// Every row here is therefore either a route this client renders or a mutation this client already
// sends from a visible button. A row that cannot run right now is marked unavailable and the palette
// hides it, rather than showing it greyed and inviting the question of why.

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
	{ label: "Settings", path: "/settings", keywords: ["configuration", "preferences"] },
	{ label: "General settings", path: "/settings/general", keywords: ["theme", "appearance", "install", "app"] },
	{ label: "Fleet", path: "/fleet", keywords: ["dispatch", "workers", "runs"] },
	{ label: "Evidence", path: "/evidence", keywords: ["receipts", "trust"] },
	{ label: "Library", path: "/library", keywords: ["packages", "skills", "recipes"] },
	{ label: "System", path: "/system", keywords: ["doctor", "health", "paths"] },
	{ label: "Usage report", path: "/usage", keywords: ["tokens", "cost", "spend"] },
	{ label: "Targets", path: "/settings/targets", keywords: ["providers", "models"] },
	{ label: "Routing", path: "/settings/routing", keywords: ["profiles", "bindings", "offline"] },
	{ label: "Effective settings", path: "/settings/effective", keywords: ["values", "layers", "origin"] },
	{ label: "Why these settings", path: "/settings/why", keywords: ["provenance", "source"] },
	{ label: "Interop", path: "/system/interop", keywords: ["agents", "mcp", "external"] },
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
	}
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
