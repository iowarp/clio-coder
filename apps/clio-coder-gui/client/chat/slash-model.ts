/**
 * The composer's slash palette, decided without React.
 *
 * A draft that starts with `/` lists what this session can do from the composer: the commands the
 * agent's catalog exposes (run through `routes.invokeSessionCommand`, as the command panel does),
 * the session actions the terminal reaches by slash command and the app hosts in a dialog, and the
 * pane views the terminal opens as overlays. An entry is listed only when the session announced the
 * capability that serves it, because a row that refuses when picked is worse than no row.
 *
 * Nothing here imports React, a stylesheet or the API client, so it runs under plain node:test.
 */

import type { AgentCapabilities } from "../../contracts/capabilities.js";
import type { CommandCatalog, CommandDescriptor } from "../../contracts/steering.js";
import { prefixScore } from "../interaction/prefix-score.js";
import { type CommandFields, type CommandPlan, planCommand } from "./command-model.js";
import type { PaneSection } from "./pane-context.js";

/** Session actions hosted in a dialog over the conversation. */
export type SlashAction = "tree" | "fork" | "handoff" | "btw" | "draft" | "extensions" | "fleet-run";
/** Pane views a slash name opens beside the conversation, `/decisions` at the board's Decisions. */
export type SlashPaneView = "context" | "usage" | "board" | { readonly view: "board"; readonly section: PaneSection };

interface EntryBase {
	readonly id: string;
	/** What follows the slash, as typed: `tree`, `context compact`, `fleet run`. */
	readonly name: string;
	readonly summary: string;
	/** The argument grammar after the name, empty when there is none. */
	readonly hint: string;
	readonly group: SlashGroup;
}

export type SlashGroup = "Clio Coder commands" | "Session" | "Open beside";

export type SlashEntry =
	| (EntryBase & {
			readonly kind: "command";
			readonly command: CommandDescriptor;
			readonly subcommand: string | null;
			/** A required argument means picking completes the draft rather than running it. */
			readonly needsArgs: boolean;
	  })
	| (EntryBase & { readonly kind: "action"; readonly action: SlashAction; readonly title: string })
	| (EntryBase & { readonly kind: "pane"; readonly view: SlashPaneView });

type ArgsSpec = NonNullable<CommandDescriptor["args"]>;
type LeafArgs = Pick<ArgsSpec, "flags" | "positionals">;

/** The grammar after a name, in the terminal's own usage notation. */
export function argumentHint(args: LeafArgs | undefined): string {
	const parts: string[] = [];
	for (const flag of args?.flags ?? [])
		parts.push(
			flag.takesValue
				? `[${flag.name} <${flag.values?.join("|") ?? flag.valueName ?? "value"}>]${flag.repeatable ? "…" : ""}`
				: `[${flag.name}]`,
		);
	for (const positional of args?.positionals ?? []) {
		const word = positional.values?.join("|") ?? positional.name;
		const body = `${word}${positional.rest ? "…" : ""}`;
		parts.push(positional.required ? `<${body}>` : `[${body}]`);
	}
	return parts.join(" ");
}

function commandEntries(catalog: CommandCatalog | undefined): SlashEntry[] {
	const entries: SlashEntry[] = [];
	for (const command of catalog?.commands ?? []) {
		// The bare form of a hub command is refused over ACP, so only its verbs are listed.
		if (!command.requiresSubcommand)
			entries.push({
				kind: "command",
				id: `command:${command.name}`,
				name: command.name,
				summary: command.summary,
				hint: argumentHint(command.args),
				group: "Clio Coder commands",
				command,
				subcommand: null,
				needsArgs: (command.args.positionals ?? []).some((positional) => positional.required),
			});
		for (const [subcommand, args] of Object.entries(command.args.subcommands ?? {}))
			entries.push({
				kind: "command",
				id: `command:${command.name}:${subcommand}`,
				name: `${command.name} ${subcommand}`,
				summary: command.subcommandSummaries?.[subcommand] ?? command.summary,
				hint: argumentHint(args),
				group: "Clio Coder commands",
				command,
				subcommand,
				needsArgs: (args.positionals ?? []).some((positional) => positional.required),
			});
	}
	return entries;
}

