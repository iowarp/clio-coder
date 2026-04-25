import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
	type SlashCommand,
} from "../engine/tui.js";
import { BUILTIN_SLASH_COMMANDS } from "./slash-commands.js";

export type SlashAutocompleteCommand = SlashCommand;

export interface SlashAutocompleteOptions {
	basePath?: string;
	fdPath?: string | null;
}

export function buildSlashAutocompleteCommands(): SlashAutocompleteCommand[] {
	return BUILTIN_SLASH_COMMANDS.map((command) => ({
		name: command.name,
		description: command.description,
		...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
	}));
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
	private readonly provider: CombinedAutocompleteProvider;

	constructor(commands: SlashAutocompleteCommand[], basePath: string, fdPath: string | null) {
		this.provider = new CombinedAutocompleteProvider(commands, basePath, fdPath);
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		const suggestions = await this.provider.getSuggestions(lines, cursorLine, cursorCol, options);
		const commandPrefix = isSlashCommandPrefix(lines, cursorLine, cursorCol);
		if (!suggestions || commandPrefix === null) return suggestions;
		// pi-tui returns fuzzy-ranked matches for slash commands. Clio narrows to
		// strict prefix matches so /m surfaces /model only, not every command
		// containing 'm'. Tests under tests/unit/slash-autocomplete.test.ts pin
		// this UX intentionally — keep this filter even though it overlaps with
		// pi-tui's own ranking.
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
		options.fdPath === undefined ? "fd" : options.fdPath,
	);
}
