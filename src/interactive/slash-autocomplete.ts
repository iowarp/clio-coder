import type { AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions } from "../engine/tui.js";
import { BUILTIN_SLASH_COMMANDS } from "./slash-commands.js";

export interface SlashAutocompleteCommand {
	name: string;
	description?: string;
	argumentHint?: string;
}

export function buildSlashAutocompleteCommands(): SlashAutocompleteCommand[] {
	const commands: SlashAutocompleteCommand[] = [];
	for (const command of BUILTIN_SLASH_COMMANDS) {
		commands.push({
			name: command.name,
			description: command.description,
			...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
		});
	}
	return commands;
}

export class SlashCommandAutocompleteProvider implements AutocompleteProvider {
	constructor(private readonly commands: ReadonlyArray<SlashAutocompleteCommand>) {}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		options: { signal: AbortSignal; force?: boolean },
	): Promise<AutocompleteSuggestions | null> {
		if (options.signal.aborted || cursorLine !== 0) return null;
		const currentLine = lines[cursorLine] ?? "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		const firstNonSpace = textBeforeCursor.search(/\S/);
		if (firstNonSpace === -1 || textBeforeCursor[firstNonSpace] !== "/") return null;

		const slashText = textBeforeCursor.slice(firstNonSpace);
		const spaceIndex = slashText.indexOf(" ");
		if (spaceIndex === -1) {
			const commandPrefix = slashText.slice(1);
			if (commandPrefix.includes("/")) return null;
			const items = this.commands
				.filter((command) => command.name.startsWith(commandPrefix))
				.map((command) => ({
					value: command.name,
					label: command.name,
					...(command.argumentHint
						? {
								description: command.description ? `${command.argumentHint} - ${command.description}` : command.argumentHint,
							}
						: command.description
							? { description: command.description }
							: {}),
				}));
			if (items.length === 0) return null;
			return { items, prefix: slashText };
		}

		return null;
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const currentLine = lines[cursorLine] ?? "";
		const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
		const afterCursor = currentLine.slice(cursorCol);
		const nextLines = [...lines];

		if (prefix.startsWith("/") && beforePrefix.trim() === "") {
			const suffix = afterCursor.startsWith(" ") ? "" : " ";
			nextLines[cursorLine] = `${beforePrefix}/${item.value}${suffix}${afterCursor}`;
			return {
				lines: nextLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + 1 + suffix.length,
			};
		}

		nextLines[cursorLine] = `${beforePrefix}${item.value}${afterCursor}`;
		return {
			lines: nextLines,
			cursorLine,
			cursorCol: beforePrefix.length + item.value.length,
		};
	}
}

export function createSlashCommandAutocompleteProvider(): SlashCommandAutocompleteProvider {
	return new SlashCommandAutocompleteProvider(buildSlashAutocompleteCommands());
}
