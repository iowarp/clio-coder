// The in-app reference: what each view is, every chord the app binds, the vocabulary the product
// insists on, and capability-dependent surfaces. The keyboard section
// is generated from the binding table, so the reference cannot drift from the handlers.

import type { navigation } from "../design/navigation.js";
import { formatKeybinding, INTERVIEW_KEYBINDING_NAMESPACE, KEYBINDING_ORDER } from "./keybindings.js";

// The task screens are the rail's own and are not in the navigation table, but the reference still explains them.
type NavPath = (typeof navigation)[number]["path"] | "/" | "/sessions";

export interface HelpEntry {
	readonly term: string;
	readonly meaning: string;
	readonly bindingId?: string;
}

export interface HelpSection {
	readonly id: string;
	readonly title: string;
	readonly lede: string;
	readonly entries: readonly HelpEntry[];
	/** Set when the section is reserved for a surface this build does not have. */
	readonly reserved?: string;
}

export interface HelpMatch {
	readonly section: HelpSection;
	readonly entries: readonly HelpEntry[];
}

/** One sentence per route. A route added without a guide entry fails to compile. */
export const VIEW_GUIDE: Readonly<Record<NavPath, { title: string; meaning: string }>> = {
	"/": {
		title: "New task",
		meaning: "Choose a workspace and describe a task. Clio starts when you send your first message.",
	},
	"/sessions": {
		title: "Tasks",
		meaning:
			"Your conversations, grouped by workspace. Open a task to read messages, inspect tool activity, and see progress, changes, files and commands.",
	},
	"/traces": {
		title: "Traces",
		meaning: "The detailed conversation record, including individual events, their sources and token counts.",
	},
	"/toolchain": {
		title: "Toolchain",
		meaning: "Tools available on this machine, their versions and trust status.",
	},
	"/settings": {
		title: "Settings",
		meaning: "Current project settings, where each value comes from and when changes take effect.",
	},
	"/fleet": {
		title: "Fleet",
		meaning: "Saved runs across this installation, including events, related workers, check results and evidence.",
	},
	"/evidence": {
		title: "Evidence",
		meaning: "Sealed work records and checks that verify they have not changed.",
	},
	"/library": {
		title: "Library",
		meaning: "Available agents, skills, resources, extensions and checks, with their trust and scope.",
	},
	"/system": {
		title: "System",
		meaning: "A snapshot of worker capacity and totals across the installation. Refresh it manually for an update.",
	},
};

const VIEW_ENTRIES: readonly HelpEntry[] = Object.values(VIEW_GUIDE).map((view) => ({
	term: view.title,
	meaning: view.meaning,
}));

const KEYBOARD_ENTRIES: readonly HelpEntry[] = KEYBINDING_ORDER.map((binding) => ({
	bindingId: binding.id,
	term: formatKeybinding(binding),
	meaning: `${binding.action}. ${binding.where}.`,
}));

