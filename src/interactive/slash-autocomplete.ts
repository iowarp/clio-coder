import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
	type SlashCommand,
	truncateToWidth,
	visibleWidth,
} from "../engine/tui.js";
import { resolveFdBinary } from "../tools/executables.js";
import { commandReference, SETTINGS_AREA_IDS, SLASH_COMMAND_GROUPS } from "./slash-commands.js";
import {
	type ArgCompletion,
	COMPLETION_SLOT_NAMES,
	type CommandArgsSpec,
	type CompletionSlotName,
	completeArgs,
	renderArgsSpec,
} from "./slash-spec.js";

export type SlashAutocompleteCommand = SlashCommand;

const ARGUMENT_HINT_BUDGET = 44;
const COMPLETION_DESCRIPTION_BUDGET = 80;

export interface CompletionValue {
	/** Stable identity; distinct from the inserted spelling when aliases are displayed. */
	id: string;
	value: string;
	label: string;
	description: string;
	disabledReason?: string;
	sensitive?: boolean;
}

export interface CompletionSourceRequest {
	slot: CompletionSlotName;
	prefix: string;
	command: string;
	subcommand?: string;
	line: string;
	cursor: number;
	generation: number;
	signal: AbortSignal;
}

export type CompletionSource = (request: CompletionSourceRequest) => Promise<ReadonlyArray<CompletionValue>>;
export type CompletionSources = Partial<Record<CompletionSlotName, CompletionSource>>;

export interface SlashCompletionItem extends AutocompleteItem {
	id: string;
	kind: "command" | "flag" | "value" | "submenu" | "open-submenu";
	replacement: { start: number; end: number };
	appendSpace: boolean;
	disabledReason?: string;
	completionSlot?: CompletionSlotName;
	quote?: '"' | "'";
	remainingGrammar?: string;
	effectDescription?: string;
	submenu?: { parent: string; back: true };
}

export interface SlashAutocompleteOptions {
	basePath?: string;
	fdPath?: string | null;
	/** Slice 11 replaces the named no-op sources with read-only runtime sources. */
	completionSources?: CompletionSources;
	/** @deprecated Dynamic skill values move to the named `skills` slot in slice 11. */
	listSkills?: () => unknown;
}

/** Complete provider surface now, deliberately inert until slice 11 wiring. */
export function stubCompletionSources(): Record<CompletionSlotName, CompletionSource> {
	const sources = {} as Record<CompletionSlotName, CompletionSource>;
	for (const slot of COMPLETION_SLOT_NAMES) sources[slot] = async () => [];
	return sources;
}

function compactArgumentHint(args: CommandArgsSpec | undefined): string | undefined {
	if (!args) return undefined;
	if (args.subcommands) {
		const rootStr = renderArgsSpec({
			...(args.flags ? { flags: args.flags } : {}),
			...(args.positionals ? { positionals: args.positionals } : {}),
		});
		const parts = [...(rootStr ? [rootStr] : []), ...Object.keys(args.subcommands)];
		return parts.join(" | ") || undefined;
	}
	const positionalTail = renderArgsSpec({ ...(args.positionals ? { positionals: args.positionals } : {}) });
	const tail = positionalTail ? ` ${positionalTail}` : "";
	const flagParts = (args.flags ?? []).map((flag) => renderArgsSpec({ flags: [flag] }));
	const kept: string[] = [];
	for (const part of flagParts) {
		if (`${[...kept, part].join(" ")} …${tail}`.length > ARGUMENT_HINT_BUDGET) break;
		kept.push(part);
	}
	let flags = kept.join(" ");
	if (kept.length < flagParts.length) flags = flags ? `${flags} …` : "…";
	const hint = `${flags}${flags ? tail : positionalTail}`.trim();
	return hint || undefined;
}

/** Explicit attachment manifest: grammar owns positions, providers only own values. */
export const COMPLETION_SLOT_MANIFEST: Readonly<Record<string, CompletionSlotName>> = {
	"run:pos:agent": "agents",
	"run:flag:--agent-profile": "agent-profiles",
	"run:flag:--runtime": "worker-runtimes",
	"run:flag:--target": "targets",
	"run:flag:--model": "models",
	"run:flag:--require": "capabilities",
	"delegate:pos:agent-id": "external-agents",
	"council:flag:--roster": "rosters",
	"share:pos:run-id": "shareable-runs",
	"skill:pos:name": "skills",
	"fleet/run:pos:name": "fleet-contracts",
	"fleet/run:flag:--var": "fleet-vars",
	"tasks/hand:pos:id": "tasks",
	"tasks/done:pos:id": "tasks",
	"tasks/drop:pos:id": "tasks",
	"context/recall:pos:ref": "context-refs",
	"view/verify:pos:runId": "receipts",
	"panes/show:pos:run-or-agent": "pane-runs-agents",
	"panes/open:pos:preset-or-argv": "pane-presets",
	"panes/close:pos:target": "pane-targets",
	"resources/library:pos:kind": "library-tabs",
	"model:pos:pattern": "models",
	"thinking:pos:level": "thinking-levels",
	"settings:pos:area": "settings-areas",
	"settings:pos:group": "settings-groups",
	"help:pos:query": "help-queries",
	"archive/export:pos:path": "paths",
	"archive/import:pos:path": "paths",
	"export:pos:path": "paths",
};

