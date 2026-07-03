import { statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Skill } from "../domains/resources/skills/loader.js";
import type { MarketplaceSkill } from "../domains/resources/skills/marketplace.js";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
	type SlashCommand,
} from "../engine/tui.js";
import { commandReference } from "./slash-commands.js";
import { type CommandArgsSpec, completeArgs, renderArgsSpec } from "./slash-spec.js";

export type SlashAutocompleteCommand = SlashCommand;

/**
 * The suggestion row shares one truncated column with the command description,
 * so the hint's job is orientation, not the full grammar. Anything longer than
 * this budget is elided; the full usage lives in the usage notice and in the
 * per-token argument completions.
 */
const ARGUMENT_HINT_BUDGET = 44;

export interface SlashAutocompleteOptions {
	basePath?: string;
	fdPath?: string | null;
	listSkills?: () => { installed: Skill[]; marketplace: MarketplaceSkill[] };
}

export function resolveFdBinary(): string | null {
	return findExecutableOnPath("fd") ?? findExecutableOnPath("fdfind");
}

function findExecutableOnPath(name: string): string | null {
	const pathEnv = process.env.PATH;
	if (!pathEnv) return null;
	for (const dir of pathEnv.split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, name);
		try {
			const stat = statSync(candidate);
			if (stat.isFile() && (stat.mode & 0o111) !== 0) {
				return candidate;
			}
		} catch {
			// not present or not stat-able in this directory
		}
	}
	return null;
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

function argumentCompletionItems(args: CommandArgsSpec, argumentText: string): AutocompleteItem[] | null {
	const result = completeArgs(args, argumentText);
	if (!result) return null;
	// The provider replaces the whole argument text with the item value, so
	// each value carries the typed stem verbatim with only the trailing token
	// swapped for the completion.
	const stem = argumentText.slice(0, result.tokenStart);
	return result.completions.map((completion) => ({
		value: `${stem}${completion.token}`,
		label: completion.token,
		...(completion.hint ? { description: completion.hint } : {}),
	}));
}

export function buildSlashAutocompleteCommands(): SlashAutocompleteCommand[] {
	return commandReference().map((ref) => {
		const argumentHint = compactArgumentHint(ref.args);
		const args = ref.args;
		return {
			name: ref.name,
			description: ref.description,
			...(argumentHint ? { argumentHint } : {}),
			...(args ? { getArgumentCompletions: (argumentText: string) => argumentCompletionItems(args, argumentText) } : {}),
		};
	});
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
		const skillMatch = textBeforeCursor.match(/^\s*\/skill(?::|\s+)([a-zA-Z0-9_-]*)$/i);
		if (skillMatch && this.listSkills) {
			const typedPrefix = skillMatch[1]?.toLowerCase() ?? "";
			const { installed, marketplace } = this.listSkills();

			const items: AutocompleteItem[] = [];

			// 1. Installed skills
			for (const skill of installed) {
				if (skill.name.toLowerCase().startsWith(typedPrefix)) {
					items.push({
						value: `skill:${skill.name}`,
						label: skill.name,
						description: skill.description,
					});
				}
			}

			// 2. Marketplace skills (uninstalled)
			for (const skill of marketplace) {
				if (installed.some((s) => s.name === skill.name)) continue;

				if (skill.name.toLowerCase().startsWith(typedPrefix)) {
					items.push({
						value: `marketplace:${skill.name}`,
						label: `${skill.name} (marketplace)`,
						description: skill.description,
					});
				}
			}

			if (items.length > 0) return { items, prefix: typedPrefix };
		}

		const suggestions = await this.provider.getSuggestions(lines, cursorLine, cursorCol, options);
		const commandPrefix = isSlashCommandPrefix(lines, cursorLine, cursorCol);
		if (!suggestions || commandPrefix === null) return suggestions;
		const items = suggestions.items.filter((item) => item.value.startsWith(commandPrefix));
		return items.length > 0 ? { ...suggestions, items } : null;
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

		const skillMatch = textBeforeCursor.match(/^\s*\/skill(?::|\s+)[a-zA-Z0-9_-]*$/i);
		if (skillMatch && (item.value.startsWith("skill:") || item.value.startsWith("marketplace:"))) {
			const skillName = item.value.slice(item.value.indexOf(":") + 1);
			const newLine = `/skill:${skillName} ${textAfterCursor}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;
			return {
				lines: newLines,
				cursorLine,
				cursorCol: `/skill:${skillName} `.length,
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
