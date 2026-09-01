import type { Skill } from "../domains/resources/skills/loader.js";
import type { MarketplaceSkill } from "../domains/resources/skills/marketplace.js";
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
import { commandReference, SLASH_COMMAND_GROUPS } from "./slash-commands.js";
import { type CommandArgsSpec, completeArgs, renderArgsSpec } from "./slash-spec.js";

export type SlashAutocompleteCommand = SlashCommand;

/**
 * The suggestion row shares one truncated column with the command description,
 * so the hint's job is orientation, not the full grammar. Anything longer than
 * this budget is elided; the full usage lives in the usage notice and in the
 * per-token argument completions.
 */
const ARGUMENT_HINT_BUDGET = 44;

/** Fits the narrowest description column the slash popup grants at 120 cols. */
const COMPLETION_DESCRIPTION_BUDGET = 80;

/** Fits the skill popup's description column at an 80-column terminal. */
const SKILL_DESCRIPTION_BUDGET = 40;

export interface SlashAutocompleteOptions {
	basePath?: string;
	fdPath?: string | null;
	listSkills?: () => { installed: Skill[]; marketplace: MarketplaceSkill[] };
}

/**
 * A hint that fits the row. Subcommand commands list their subcommand names;
 * flag commands keep the positional tail whole and include leading flags only
 * while the budget holds, eliding the remainder behind an ellipsis.
 */
function compactArgumentHint(args: CommandArgsSpec | undefined): string | undefined {
	if (!args) return undefined;
	if (args.subcommands) {
		const rootStr = renderArgsSpec({
			...(args.flags ? { flags: args.flags } : {}),
			...(args.positionals ? { positionals: args.positionals } : {}),
		});
		const parts = [...(rootStr.length > 0 ? [rootStr] : []), ...Object.keys(args.subcommands)];
		const joined = parts.join(" | ");
		return joined.length > 0 ? joined : undefined;
	}
	const positionalTail = renderArgsSpec({ ...(args.positionals ? { positionals: args.positionals } : {}) });
	const tail = positionalTail.length > 0 ? ` ${positionalTail}` : "";
	const flagParts = (args.flags ?? []).map((flag) => renderArgsSpec({ flags: [flag] }));
	const kept: string[] = [];
	for (const part of flagParts) {
		const candidate = [...kept, part].join(" ");
		if (`${candidate} …${tail}`.length > ARGUMENT_HINT_BUDGET) break;
		kept.push(part);
	}
	let flagsStr = kept.join(" ");
	if (kept.length < flagParts.length) flagsStr = flagsStr.length > 0 ? `${flagsStr} …` : "…";
	const hint = `${flagsStr}${flagsStr.length > 0 ? tail : positionalTail}`.trim();
	return hint.length > 0 ? hint : undefined;
}

function argumentCompletionItems(
	args: CommandArgsSpec,
	argumentText: string,
	subcommandDescriptions?: Readonly<Record<string, string>>,
): AutocompleteItem[] | null {
	const result = completeArgs(args, argumentText);
	if (!result) return null;
	// The provider replaces the whole argument text with the item value, so
	// each value carries the typed stem verbatim with only the trailing token
	// swapped for the completion.
	const stem = argumentText.slice(0, result.tokenStart);
	return result.completions.map((completion) => {
		const description = subcommandDescriptions?.[completion.token] ?? completion.hint;
		return {
			value: `${stem}${completion.token}`,
			label: completion.token,
			...(description ? { description } : {}),
		};
	});
}

export function buildSlashAutocompleteCommands(): SlashAutocompleteCommand[] {
	const reference = commandReference();
	return SLASH_COMMAND_GROUPS.flatMap((group) => reference.filter((ref) => ref.group === group)).map((ref) => {
		const argumentHint = compactArgumentHint(ref.args);
		const args = ref.args;
		return {
			name: ref.name,
			description: ref.description,
			...(argumentHint ? { argumentHint } : {}),
			...(args
				? {
						getArgumentCompletions: (argumentText: string) =>
							argumentCompletionItems(args, argumentText, ref.subcommandDescriptions),
					}
				: {}),
		};
	});
}

function compactCompletionDescription(description: string | undefined): string | undefined {
	if (!description || visibleWidth(description) <= COMPLETION_DESCRIPTION_BUDGET) return description;
	const clipped = truncateToWidth(description, COMPLETION_DESCRIPTION_BUDGET - 1, "", false).trimEnd();
	return `${clipped}…`;
}

function compactSkillDescription(description: string | undefined): string | undefined {
	if (!description || visibleWidth(description) <= SKILL_DESCRIPTION_BUDGET) return description;
	const clipped = truncateToWidth(description, SKILL_DESCRIPTION_BUDGET - 1, "", false).trimEnd();
	return `${clipped}…`;
}