function completionGrammar(command: string, args: CommandArgsSpec): CommandArgsSpec {
	const clone = (spec: CommandArgsSpec, path: string): CommandArgsSpec => ({
		...spec,
		...(spec.flags
			? {
					flags: spec.flags.map((flag) => {
						const completionSlot = COMPLETION_SLOT_MANIFEST[`${path}:flag:${flag.name}`];
						return { ...flag, ...(completionSlot ? { completionSlot } : {}) };
					}),
				}
			: {}),
		...(spec.positionals
			? {
					positionals: spec.positionals.map((pos) => {
						const completionSlot = COMPLETION_SLOT_MANIFEST[`${path}:pos:${pos.name}`];
						const values =
							command === "output" && pos.name === "verbosity"
								? (["minimal", "default", "verbose"] as const)
								: command === "settings" && pos.name === "area"
									? SETTINGS_AREA_IDS
									: undefined;
						return { ...pos, ...(completionSlot ? { completionSlot } : {}), ...(values ? { values } : {}) };
					}),
				}
			: {}),
		...(spec.subcommands
			? {
					subcommands: Object.fromEntries(
						Object.entries(spec.subcommands).map(([name, child]) => [name, clone(child, `${path}/${name}`)]),
					),
				}
			: {}),
	});
	return clone(args, command);
}

function compactDescription(description: string | undefined): string | undefined {
	if (!description || visibleWidth(description) <= COMPLETION_DESCRIPTION_BUDGET) return description;
	return `${truncateToWidth(description, COMPLETION_DESCRIPTION_BUDGET - 1, "", false).trimEnd()}…`;
}

function argumentCompletionItems(
	args: CommandArgsSpec,
	argumentText: string,
	cursor = argumentText.length,
	subcommandDescriptions?: Readonly<Record<string, string>>,
): AutocompleteItem[] | null {
	const result = completeArgs(args, argumentText, cursor);
	if (!result) return null;
	const items = result.completions
		.filter((completion) => completion.completionSlot === undefined)
		.map((completion) => {
			const description = subcommandDescriptions?.[completion.token] ?? completion.hint;
			return {
				value: `${argumentText.slice(0, result.tokenStart)}${completion.token}${argumentText.slice(result.tokenEnd)}`,
				label: completion.token,
				...(description ? { description } : {}),
			};
		});
	return items.length > 0 ? items : null;
}

export function buildSlashAutocompleteCommands(): SlashAutocompleteCommand[] {
	const reference = commandReference();
	return SLASH_COMMAND_GROUPS.flatMap((group) => reference.filter((ref) => ref.group === group)).map((ref) => {
		const args = ref.args ? completionGrammar(ref.name, ref.args) : undefined;
		const argumentHint = compactArgumentHint(args);
		return {
			name: ref.name,
			description: ref.description,
			...(argumentHint ? { argumentHint } : {}),
			...(args
				? {
						getArgumentCompletions: (text: string) =>
							argumentCompletionItems(args, text, text.length, ref.subcommandDescriptions),
					}
				: {}),
		};
	});
}

const BARE_VALID_PARENTS = new Set(["agents", "context", "memory", "panes", "resources"]);

interface SlashContext {
	line: string;
	command: string;
	commandStart: number;
	commandEnd: number;
	argsStart: number;
}

function slashContext(lines: string[], cursorLine: number, cursorCol: number): SlashContext | null {
	if (cursorLine !== 0) return null;
	const line = lines[0] ?? "";
	const first = line.search(/\S/);
	if (first < 0 || line[first] !== "/" || cursorCol < first + 1) return null;
	let commandEnd = first + 1;
	while (commandEnd < line.length && !/\s/.test(line[commandEnd] ?? "")) commandEnd++;
	const argsStart = commandEnd < line.length ? commandEnd + 1 : commandEnd;
	// The cursor may be in the command or any argument token, but never in a later editor line.
	return { line, command: line.slice(first + 1, commandEnd), commandStart: first + 1, commandEnd, argsStart };
}

