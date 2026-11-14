import { COMPOSER_NOTES, searchHelp } from "./help-reference.js";
import type { KeybindingId } from "./keybindings.js";
import { formatKeybinding, KEYBINDINGS } from "./keybindings.js";

export const HELP_VIEWS = [
	{ id: "guide", title: "Using CLIO Coder" },
	{ id: "shortcuts", title: "Shortcuts" },
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
	library: "workspace",
	focusComposer: "conversation",
	send: "conversation",
	sendNow: "conversation",
	historySearch: "conversation",
	cancelTurn: "conversation",
	modelPicker: "conversation",
	outputDetail: "conversation",
	autonomyMenu: "conversation",
	sessionPanel: "conversation",
	agents: "conversation",
	workers: "conversation",
	overview: "conversation",
	newLine: "conversation",
	mentionFile: "conversation",
	queue: "conversation",
	allowOnce: "decisions",
	reject: "decisions",
	rejectAndStop: "decisions",
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

/** One printed shortcut: a bound chord, or a message-box note the binding table cannot express. */
export interface ShortcutRow {
	readonly id: string;
	readonly action: string;
	readonly where: string;
	readonly keys: string;
}

export function helpContent(query: string, view: HelpView) {
	const searching = query.trim().length > 0;
	const matches = searchHelp(query);
	const keyboard = matches.find(({ section }) => section.id === "keyboard");
	const shortcuts = Object.entries(GROUP_TITLES).flatMap(([id, title]) => {
		const bindings: ShortcutRow[] = (Object.keys(GROUP_BY_BINDING) as KeybindingId[])
			.filter((bindingId) => GROUP_BY_BINDING[bindingId] === id)
			.map((bindingId) => KEYBINDINGS[bindingId])
			.filter((binding) => keyboard?.entries.some((entry) => entry.bindingId === binding.id))
			.map((binding) => ({
				id: binding.id,
				action: binding.action,
				where: binding.where,
				keys: formatKeybinding(binding),
			}));
		if (id === "conversation")
			for (const note of COMPOSER_NOTES)
				if (keyboard?.entries.some((entry) => entry.bindingId === undefined && entry.term === note.term))
					bindings.push({ id: `note:${note.term}`, action: note.action, where: note.where, keys: note.term });
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