export const HELP_SECTIONS: readonly HelpSection[] = [
	{
		id: "documentation",
		title: "Documentation",
		lede: "Guides online and an offline reference included with your installation.",
		entries: [
			{ term: "Public documentation", meaning: "Read the Clio Coder guides on the web." },
			{
				term: "Installed reference",
				meaning:
					"The bundled Markdown docs are available offline. Ask Clio to look up a guide with clio_docs, or open the files in your editor.",
			},
		],
	},
	{
		id: "views",
		title: "Views",
		lede: "Find your way around the app.",
		entries: VIEW_ENTRIES,
	},
	{
		id: "keyboard",
		title: "Keyboard",
		lede: "App shortcuts. Use Tab to move between controls, then Enter or Space to activate them.",
		entries: KEYBOARD_ENTRIES,
	},
	{
		id: "working-freedom",
		title: "Autonomy",
		lede:
			"Autonomy controls when Clio asks before acting. The current session keeps its reported level; a settings change applies to the next session.",
		entries: [
			{
				term: "default",
				meaning:
					"Clio can read, edit and run recognised commands. Unrecognised shell commands, dispatching a full plan and publishing outside the project require approval.",
			},
			{
				term: "yolo",
				meaning:
					"Clio skips ordinary approval prompts. Safety rules can still ask or block an action, and protected paths remain protected.",
			},
		],
	},
	{
		id: "vocabulary",
		title: "Vocabulary",
		lede: "Words you may see while working.",
		entries: [
			{ term: "Target", meaning: "A configured service or runtime that handles a turn." },
			{ term: "Model", meaning: "The AI model a target uses for that turn." },
			{ term: "Session", meaning: "A saved conversation you can resume. A project can have many sessions." },
			{ term: "Turn", meaning: "One request and everything Clio does in response." },
			{
				term: "Evidence",
				meaning: "Tool activity, approvals, results and receipts that record what happened.",
			},
			{
				term: "Receipt",
				meaning: "A sealed record of a saved run. Verified means Clio checked the record and it still authenticates.",
			},
			{
				term: "Truncated",
				meaning: "Only part of a list is shown. More items may exist beyond the display limit.",
			},
			{
				term: "Host-only",
				meaning:
					"Data kept in the local host process, such as an event payload or command line. The app names it without displaying its contents.",
			},
			{ term: "Reported", meaning: "Supplied by Clio, rather than measured by the app." },
			{ term: "Observed", meaning: "Seen directly by the app." },
			{ term: "Status: queued", meaning: "Accepted, but not started." },
			{ term: "Status: active", meaning: "Running now." },
			{ term: "Status: waiting", meaning: "Waiting for you, usually for approval." },
			{ term: "Status: complete", meaning: "Clio reported that the work finished." },
			{ term: "Status: canceled", meaning: "Stopped before finishing. This does not mean the work failed." },
			{ term: "Status: failed", meaning: "Clio reported that the work failed." },
			{
				term: "Status: replayed",
				meaning: "Restored from an earlier turn in this session, rather than observed live.",
			},
		],
	},
	{
		id: "boundaries",
		title: "Boundaries",
		lede: "What the app reads and controls.",
		entries: [
			{
				term: "Inspections are read-only",
				meaning: "Inspections use fixed commands, accept no browser-supplied arguments and do not change Clio.",
			},
			{
				term: "Project work is project-scoped",
				meaning:
					"Files, sessions and configuration belong to the open project. Runs, System, recovery checks, and tool and agent inventories read across the installation; their headers identify that scope.",
			},
			{
				term: "Control is local",
				meaning: "The host listens only on this machine. Requests use an access token issued when it starts.",
			},
		],
	},
	{
		id: "terminal",
		title: "The terminal",
		lede: "This reference covers the app.",
		entries: [
			{
				term: "/help",
				meaning: "In the terminal, /help lists Clio Coder commands. The app has its own controls and shortcuts.",
			},
		],
	},
	{
		id: INTERVIEW_KEYBINDING_NAMESPACE,
		title: "Interviews",
		lede:
			"Clio may ask a round of questions during a turn when the connected runtime supports interviews. Answering an interview is separate from approving an action.",
		entries: [
			{
				term: "Review, then submit",
				meaning:
					"Choose or write each answer, review the round, then submit. Nothing is selected for you. The submit shortcut works only on the review screen.",
			},
			{
				term: "Cancel interview",
				meaning: "Canceling sends no answers and does not approve an action.",
			},
		],
	},
];

function normalise(text: string): string {
	return text
		.toLocaleLowerCase("en-US")
		.replace(/ctrl\/cmd/gu, "ctrl or cmd")
		.replace(/⌘|\bcommand\b/gu, "cmd")
		.replace(/⌃|\bcontrol\b/gu, "ctrl")
		.replace(/\bescape\b/gu, "esc")
		.replace(/[+]/gu, " ");
}

/**
 * Sections whose title, lede, or any entry contains every word of the query. A heading hit widens to
 * the whole section; an entry hit narrows to the matching entries; no match returns an empty array
 * the surface must report as such rather than silently showing everything.
 */
export function searchHelp(query: string): readonly HelpMatch[] {
	const words = normalise(query)
		.split(/\s+/u)
		.filter((word) => word.length > 0);
	if (words.length === 0) return HELP_SECTIONS.map((section) => ({ section, entries: section.entries }));
	const matches: HelpMatch[] = [];
	for (const section of HELP_SECTIONS) {
		const heading = normalise(`${section.title} ${section.lede} ${section.reserved ?? ""}`);
		const headingHit = words.every((word) => heading.includes(word));
		const entries = section.entries.filter((entry) => {
			const text = normalise(`${section.title} ${entry.term} ${entry.meaning}`);
			// A single key is a whole token: K must not match every entry via “Keyboard”.
			const tokens = text.split(/\s+/u);
			return words.every((word) => (word.length === 1 ? tokens.includes(word) : text.includes(word)));
		});
		if (headingHit) matches.push({ section, entries: entries.length > 0 ? entries : section.entries });
		else if (entries.length > 0) matches.push({ section, entries });
	}
	return matches;
}