function genericTokenRange(line: string, cursor: number): { start: number; end: number } {
	let start = Math.max(0, Math.min(cursor, line.length));
	let quote: '"' | "'" | undefined;
	while (start > 0) {
		const previous = line[start - 1] ?? "";
		if (!quote && /\s/.test(previous)) break;
		if (previous === '"' || previous === "'") quote = quote === previous ? undefined : previous;
		start--;
	}
	let end = Math.max(start, Math.min(cursor, line.length));
	quote = undefined;
	while (end < line.length) {
		const char = line[end] ?? "";
		if (!quote && /\s/.test(char)) break;
		if (char === '"' || char === "'") quote = quote === char ? undefined : char;
		end++;
	}
	return { start, end };
}

function sourceRows(values: ReadonlyArray<CompletionValue>, prefix: string): CompletionValue[] {
	const lower = prefix.toLowerCase();
	return values.filter((value) => !value.sensitive && value.value.toLowerCase().startsWith(lower));
}

class ClioAutocompleteProvider implements AutocompleteProvider {
	readonly triggerCharacters = ["/", "@"];
	private readonly files: CombinedAutocompleteProvider;
	private readonly sourceBySlot: Record<CompletionSlotName, CompletionSource>;
	private generation = 0;

	constructor(basePath: string, fdPath: string | null, sources: CompletionSources) {
		this.files = new CombinedAutocompleteProvider([], basePath, fdPath);
		this.sourceBySlot = { ...stubCompletionSources(), ...sources };
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const generation = ++this.generation;
		const context = slashContext(lines, cursorLine, cursorCol);
		if (!context) {
			const suggestions = await this.files.getSuggestions(lines, cursorLine, cursorCol, options);
			if (!suggestions || generation !== this.generation || options.signal.aborted) return null;
			const range = genericTokenRange(lines[cursorLine] ?? "", cursorCol);
			return {
				prefix: suggestions.prefix,
				items: suggestions.items.map((item, index) => ({
					...item,
					id: `file:${index}:${item.value}`,
					kind: "value" as const,
					replacement: range,
					appendSpace: false,
					...(item.description ? { effectDescription: item.description } : {}),
				})),
			};
		}
		const reference = commandReference();
		const refs = SLASH_COMMAND_GROUPS.flatMap((group) => reference.filter((ref) => ref.group === group));
		const exactRef = refs.find((candidate) => candidate.name.toLowerCase() === context.command.toLowerCase());
		if (cursorCol === context.commandEnd && options.force && exactRef && BARE_VALID_PARENTS.has(exactRef.name)) {
			const item: SlashCompletionItem = {
				id: `open:${exactRef.name}`,
				kind: "open-submenu",
				value: "",
				label: "Open …",
				description: `Open /${exactRef.name} actions`,
				effectDescription: `Open /${exactRef.name} actions`,
				replacement: { start: context.commandEnd, end: context.commandEnd },
				appendSpace: true,
				submenu: { parent: exactRef.name, back: true },
			};
			return { items: [item], prefix: "" };
		}
		if (cursorCol === context.commandEnd && options.force && exactRef?.args) {
			const item: SlashCompletionItem = {
				id: `advance:${exactRef.name}`,
				kind: "command",
				value: exactRef.name,
				label: exactRef.name,
				description: exactRef.description,
				effectDescription: exactRef.description,
				replacement: { start: context.commandStart, end: context.commandEnd },
				appendSpace: true,
			};
			return { items: [item], prefix: context.command };
		}
		if (cursorCol <= context.commandEnd) {
			const prefix = context.line.slice(context.commandStart, cursorCol);
			const items: SlashCompletionItem[] = refs
				.filter((ref) => ref.name.toLowerCase().startsWith(prefix.toLowerCase()) && ref.name !== prefix)
				.map((ref) => {
					const remainingGrammar = compactArgumentHint(ref.args);
					const description = compactDescription(`${remainingGrammar ? `${remainingGrammar} — ` : ""}${ref.description}`);
					const item: SlashCompletionItem = {
						id: `command:${ref.name}`,
						kind: "command",
						value: ref.name,
						label: ref.name,
						effectDescription: ref.description,
						replacement: { start: context.commandStart, end: context.commandEnd },
						appendSpace: Boolean(ref.args && (ref.args.positionals || ref.args.flags || ref.args.subcommands)),
					};
					if (description) item.description = description;
					if (remainingGrammar) item.remainingGrammar = remainingGrammar;
					return item;
				});
			return items.length ? { items, prefix } : null;
		}

		const ref = refs.find((candidate) => candidate.name.toLowerCase() === context.command.toLowerCase());
		if (!ref?.args) return null;
		const argumentText = context.line.slice(context.argsStart);
		const argumentCursor = Math.max(0, cursorCol - context.argsStart);
		const grammar = completionGrammar(ref.name, ref.args);
		const result = completeArgs(grammar, argumentText, argumentCursor);
		if (!result) return null;
		const beforeCursor = argumentText.slice(result.tokenStart, argumentCursor);
		const selectedSubcommand = Object.keys(ref.args.subcommands ?? {}).find(
			(name) => argumentText.trimStart().split(/\s+/, 1)[0] === name,
		);
		const items: SlashCompletionItem[] = [];
		for (const completion of result.completions) {
			if (completion.completionSlot) {
				const values = await this.sourceBySlot[completion.completionSlot]({
					slot: completion.completionSlot,
					prefix: beforeCursor,
					command: ref.name,
					...(selectedSubcommand ? { subcommand: selectedSubcommand } : {}),
					line: context.line,
					cursor: cursorCol,
					generation,
					signal: options.signal,
				});
				if (generation !== this.generation || options.signal.aborted) return null;
				for (const value of sourceRows(values, beforeCursor)) {
					items.push(
						this.itemFromValue(
							value,
							completion,
							context.argsStart + result.tokenStart,
							context.argsStart + result.tokenEnd,
							result.quote,
						),
					);
				}
				continue;
			}
			if (completion.token === beforeCursor && options.force !== true) continue;
			const description = completion.description ?? ref.subcommandDescriptions?.[completion.token] ?? completion.hint;
			const effectDescription = completion.description ?? ref.subcommandDescriptions?.[completion.token];
			const item: SlashCompletionItem = {
				id: `${ref.name}:${completion.token}`,
				kind: result.submenu ? "submenu" : completion.token.startsWith("--") ? "flag" : "value",
				value: completion.token,
				label: completion.token,
				replacement: { start: context.argsStart + result.tokenStart, end: context.argsStart + result.tokenEnd },
				appendSpace: completion.hasNextSlot,
			};
			if (description) item.description = description;
			if (completion.hint) item.remainingGrammar = completion.hint;
			if (effectDescription) item.effectDescription = effectDescription;
			if (result.submenu) item.submenu = { parent: ref.name, back: true };
			if (result.quote) item.quote = result.quote;
			items.push(item);
		}
		return items.length ? { items, prefix: beforeCursor } : null;
	}