interface ActionSpec {
	readonly action: SlashAction;
	readonly name: string;
	readonly title: string;
	readonly summary: string;
	readonly supported: (capabilities: AgentCapabilities) => boolean;
}

/** Names follow `src/interactive/slash-commands.ts`, so a terminal habit works here unchanged. */
const ACTIONS: readonly ActionSpec[] = [
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
];

interface PaneSpec {
	readonly id: string;
	readonly name: string;
	readonly view: SlashPaneView;
	readonly summary: string;
	readonly supported: (capabilities: AgentCapabilities) => boolean;
}

const PANES: readonly PaneSpec[] = [
	{
		id: "context",
		name: "context",
		view: "context",
		summary: "Open the context window beside the conversation",
		supported: (capabilities) => !!capabilities.context,
	},
	{
		id: "usage",
		name: "usage",
		view: "usage",
		summary: "Open usage and quota beside the conversation",
		supported: (capabilities) => !!capabilities.usage,
	},
	{
		id: "tasks",
		name: "tasks",
		view: "board",
		summary: "Open tasks and decisions beside the conversation",
		supported: (capabilities) => !!capabilities.board,
	},
	{
		id: "decisions",
		name: "decisions",
		view: { view: "board", section: "decisions" },
		summary: "Open this task's decisions beside the conversation",
		supported: (capabilities) => !!capabilities.board,
	},
];

export interface SlashFacts {
	readonly capabilities: AgentCapabilities | undefined;
	readonly catalog: CommandCatalog | undefined;
	/** False outside a page that hosts the pane, where a pane jump has nowhere to go. */
	readonly paneAvailable: boolean;
}

/** Every entry this session can serve, in display order: commands, session actions, pane views. */
export function slashEntries(facts: SlashFacts): readonly SlashEntry[] {
	const capabilities = facts.capabilities;
	if (!capabilities) return [];
	const entries: SlashEntry[] = capabilities.commands ? commandEntries(facts.catalog) : [];
	for (const spec of ACTIONS)
		if (spec.supported(capabilities))
			entries.push({
				kind: "action",
				id: `action:${spec.action}`,
				name: spec.name,
				title: spec.title,
				summary: spec.summary,
				hint: "",
				group: "Session",
				action: spec.action,
			});
	if (facts.paneAvailable)
		for (const spec of PANES)
			if (spec.supported(capabilities))
				entries.push({
					kind: "pane",
					id: `pane:${spec.id}`,
					name: spec.name,
					summary: spec.summary,
					hint: "",
					group: "Open beside",
					view: spec.view,
				});
	return entries;
}

/**
 * What the palette filters on: the line after its slash, when the draft is one line that starts
 * with one. A draft with a newline is a message, and `\/` is the escape for a literal slash.
 */
export function slashQuery(text: string): string | null {
	if (!text.startsWith("/") || text.includes("\n")) return null;
	return text.slice(1);
}

/**
 * Ranked by name: an exact name, then a whole prefix, a word prefix, a substring. An action's title
 * counts only as a prefix of the whole title and ranks below any name match, so `/co` does not pull in every title
 * with a word that starts that way. A query that has run past every name, `/doctor deep` say, matches
 * nothing, and a command name followed by a space is the operator typing its arguments; both close
 * the palette.
 */
export function filterSlashEntries(entries: readonly SlashEntry[], query: string): readonly SlashEntry[] {
	const needle = query.trimStart().replace(/\s+/gu, " ");
	if (needle.trim() === "") return entries;
	if (/\s$/u.test(needle) && entries.some((entry) => entry.kind === "command" && entry.name === needle.trim()))
		return [];
	return entries
		.map((entry, index) => {
			const name = entry.name === needle.trim() ? 10 : prefixScore([entry.name], needle);
			const title = entry.kind === "action" ? prefixScore([entry.title], needle) : 0;
			// prefixScore weighs its first haystack triple, so 9 is a prefix of the whole title.
			return { entry, index, score: name > 0 ? name + 3 : title >= 9 ? 1 : 0 };
		})
		.filter((scored) => scored.score > 0)
		.sort((left, right) => right.score - left.score || left.index - right.index)
		.map((scored) => scored.entry);
}