function isSlashCommandPrefix(lines: string[], cursorLine: number, cursorCol: number): string | null {
	if (cursorLine !== 0) return null;
	const currentLine = lines[cursorLine] ?? "";
	const textBeforeCursor = currentLine.slice(0, cursorCol);
	const firstNonSpace = textBeforeCursor.search(/\S/);
	if (firstNonSpace === -1 || textBeforeCursor[firstNonSpace] !== "/") return null;
	const slashText = textBeforeCursor.slice(firstNonSpace);
	if (slashText.includes(" ")) return null;
	const prefix = slashText.slice(1);
	return prefix.includes("/") ? null : prefix;
}

class ClioAutocompleteProvider implements AutocompleteProvider {
	readonly triggerCharacters = ["/", "@"];

	private readonly provider: CombinedAutocompleteProvider;
	private readonly listSkills: (() => { installed: Skill[]; marketplace: MarketplaceSkill[] }) | undefined;

	constructor(
		commands: SlashAutocompleteCommand[],
		basePath: string,
		fdPath: string | null,
		listSkills?: () => { installed: Skill[]; marketplace: MarketplaceSkill[] },
	) {
		this.provider = new CombinedAutocompleteProvider(commands, basePath, fdPath);
		this.listSkills = listSkills;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const currentLine = lines[cursorLine] ?? "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// Check if we are typing the canonical /skill invocation command (a name
		// separator after /skill). The bare "/skill" selector with nothing after
		// it must NOT match here: matching would offer every installed skill as
		// an autocomplete suggestion with the first one pre-selected, and the
		// editor's autocomplete-confirm binding shares the Enter key with
		// submit, so submitting the bare selector would silently commit
		// whichever skill happened to sort first instead of opening the Skills
		// Hub (see FINDINGS.md F1).
		const skillMatch = textBeforeCursor.match(/^\s*\/skill\s+([a-zA-Z0-9_-]*)$/i);
		if (skillMatch && this.listSkills) {
			const typedPrefix = skillMatch[1]?.toLowerCase() ?? "";
			const { installed, marketplace } = this.listSkills();

			const items: AutocompleteItem[] = [];

			// 1. Installed skills
			for (const skill of installed) {
				if (skill.name.toLowerCase().startsWith(typedPrefix)) {
					const description = compactSkillDescription(skill.description);
					items.push({
						value: `skill:${skill.name}`,
						label: skill.name,
						...(description ? { description } : {}),
					});
				}
			}

			// 2. Marketplace skills (uninstalled)
			for (const skill of marketplace) {
				if (installed.some((s) => s.name === skill.name)) continue;

				if (skill.name.toLowerCase().startsWith(typedPrefix)) {
					const description = compactSkillDescription(skill.description);
					items.push({
						value: `marketplace:${skill.name}`,
						label: `${skill.name} (marketplace)`,
						...(description ? { description } : {}),
					});
				}
			}

			if (items.length > 0) return { items, prefix: typedPrefix };
		}

		const suggestions = await this.provider.getSuggestions(lines, cursorLine, cursorCol, options);
		const commandPrefix = isSlashCommandPrefix(lines, cursorLine, cursorCol);
		if (commandPrefix !== null) {
			const canonicalItems = (suggestions?.items ?? [])
				.filter((item) => item.value.startsWith(commandPrefix))
				.map((item) => {
					const description = compactCompletionDescription(item.description);
					if (description === item.description || description === undefined) return item;
					return { ...item, description };
				});
			const items = canonicalItems;
			if (items.length === 0) return null;
			return { items, prefix: suggestions?.prefix ?? textBeforeCursor };
		}
		// Enter accepts the open completion instead of submitting, so a suggestion
		// the input already equals costs a keystroke that changes no pixel: typing
		// `/memory seed` and pressing Enter accepted "seed" and submitted nothing,
		// which reads as a dropped key and concatenates whatever is typed next
		// onto the unsent line. Nothing left to complete, no popup, and the first
		// Enter submits. An explicit Tab is left alone: it asked for the list.
		if (suggestions && options.force !== true && suggestions.items.some((item) => item.value === suggestions.prefix)) {
			return null;
		}
		return suggestions;
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const currentLine = lines[cursorLine] ?? "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		const textAfterCursor = currentLine.slice(cursorCol);

		const skillMatch = textBeforeCursor.match(/^\s*\/skill\s+[a-zA-Z0-9_-]*$/i);
		if (skillMatch && (item.value.startsWith("skill:") || item.value.startsWith("marketplace:"))) {
			const skillName = item.value.slice(item.value.indexOf(":") + 1);
			const newLine = `/skill ${skillName} ${textAfterCursor}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;
			return {
				lines: newLines,
				cursorLine,
				cursorCol: `/skill ${skillName} `.length,
			};
		}

		return this.provider.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
	}

	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		return this.provider.shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
	}
}

export function createSlashCommandAutocompleteProvider(options: SlashAutocompleteOptions = {}): AutocompleteProvider {
	return new ClioAutocompleteProvider(
		buildSlashAutocompleteCommands(),
		options.basePath ?? process.cwd(),
		options.fdPath === undefined ? resolveFdBinary() : options.fdPath,
		options.listSkills,
	);
}
