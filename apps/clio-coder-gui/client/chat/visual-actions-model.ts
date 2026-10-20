import type { IconName } from "../design/icons.js";
import type { SlashEntry } from "./slash-model.js";

export const ACTION_GROUPS = ["Conversation", "Explore this session", "More actions"] as const;
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
	context: { title: "Context window", icon: "layers" },
	usage: { title: "Usage and quota", icon: "usage" },
	tasks: { title: "Tasks and decisions", icon: "listChecks" },
	decisions: { title: "Decisions", icon: "evidence" },
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
			return {
				entry,
				title: entry.kind === "action" ? entry.title : (pane?.title ?? actionLabel(entry.name)),
				description: entry.summary,
				icon: entry.kind === "action" ? (ACTION_ICONS[entry.action] ?? "overview") : (pane?.icon ?? "bolt"),
				group: entry.kind === "action" ? "Conversation" : entry.kind === "pane" ? "Explore this session" : "More actions",
			};
		})
		.filter((item) =>
			words.every((word) => `${item.title} ${item.description} ${item.entry.name}`.toLowerCase().includes(word)),
		);
}
