/**
 * The desktop app's own reference: its views, its keyboard, and the words it
 * uses. Nothing here comes from the backend, and nothing here may drift from
 * the handlers: every keybinding is declared once in `KEYBINDINGS`, and the
 * handlers in `App.tsx` match against these entries rather than literals.
 *
 * This is the desktop app's reference. In a terminal, `/help` lists the
 * commands of Clio Coder itself, which is a different document.
 */

import { AUTONOMY_LEVELS } from "./protocol.ts";
import type { WireAutonomyLevel, WireTimelineItem } from "./protocol.ts";
import type { WorkspaceView } from "./App.tsx";

export type KeyModifier = "primary" | "alt" | "shift";

export interface Keybinding {
	readonly id: string;
	/** `KeyboardEvent.key`, compared case-insensitively for single characters. */
	readonly key: string;
	/** `primary` is Ctrl on Linux and Windows and Cmd on macOS. */
	readonly modifiers: readonly KeyModifier[];
	readonly action: string;
	readonly where: string;
}

export const KEYBINDINGS = {
	send: {
		id: "send",
		key: "Enter",
		modifiers: ["primary"],
		action: "Send the request in the composer",
		where: "While the composer has focus",
	},
	allowOnce: {
		id: "allowOnce",
		key: "a",
		modifiers: ["alt"],
		action: "Allow the pending approval once",
		where: "Anywhere, while an approval is waiting and no dialog is open",
	},
	reject: {
		id: "reject",
		key: "r",
		modifiers: ["alt"],
		action: "Reject the pending approval",
		where: "Anywhere, while an approval is waiting and no dialog is open",
	},
	escape: {
		id: "escape",
		key: "Escape",
		modifiers: [],
		action: "Close the open dialog or drawer",
		where: "While a dialog or a drawer is open",
	},
	catalogPreviousTab: {
		id: "catalogPreviousTab",
		key: "ArrowLeft",
		modifiers: [],
		action: "Move to the previous Catalog tab",
		where: "While a Catalog tab has focus",
	},
	catalogNextTab: {
		id: "catalogNextTab",
		key: "ArrowRight",
		modifiers: [],
		action: "Move to the next Catalog tab",
		where: "While a Catalog tab has focus",
	},
	catalogFirstTab: {
		id: "catalogFirstTab",
		key: "Home",
		modifiers: [],
		action: "Move to the first Catalog tab",
		where: "While a Catalog tab has focus",
	},
	catalogLastTab: {
		id: "catalogLastTab",
		key: "End",
		modifiers: [],
		action: "Move to the last Catalog tab",
		where: "While a Catalog tab has focus",
	},
} as const satisfies Readonly<Record<string, Keybinding>>;

export type KeybindingId = keyof typeof KEYBINDINGS;

/** Every declared keybinding, in the order the reference lists them. */
export const KEYBINDING_ORDER: readonly Keybinding[] = Object.values(KEYBINDINGS);

/**
 * Reserved: an interview Clio Coder opens through `ask_user` is a different
 * exchange from an intra-turn approval, and its answers must never share
 * Alt+A or Alt+R. Nothing binds these yet; the entry exists so the reference
 * and the surface land together.
 */
export const RESERVED_KEYBINDING_NAMESPACE = "interview" as const;

/** The subset of a keyboard event the matcher reads; React and DOM events both satisfy it. */
export interface KeyEventLike {
	readonly key: string;
	readonly altKey: boolean;
	readonly ctrlKey: boolean;
	readonly metaKey: boolean;
	readonly shiftKey: boolean;
}

function sameKey(binding: Keybinding, key: string): boolean {
	if (binding.key.length === 1 && key.length === 1) {
		return binding.key.toLowerCase() === key.toLowerCase();
	}
	return binding.key === key;
}

/**
 * True when the event is exactly this binding: the key, every listed modifier
 * held, and no unlisted modifier held. `primary` accepts Ctrl or Cmd and
 * rejects the other one only if it is also listed, which it never is.
 */
