import { searchHelp } from "./help-reference.js";
import type { KeybindingId } from "./keybindings.js";
import { KEYBINDINGS } from "./keybindings.js";

export const HELP_VIEWS = [
	{ id: "shortcuts", title: "Shortcuts" },
	{ id: "guide", title: "Using Clio" },
	{ id: "documentation", title: "Documentation" },
] as const;
export type HelpView = (typeof HELP_VIEWS)[number]["id"];

const GROUP_TITLES = {
	workspace: "Tasks & workspace",
	conversation: "Conversation",
	decisions: "Approvals & interviews",
	navigation: "Moving around",
} as const;

// Only presentation order lives here; chords, actions and scope hints come from the handler table.
const GROUP_BY_BINDING = {
	newTask: "workspace",
	openWorkspace: "workspace",
	palette: "workspace",
	help: "workspace",
	newWindow: "workspace",
	focusComposer: "conversation",
	send: "conversation",
	cancelTurn: "conversation",
	sessionPanel: "conversation",
	agents: "conversation",
	allowOnce: "decisions",
	reject: "decisions",
	interviewSubmit: "decisions",
	sidebar: "navigation",
	escape: "navigation",
	tabPrevious: "navigation",
	tabNext: "navigation",
	tabFirst: "navigation",
	tabLast: "navigation",
	listPrevious: "navigation",
	listNext: "navigation",
} as const satisfies Record<KeybindingId, keyof typeof GROUP_TITLES>;

export function helpContent(query: string, view: HelpView) {
	const searching = query.trim().length > 0;
	const matches = searchHelp(query);
	const keyboard = matches.find(({ section }) => section.id === "keyboard");
	const shortcuts = Object.entries(GROUP_TITLES).flatMap(([id, title]) => {
		const bindings = (Object.keys(GROUP_BY_BINDING) as KeybindingId[])
			.filter((bindingId) => GROUP_BY_BINDING[bindingId] === id)
			.map((bindingId) => KEYBINDINGS[bindingId])
			.filter((binding) => keyboard?.entries.some((entry) => entry.bindingId === binding.id));
		return bindings.length > 0 && (searching || view === "shortcuts") ? [{ id, title, bindings }] : [];
	});
	const sections = matches.filter(
		({ section }) =>
			section.id !== "keyboard" &&
			(searching ||
				(view === "documentation" ? section.id === "documentation" : view === "guide" && section.id !== "documentation")),
	);
	return {
		searching,
		shortcuts,
		sections,
		count:
			shortcuts.reduce((sum, group) => sum + group.bindings.length, 0) +
			sections.reduce((sum, match) => sum + match.entries.length, 0),
	};
}
