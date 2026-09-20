// What the command palette offers, decided here so the shell only supplies the handlers.
//
// The list is built from destinations this app actually routes to and from actions that are already
// wired end to end. It is deliberately NOT built from `GET /api/sessions/:id/commands`: that catalog
// wires 9 of about 21 optional members, so a palette composed from it would list `/archive`,
// `/export`, `/context` and `/council` rows that answer "not wired" when run. A palette whose rows
// refuse is worse than no palette, because it teaches the operator that the whole surface is a guess.
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
 * The navigable views. The first eleven mirror `client/design/navigation.tsx` exactly; the rest are
 * routed views with no navigation entry, which is precisely the set a launcher earns its place on.
 */
export const DESTINATIONS: readonly Destination[] = [
	{ label: "Overview", path: "/", keywords: ["home", "start"] },
	{ label: "Sessions", path: "/sessions", keywords: ["chat", "conversation", "workspace"] },
	{ label: "Traces", path: "/traces", keywords: ["runs", "forensics"] },
	{ label: "Toolchain", path: "/toolchain", keywords: ["tools", "install"] },
	{ label: "Docs", path: "/docs", keywords: ["documentation", "reference"] },
	{ label: "Settings", path: "/settings", keywords: ["configuration", "preferences"] },
	{ label: "Fleet", path: "/fleet", keywords: ["dispatch", "workers", "runs"] },
	{ label: "Evidence", path: "/evidence", keywords: ["receipts", "trust"] },
	{ label: "Evals", path: "/evals", keywords: ["evaluation", "reports"] },
	{ label: "Library", path: "/library", keywords: ["packages", "skills", "recipes"] },
	{ label: "System", path: "/system", keywords: ["doctor", "health", "paths"] },
	{ label: "Usage report", path: "/usage", keywords: ["tokens", "cost", "spend"] },
	{ label: "Targets", path: "/settings/targets", keywords: ["providers", "models"] },
	{ label: "Routing", path: "/settings/routing", keywords: ["profiles", "bindings", "offline"] },
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
}

export interface CommandHandlers {
	navigate(path: string): void;
	openHelp(): void;
	dismissNotices(): void;
	cancelTurn(turnId: string): void;
	closeSession(): void;
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
		keywords: ["help", "shortcuts", "keys", "glossary"],
		binding: "help",
		available: true,
		run: handlers.openHelp,
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
