// The in-app reference: what each view is, every chord the app binds, the vocabulary the product
// insists on, and the two surfaces honestly marked as absent from this build. The keyboard section
// is generated from the binding table, so the reference cannot drift from the handlers.

import type { navigation } from "../design/navigation.js";
import { formatKeybinding, KEYBINDING_ORDER, RESERVED_KEYBINDING_NAMESPACE } from "./keybindings.js";

type NavPath = (typeof navigation)[number]["path"];

export interface HelpEntry {
	readonly term: string;
	readonly meaning: string;
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
		title: "Overview",
		meaning: "Where this installation stands right now, and the way into the work you had open.",
	},
	"/sessions": {
		title: "Sessions",
		meaning:
			"Your requests and Clio Coder's responses as readable prose, with the tools it ran folded into one activity line per stretch of work.",
	},
	"/traces": {
		title: "Traces",
		meaning:
			"The same record as the conversation, one card per protocol item, with provenance, exact keys, and the token fields.",
	},
	"/toolchain": {
		title: "Toolchain",
		meaning: "The tools Clio Coder can reach on this machine, their versions, and the trust each one carries.",
	},
	"/docs": {
		title: "Docs",
		meaning: "The project's own documentation, read from the repository and searchable without leaving the app.",
	},
	"/settings": {
		title: "Settings",
		meaning:
			"The configuration Clio Coder is actually using for this project, where each value came from, and when a change takes effect.",
	},
	"/fleet": {
		title: "Fleet",
		meaning:
			"Recent durable runs across the installation: their event spines, receipt trust, fleet lineage, gate verdicts, and evidence bundles.",
	},
	"/evidence": {
		title: "Evidence",
		meaning: "Sealed records of durable work, with the trust check that says whether the bytes still authenticate.",
	},
	"/library": {
		title: "Library",
		meaning:
			"Agents, skills, library resources, extensions, and verification checks Clio Coder can see, with their trust and scope.",
	},
	"/system": {
		title: "System",
		meaning:
			"An installation-wide, manually refreshed snapshot of Clio Coder's worker admission state and aggregate totals. It is not a project view.",
	},
};

const VIEW_ENTRIES: readonly HelpEntry[] = Object.values(VIEW_GUIDE).map((view) => ({
	term: view.title,
	meaning: view.meaning,
}));

const KEYBOARD_ENTRIES: readonly HelpEntry[] = KEYBINDING_ORDER.map((binding) => ({
	term: formatKeybinding(binding),
	meaning: `${binding.action}. ${binding.where}.`,
}));

export const HELP_SECTIONS: readonly HelpSection[] = [
	{
		id: "views",
		title: "Views",
		lede: "What each view in the navigation shows, and which ones read the whole installation rather than this project.",
		entries: VIEW_ENTRIES,
	},
	{
		id: "keyboard",
		title: "Keyboard",
		lede: "Every shortcut the app binds. Everything else is reachable with Tab, Enter, and Space.",
		entries: KEYBOARD_ENTRIES,
	},
	{
		id: "working-freedom",
		title: "Working freedom",
		lede:
			"Autonomy is the freedom Clio Coder has to act without asking. The bound session keeps the level Clio Coder says it is enforcing; the settings value reaches the next session.",
		entries: [
			{
				term: "read-only",
				meaning:
					"Read-class tools run. Write, execute, and dispatch calls are refused, and Clio Coder proposes them instead. The safety net still runs first.",
			},
			{
				term: "suggest",
				meaning: "Read-class tools run. Every write, execute, and dispatch call waits for your approval.",
			},
			{
				term: "auto-edit",
				meaning:
					"Reads, edits, and recognised commands run. Unrecognised shell commands, plan-scale dispatch, and anything that publishes outside the project wait for your approval.",
			},
			{
				term: "full-auto",
				meaning:
					"Everything runs without asking. The safety net still blocks what it always blocks and still confirms what it always confirms.",
			},
		],
	},
	{
		id: "vocabulary",
		title: "Vocabulary",
		lede: "Precise Clio Coder terms are kept where changing them would hide scope.",
		entries: [
			{ term: "Target", meaning: "The configured service or runtime Clio Coder routes a turn through." },
			{ term: "Model", meaning: "The model the target serves for that turn." },
			{ term: "Session", meaning: "One conversation Clio Coder keeps and can resume. A project may have many." },
			{ term: "Turn", meaning: "One request and everything Clio Coder did in response to it." },
			{
				term: "Evidence",
				meaning: "The tools, approvals, outcomes, and receipts that show what happened, as distinct from prose about it.",
			},
			{
				term: "Receipt",
				meaning:
					"A sealed record of a durable run. Verified means Clio Coder re-read the bytes and they still authenticate.",
			},
			{
				term: "Truncated",
				meaning:
					"Clio Coder or the app cut a list at a bound. What is shown is real; what is not shown is not claimed absent.",
			},
			{
				term: "Host-only",
				meaning:
					"A fact that stays on this machine's host process by design, such as an event payload or a command line. It is named, never quoted.",
			},
			{ term: "Reported", meaning: "Clio Coder supplied the fact; the app did not measure it." },
			{ term: "Observed", meaning: "The app saw the fact itself, on the live channel or in its own boundary." },
			{ term: "Status: queued", meaning: "Clio Coder has accepted the item and has not started it." },
			{ term: "Status: active", meaning: "The item is running right now." },
			{ term: "Status: waiting", meaning: "The item is waiting on you, usually an approval." },
			{ term: "Status: complete", meaning: "Clio Coder reported the item finished." },
			{ term: "Status: canceled", meaning: "The item was stopped before it finished. A stop is not a failure." },
			{ term: "Status: failed", meaning: "Clio Coder reported the item failed." },
			{
				term: "Status: replayed",
				meaning: "Clio Coder replayed this item from an earlier turn of the same session. It was not observed live.",
			},
		],
	},
	{
		id: "boundaries",
		title: "Boundaries",
		lede: "Three assurances the app makes on every screen.",
		entries: [
			{
				term: "Inspections are read-only",
				meaning:
					"Every inspection runs the same fixed command with no arguments from the browser and changes nothing in Clio Coder.",
			},
			{
				term: "Project work is project-scoped",
				meaning:
					"Files, sessions, and configuration are read and changed inside the project you opened, through Clio Coder. Runs, System, the recovery check, and the toolchain and agent inventories are installation-wide reads, and each says so in its header.",
			},
			{
				term: "Control is local",
				meaning: "The host listens only on this machine and every request carries a token issued at start.",
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
				meaning: "In a terminal, /help lists Clio Coder's own commands. Those commands are not part of this app.",
			},
		],
	},
	{
		id: RESERVED_KEYBINDING_NAMESPACE,
		title: "Interviews",
		lede: "Clio Coder can open a question of its own during a turn. This build does not render one.",
		entries: [],
		reserved:
			"This build of the app answers approvals only. When interviews arrive they will have their own keys, never Alt+A or Alt+R.",
	},
];

function normalise(text: string): string {
	return text.toLocaleLowerCase("en-US");
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
			const text = normalise(`${entry.term} ${entry.meaning}`);
			return words.every((word) => text.includes(word));
		});
		if (headingHit) matches.push({ section, entries: entries.length > 0 ? entries : section.entries });
		else if (entries.length > 0) matches.push({ section, entries });
	}
	return matches;
}