export function matchesKeybinding(binding: Keybinding, event: KeyEventLike): boolean {
	if (!sameKey(binding, event.key)) return false;
	const wantsPrimary = binding.modifiers.includes("primary");
	const wantsAlt = binding.modifiers.includes("alt");
	const wantsShift = binding.modifiers.includes("shift");
	const hasPrimary = event.ctrlKey || event.metaKey;
	if (wantsPrimary !== hasPrimary) return false;
	if (wantsAlt !== event.altKey) return false;
	if (wantsShift !== event.shiftKey) return false;
	return true;
}

const MODIFIER_LABELS: Readonly<Record<KeyModifier, string>> = {
	primary: "Ctrl or Cmd",
	alt: "Alt",
	shift: "Shift",
};

const KEY_LABELS: Readonly<Record<string, string>> = {
	Enter: "Enter",
	Escape: "Esc",
	ArrowLeft: "Left arrow",
	ArrowRight: "Right arrow",
	Home: "Home",
	End: "End",
};

/** The chord as the reference prints it, for example "Ctrl or Cmd + Enter". */
export function formatKeybinding(binding: Keybinding): string {
	const parts = binding.modifiers.map((modifier) => MODIFIER_LABELS[modifier]);
	parts.push(KEY_LABELS[binding.key] ?? binding.key.toUpperCase());
	return parts.join(" + ");
}

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

/**
 * One sentence per view. Typed against the shell's view union so adding a
 * view without a guide entry fails to compile.
 */
export const VIEW_GUIDE: Readonly<Record<WorkspaceView, { readonly title: string; readonly meaning: string }>> = {
	conversation: {
		title: "Conversation",
		meaning:
			"Your requests and Clio Coder's responses as readable prose, with the tools it ran folded into one activity line per stretch of work.",
	},
	timeline: {
		title: "Session Timeline",
		meaning:
			"The same record as the conversation, one card per protocol item, with provenance, exact keys, and the token fields.",
	},
	"effective-clio-coder": {
		title: "Effective Clio Coder",
		meaning:
			"The configuration Clio Coder is actually using for this project, where each value came from, and when a change takes effect.",
	},
	catalog: {
		title: "Catalog",
		meaning:
			"Agents, skills, library resources, extensions, and verification checks Clio Coder can see, with their trust and scope.",
	},
	usage: {
		title: "Usage",
		meaning:
			"This project's 30-day usage record as Clio Coder stored it. A missing store is told apart from zero activity.",
	},
	dispatch: {
		title: "Dispatch",
		meaning:
			"An installation-wide, manually refreshed snapshot of Clio Coder's worker admission state and aggregate totals. It is not a project view.",
	},
	"fleet-runs": {
		title: "Runs",
		meaning:
			"Recent durable runs across the installation: their event spines, receipt trust, fleet lineage, gate verdicts, evidence bundles, and completed evaluations.",
	},
};

const AUTONOMY_MEANINGS: Readonly<Record<WireAutonomyLevel, string>> = {
	"read-only":
		"Read-class tools run. Write, execute, and dispatch calls are refused, and Clio Coder proposes them instead. The safety net still runs first.",
	suggest: "Read-class tools run. Every write, execute, and dispatch call waits for your approval.",
	"auto-edit":
		"Reads, edits, and recognised commands run. Unrecognised shell commands, plan-scale dispatch, and anything that publishes outside the project wait for your approval.",
	"full-auto":
		"Everything runs without asking. The safety net still blocks what it always blocks and still confirms what it always confirms.",
};

const TIMELINE_STATUS_MEANINGS: Readonly<Record<WireTimelineItem["status"], string>> = {
	queued: "Clio Coder has accepted the item and has not started it.",
	active: "The item is running right now.",
	waiting: "The item is waiting on you, usually an approval.",
	complete: "Clio Coder reported the item finished.",
	canceled: "The item was stopped before it finished. A stop is not a failure.",
	failed: "Clio Coder reported the item failed.",
	replayed: "Clio Coder replayed this item from an earlier turn of the same session. It was not observed live.",
};