	private itemFromValue(
		value: CompletionValue,
		grammar: ArgCompletion,
		start: number,
		end: number,
		quote?: '"' | "'",
	): SlashCompletionItem {
		return {
			id: value.id,
			kind: "value",
			value: value.value,
			label: value.label,
			description: value.disabledReason ?? value.description,
			replacement: { start, end },
			appendSpace: grammar.hasNextSlot,
			effectDescription: value.description,
			...(grammar.completionSlot ? { completionSlot: grammar.completionSlot } : {}),
			...(quote ? { quote } : {}),
			...(value.disabledReason ? { disabledReason: value.disabledReason } : {}),
		};
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		_cursorCol: number,
		item: AutocompleteItem,
		_prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const completion = item as SlashCompletionItem;
		if (!completion.replacement || completion.disabledReason) {
			return { lines, cursorLine, cursorCol: _cursorCol };
		}
		const current = lines[cursorLine] ?? "";
		if (completion.appendSpace && completion.quote && current[completion.replacement.end] === completion.quote) {
			const needsSpace = !/\s/.test(current[completion.replacement.end + 1] ?? "");
			const inserted = `${completion.value}${completion.quote}${needsSpace ? " " : ""}`;
			const next = [...lines];
			next[cursorLine] =
				`${current.slice(0, completion.replacement.start)}${inserted}${current.slice(completion.replacement.end + 1)}`;
			return { lines: next, cursorLine, cursorCol: completion.replacement.start + inserted.length };
		}
		const needsSpace = completion.appendSpace && !/\s/.test(current[completion.replacement.end] ?? "");
		const inserted = `${completion.value}${needsSpace ? " " : ""}`;
		const next = [...lines];
		next[cursorLine] =
			`${current.slice(0, completion.replacement.start)}${inserted}${current.slice(completion.replacement.end)}`;
		return { lines: next, cursorLine, cursorCol: completion.replacement.start + inserted.length };
	}

	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		return (
			slashContext(lines, cursorLine, cursorCol) === null &&
			this.files.shouldTriggerFileCompletion(lines, cursorLine, cursorCol)
		);
	}
}

export function createSlashCommandAutocompleteProvider(options: SlashAutocompleteOptions = {}): AutocompleteProvider {
	return new ClioAutocompleteProvider(
		options.basePath ?? process.cwd(),
		options.fdPath === undefined ? resolveFdBinary() : options.fdPath,
		options.completionSources ?? {},
	);
}
