// The session actions a dialog over the conversation hosts, and what each needs from the agent. The slash list,
// the Task actions menu and the Ctrl+K palette all offer them from this one table, so a capability the task lacks
// hides the action everywhere at once. It is apart from `slash-model.ts` because the shell's first chunk reads it.

import type { AgentCapabilities } from "../../contracts/capabilities.js";

/** Session actions hosted in a dialog over the conversation. */
export type SlashAction = "tree" | "fork" | "handoff" | "btw" | "draft" | "extensions" | "fleet-run" | "report";

export interface ActionSpec {
	readonly action: SlashAction;
	/** What follows the slash, as the terminal names it. */
	readonly name: string;
	readonly title: string;
	readonly summary: string;
	readonly supported: (capabilities: AgentCapabilities) => boolean;
}

/**
 * Catalog commands no list offers, though a typed line still runs them. `/export` and `/archive` write a file on
 * the agent's host and answer with its path, where Download transcript hands the file to the browser; `/report`'s
 * verbs are what the Report a problem dialog sends; `/eggs` is a terminal toy.
 */
export const UNLISTED_COMMANDS: ReadonlySet<string> = new Set(["archive", "eggs", "export", "report"]);

/** Names follow `src/session-control/slash-commands.ts`, so a terminal habit works here unchanged. */
export const ACTIONS: readonly ActionSpec[] = [
	{
		action: "tree",
		name: "tree",
		title: "Branches",
		summary: "Continue from an earlier turn or fork from it",
		supported: (capabilities) => !!capabilities.branches,
	},
	{
		action: "fork",
		name: "fork",
		title: "Fork the conversation",
		summary: "Start a new conversation from a turn",
		supported: (capabilities) => !!capabilities.branches?.fork,
	},
	{
		action: "handoff",
		name: "handoff",
		title: "Hand off to a new conversation",
		summary: "Draw up a reviewed handoff and continue in a new conversation",
		supported: (capabilities) => !!capabilities.handoff,
	},
	{
		action: "btw",
		name: "btw",
		title: "Side question",
		summary: "Ask beside the conversation without adding a turn",
		supported: (capabilities) => !!capabilities.aside?.ask,
	},
	{
		action: "draft",
		name: "draft",
		title: "Drafts",
		summary: "Draft a request several ways and compare them",
		supported: (capabilities) => !!capabilities.aside?.draft,
	},
	{
		action: "extensions",
		name: "extensions",
		title: "Extensions",
		summary: "What this task loaded, and reload",
		supported: (capabilities) => !!capabilities.extensions,
	},
	{
		action: "fleet-run",
		name: "fleet run",
		title: "Run a playbook",
		summary: "Preview a playbook and start the approved plan",
		supported: (capabilities) => !!capabilities.fleet,
	},
	{
		// The app's own dialog over the host's report plan, in place of the text preview other ACP clients get (R-24).
		action: "report",
		name: "report",
		title: "Report a problem",
		summary: "Review exactly what would be sent, then send it yourself",
		supported: () => true,
	},
];

/**
 * Catalog commands the Task actions menu opens straight at their form in the Actions dialog. The dialog falls back
 * to its list, searched for the name, when this task's catalog does not carry one.
 */
export const MENU_FORMS: readonly { readonly name: string; readonly title: string }[] = [
	{ name: "oracle", title: "Ask an advisor" },
	{ name: "council", title: "Ask a team" },
	{ name: "run", title: "Run an agent" },
	{ name: "loop", title: "Start a loop" },
	{ name: "skill", title: "Use a skill" },
];

/**
 * The actions a menu offers for this task: the dialogs it can serve, without the two the shell already offers
 * elsewhere (Report a problem is an app row) or that another row opens (Branches is where a fork is chosen).
 */
export function menuActions(capabilities: AgentCapabilities | undefined): readonly ActionSpec[] {
	if (!capabilities) return [];
	return ACTIONS.filter((spec) => spec.action !== "report" && spec.action !== "fork" && spec.supported(capabilities));
}
