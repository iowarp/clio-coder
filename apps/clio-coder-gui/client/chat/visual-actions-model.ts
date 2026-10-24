import type { IconName } from "../design/icons.js";
import type { SlashEntry } from "./slash-model.js";

export const ACTION_GROUPS = ["Conversation", "Task details", "More actions"] as const;
export type ActionGroup = (typeof ACTION_GROUPS)[number];
export interface VisualAction {
	readonly entry: SlashEntry;
	readonly title: string;
	readonly description: string;
	readonly icon: IconName;
	readonly group: ActionGroup;
}

export function actionLabel(name: string): string {
	const words = name.replace(/^--/u, "").replace(/[-_:]/gu, " ");
	return words.charAt(0).toUpperCase() + words.slice(1);
}

const PANE_COPY: Readonly<Record<string, { title: string; icon: IconName }>> = {
	context: { title: "Conversation memory", icon: "layers" },
	usage: { title: "Usage and quota", icon: "usage" },
	tasks: { title: "Tasks and decisions", icon: "listChecks" },
	decisions: { title: "Decisions", icon: "evidence" },
};
const ACTION_COPY: Readonly<Record<string, { title: string; description: string }>> = {
	tree: { title: "Conversation history", description: "Return to an earlier point or try another direction" },
	fork: { title: "Try another direction", description: "Start a separate conversation from an earlier reply" },
	handoff: {
		title: "Continue in a new task",
		description: "Review a summary and carry your work into a fresh conversation",
	},
	btw: { title: "Side question", description: "Ask a quick question without interrupting the main conversation" },
	draft: { title: "Compare approaches", description: "Explore different ways to tackle your request" },
	extensions: { title: "Tools and add-ons", description: "See the tools available to this task" },
	"fleet-run": { title: "Run a workflow", description: "Choose a saved workflow and review it before starting" },
};
const COMMAND_TITLES: Readonly<Record<string, string>> = {
	doctor: "Check Clio",
	"context compact": "Make room in conversation",
	"context reset": "Reset conversation memory",
	"context recover": "Recover conversation memory",
	council: "Ask a team",
	skill: "Use a skill",
	"tasks add": "Add a task",
	"tasks hand": "Assign a task",
	"tasks done": "Complete a task",
	"tasks drop": "Remove a task",
};
const ACTION_ICONS: Readonly<Record<string, IconName>> = {
	tree: "branch",
	fork: "branch",
	handoff: "external",
	btw: "sessions",
	draft: "compose",
	extensions: "toolchain",
	"fleet-run": "play",
};

export function visualActions(entries: readonly SlashEntry[], query: string): readonly VisualAction[] {
	const words = query.toLowerCase().trim().split(/\s+/u).filter(Boolean);
	return entries
		.map((entry): VisualAction => {
			const pane = entry.kind === "pane" ? PANE_COPY[entry.name] : undefined;
			const action = entry.kind === "action" ? ACTION_COPY[entry.action] : undefined;
			return {
				entry,
				title: action?.title ?? pane?.title ?? COMMAND_TITLES[entry.name] ?? actionLabel(entry.name),
				description: action?.description ?? entry.summary,
				icon: entry.kind === "action" ? (ACTION_ICONS[entry.action] ?? "overview") : (pane?.icon ?? "bolt"),
				group: entry.kind === "action" ? "Conversation" : entry.kind === "pane" ? "Task details" : "More actions",
			};
		})
		.filter((item) =>
			words.every((word) =>
				`${item.title} ${item.description} ${item.entry.name} ${item.entry.summary}`.toLowerCase().includes(word),
			),
		);
}

/** The file-review view is a local pane, so it is discoverable without an engine command. */
export function matchesChanges(query: string): boolean {
	return query
		.toLowerCase()
		.trim()
		.split(/\s+/u)
		.filter(Boolean)
		.every((word) => "changes files review edited touched paths".includes(word));
}

export function actionCategoryRows(
	items: readonly VisualAction[],
	category: ActionGroup | "All actions",
): readonly VisualAction[] {
	return category === "All actions" ? items : items.filter((item) => item.group === category);
}

/** A command that takes the next prompt slot must wait for the active turn to settle. */
export function actionWaitsForTurn(entry: SlashEntry, running: boolean): boolean {
	if (!running || entry.kind !== "command") return false;
	return (
		entry.command.promptTurn === true ||
		(!!entry.subcommand && entry.command.promptTurnSubcommands?.includes(entry.subcommand) === true)
	);
}