export const HELP_SECTIONS: readonly HelpSection[] = [
	{
		id: "views",
		title: "Views",
		lede:
			"The center surface switches between these. They are views of one bounded workspace, not separate applications.",
		entries: (Object.keys(VIEW_GUIDE) as WorkspaceView[]).map((view) => ({
			term: VIEW_GUIDE[view].title,
			meaning: VIEW_GUIDE[view].meaning,
		})),
	},
	{
		id: "keyboard",
		title: "Keyboard",
		lede: "Every shortcut the desktop app binds. Everything else is reachable with Tab, Enter, and Space.",
		entries: KEYBINDING_ORDER.map((binding) => ({
			term: formatKeybinding(binding),
			meaning: `${binding.action}. ${binding.where}.`,
		})),
	},
	{
		id: "working-freedom",
		title: "Working freedom",
		lede:
			"Autonomy is the freedom Clio Coder has to act without asking. The bound session keeps the level Clio Coder says it is enforcing; the settings value reaches the next session.",
		entries: AUTONOMY_LEVELS.map((level) => ({
			term: level.replace("-", " "),
			meaning: AUTONOMY_MEANINGS[level],
		})),
	},
	{
		id: "vocabulary",
		title: "Words the app uses",
		lede: "Precise Clio Coder terms are kept where changing them would hide scope.",
		entries: [
			{ term: "Target", meaning: "The configured service or runtime Clio Coder routes a turn through." },
			{ term: "Model", meaning: "The model the target serves for that turn." },
			{ term: "Session", meaning: "One conversation Clio Coder keeps and can resume. A project may have many." },
			{ term: "Turn", meaning: "One request and everything Clio Coder did in response to it." },
			{
				term: "Evidence",
				meaning:
					"The tools, approvals, outcomes, and receipts that show what happened, as distinct from prose about it.",
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
			...(Object.keys(TIMELINE_STATUS_MEANINGS) as WireTimelineItem["status"][]).map((status) => ({
				term: `Status: ${status}`,
				meaning: TIMELINE_STATUS_MEANINGS[status],
			})),
		],
	},
	{
		id: "boundaries",
		title: "What the app will not do",
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
					"Files, sessions, and configuration are read and changed inside the project you opened, through Clio Coder. Runs, Dispatch, the recovery check, and the toolchain and agent inventories are installation-wide reads, and each says so in its header.",
			},
			{
				term: "Control is local",
				meaning: "The host listens only on this machine and every request carries a token issued at start.",
			},
		],
	},
	{
		id: "terminal",
		title: "In a terminal",
		lede: "This reference covers the desktop app.",
		entries: [
			{
				term: "/help",
				meaning: "In a terminal, /help lists Clio Coder's own commands. Those commands are not part of this app.",
			},
		],
	},
	{
		id: "tasks-and-decisions",
		title: "Tasks and decisions",
		lede: "Clio Coder keeps task and decision ledgers for a session.",
		entries: [],
		reserved: "This build of the desktop app does not read those ledgers yet. Nothing here is hidden; it is not built.",
	},
	{
		id: "interview",
		title: "Answering a question Clio Coder asks",
		lede:
			"An approval is a yes or no inside a turn. An interview is a set of questions with typed answers and a way to cancel.",
		entries: [],
		reserved:
			"This build of the desktop app answers approvals only. When interviews arrive they will have their own keys, never Alt+A or Alt+R.",
	},
];

export interface HelpMatch {
	readonly section: HelpSection;
	readonly entries: readonly HelpEntry[];
}

function normalise(text: string): string {
	return text.toLocaleLowerCase("en-US");
}

/**
 * Sections whose title, lede, or any entry contains every word of the query.
 * An empty query returns the whole reference in order.
 */
export function searchHelp(query: string): readonly HelpMatch[] {
	const words = normalise(query).split(/\s+/u).filter((word) => word.length > 0);
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