/** The draft a picked command with required arguments leaves behind for the operator to finish. */
export function completedDraft(entry: SlashEntry): string {
	return `/${entry.name} `;
}

/** A session action or pane view named exactly by the line, for Enter with the palette closed. */
export function exactEntry(entries: readonly SlashEntry[], text: string): SlashEntry | null {
	const query = slashQuery(text.trim());
	if (query === null) return null;
	const name = query.trim().replace(/\s+/gu, " ");
	return entries.find((entry) => entry.kind !== "command" && entry.name === name) ?? null;
}

export type SlashLine =
	| { readonly kind: "command"; readonly command: CommandDescriptor; readonly plan: CommandPlan; readonly hint: string }
	| { readonly kind: "invalid"; readonly command: CommandDescriptor; readonly error: string; readonly hint: string };

const COMMAND_LINE = /^\/([A-Za-z][A-Za-z0-9:-]*)(?:\s+([\s\S]*))?$/u;

/** Whitespace-separated tokens with where each starts, so a final rest field keeps its spacing. */
function tokens(text: string): { value: string; start: number }[] {
	return [...text.matchAll(/\S+/gu)].map((match) => ({ value: match[0], start: match.index ?? 0 }));
}

/**
 * `/loop` sends its task as one typed argv element, so a task the operator wrapped whole in one pair of quotes
 * is the words inside them, as the terminal's tokenizer reads it. Anything else, including a quote or a backslash
 * inside the pair, is left as typed and the grammar check refuses it with its usual message.
 */
function unquotedTask(text: string): string {
	const quote = text[0];
	if ((quote !== '"' && quote !== "'") || text.length < 3 || text.at(-1) !== quote) return text;
	const inner = text.slice(1, -1);
	return inner.includes(quote) || inner.includes("\\") || inner.trim() === "" ? text : inner;
}

/**
 * Parses `/name args` against the catalog grammar into the form fields the command panel collects,
 * then validates them with the same `planCommand`, so a typed line and a filled form are held to one
 * rule. Returns null when the line names no catalog command; it is then a prompt or a template.
 */
export function parseSlashLine(text: string, catalog: CommandCatalog | undefined): SlashLine | null {
	const match = COMMAND_LINE.exec(text.trim());
	if (!match) return null;
	const command = catalog?.commands.find((entry) => entry.name === match[1]);
	if (!command) return null;
	const rest = match[2] ?? "";
	const words = tokens(rest);
	const subcommands = command.args.subcommands;
	const first = words[0]?.value;
	const subcommand = first !== undefined && subcommands && Object.hasOwn(subcommands, first) ? first : null;
	const args = subcommand !== null ? subcommands?.[subcommand] : command.args;
	const hint = `/${command.name}${subcommand !== null ? ` ${subcommand}` : ""} ${argumentHint(args)}`.trimEnd();
	const invalid = (error: string): SlashLine => ({ kind: "invalid", command, error, hint });
	if (subcommand === null && command.requiresSubcommand)
		return invalid(
			`/${command.name} needs one of: ${Object.keys(subcommands ?? {})
				.map((name) => `/${command.name} ${name}`)
				.join(", ")}.`,
		);
	const fields: Record<string, string | boolean> = subcommand !== null ? { subcommand } : {};
	const positionals = args?.positionals ?? [];
	let position = 0;
	for (let index = subcommand !== null ? 1 : 0; index < words.length; index += 1) {
		const word = words[index];
		if (word === undefined) break;
		if (word.value.startsWith("--")) {
			const flag = args?.flags?.find((entry) => entry.name === word.value);
			if (!flag) return invalid(`/${command.name} has no option ${word.value}.`);
			if (!flag.takesValue) {
				fields[`flag:${flag.name}`] = true;
				continue;
			}
			const value = words[index + 1]?.value;
			if (value === undefined) return invalid(`${flag.name} needs a value.`);
			index += 1;
			const key = `flag:${flag.name}`;
			const earlier = fields[key];
			if (typeof earlier === "string" && !flag.repeatable) return invalid(`${flag.name} can be given once.`);
			fields[key] = typeof earlier === "string" ? `${earlier}\n${value}` : value;
			continue;
		}
		const positional = positionals[position];
		if (!positional)
			return invalid(`/${command.name} takes no more arguments after ${words[index - 1]?.value ?? "its name"}.`);
		if (positional.rest) {
			const text = rest.slice(word.start).trim();
			fields[`pos:${position}`] = command.name === "loop" ? unquotedTask(text) : text;
			position += 1;
			break;
		}
		fields[`pos:${position}`] = word.value;
		position += 1;
	}
	const planned = planCommand(command, fields as CommandFields);
	return planned.plan ? { kind: "command", command, plan: planned.plan, hint } : invalid(planned.error);
}

export interface ArgumentSuggestion {
	/** The word that completes the token under the caret. */
	readonly value: string;
	readonly summary: string;
	/** The whole line once this word is taken, ready for the next one. */
	readonly draft: string;
}

/**
 * What can come next on a `/name …` line, from the catalog grammar alone: a subcommand, an option,
 * or one of the values an option or argument is limited to. Free text has no suggestions, and a
 * word already typed in full is not offered back.
 */
export function argumentSuggestions(text: string, catalog: CommandCatalog | undefined): readonly ArgumentSuggestion[] {
	if (text.includes("\n")) return [];
	const match = /^\/([A-Za-z][A-Za-z0-9:-]*)\s+([\s\S]*)$/u.exec(text);
	if (!match) return [];
	const command = catalog?.commands.find((entry) => entry.name === match[1]);
	if (!command) return [];
	const rest = match[2] ?? "";
	const words = tokens(rest);
	const typing = rest !== "" && !/\s$/u.test(rest);
	const partial = typing ? (words.at(-1)?.value ?? "") : "";
	const settled = typing ? words.slice(0, -1) : words;
	const head = text.slice(0, text.length - partial.length);
	const offer = (value: string, summary: string): ArgumentSuggestion => ({ value, summary, draft: `${head}${value} ` });
	const narrowed = (rows: readonly ArgumentSuggestion[]) =>
		rows.filter((row) => row.value !== partial && row.value.toLowerCase().startsWith(partial.toLowerCase()));

	const subcommands = command.args.subcommands;
	const first = settled[0]?.value;
	const subcommand = first !== undefined && subcommands && Object.hasOwn(subcommands, first) ? first : null;
	if (subcommand === null && settled.length === 0 && subcommands && !partial.startsWith("-")) {
		const verbs = narrowed(
			Object.keys(subcommands).map((name) => offer(name, command.subcommandSummaries?.[name] ?? command.summary)),
		);
		if (verbs.length > 0 || command.requiresSubcommand) return verbs;
	}
	const args: LeafArgs | undefined = subcommand !== null ? subcommands?.[subcommand] : command.args;
	const flags = args?.flags ?? [];
	const used = new Set<string>();
	let position = 0;
	let awaiting: (typeof flags)[number] | null = null;
	for (const word of settled.slice(subcommand !== null ? 1 : 0)) {
		if (awaiting !== null) {
			awaiting = null;
			continue;
		}
		const flag = word.value.startsWith("--") ? flags.find((entry) => entry.name === word.value) : undefined;
		if (flag) {
			used.add(flag.name);
			if (flag.takesValue) awaiting = flag;
			continue;
		}
		position += 1;
	}
	if (awaiting !== null)
		return narrowed((awaiting.values ?? []).map((value) => offer(value, `${awaiting?.name} value`)));
	const positional = args?.positionals?.[position];
	const values = partial.startsWith("-")
		? []
		: (positional?.values ?? []).map((value) => offer(value, positional?.name ?? ""));
	const options = flags
		.filter((flag) => flag.repeatable || !used.has(flag.name))
		.map((flag) =>
			offer(flag.name, flag.takesValue ? `takes ${flag.values?.join(" | ") ?? flag.valueName ?? "a value"}` : "option"),
		);
	// Options are offered once a dash is typed, or when nothing else can come next.
	return narrowed(partial.startsWith("-") || values.length === 0 ? [...values, ...options] : values);
}
