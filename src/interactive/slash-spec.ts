import type { SlashCommand } from "./slash-commands.js";

export interface CommandFlagSpec {
	/** Unique flag name, e.g. "--target". */
	name: string;
	/** True when the flag consumes the next token as its value. */
	takesValue?: boolean;
	/** True when every occurrence should be retained instead of last-one-wins. */
	repeatable?: boolean;
	/** Closed set of legal values; parse failure produces the usage result. */
	values?: ReadonlyArray<string>;
	/** Usage placeholder, e.g. "profile" renders as `[--agent-profile <profile>]`. */
	valueName?: string;
	/** Runtime completion source attached by name; providers are wired separately. */
	completionSlot?: CompletionSlotName;
}

export interface CommandPositionalSpec {
	name: string; // e.g. "agent", "task"
	required: boolean;
	/** Closed values in semantic/manifest order. */
	values?: ReadonlyArray<string>;
	/** Greedy tail: consumes the rest of the line verbatim (task text, compact instructions). */
	rest?: boolean;
	/** Runtime completion source attached by name; providers are wired separately. */
	completionSlot?: CompletionSlotName;
}

/**
 * Stable grammar/provider seam. Slice 10 names every dynamic noun; slice 11
 * supplies read-only implementations for these slots.
 */
export const COMPLETION_SLOT_NAMES = [
	"agents",
	"agent-profiles",
	"worker-runtimes",
	"targets",
	"models",
	"capabilities",
	"external-agents",
	"rosters",
	"shareable-runs",
	"skills",
	"fleet-contracts",
	"fleet-vars",
	"fleet-var-values",
	"tasks",
	"context-refs",
	"receipts",
	"pane-runs-agents",
	"pane-presets",
	"pane-targets",
	"library-tabs",
	"thinking-levels",
	"settings-areas",
	"settings-groups",
	"help-queries",
	"paths",
] as const;

export type CompletionSlotName = (typeof COMPLETION_SLOT_NAMES)[number];

export interface CommandArgsSpec {
	flags?: ReadonlyArray<CommandFlagSpec>;
	positionals?: ReadonlyArray<CommandPositionalSpec>;
	/** Subcommands with their own args, e.g. share export/import. */
	subcommands?: Record<string, CommandArgsSpec>;
	/**
	 * For commands shaped like `<name> <rest...>`, continue recognizing
	 * declared flags after earlier positionals until the first non-declared-flag
	 * token starts the rest text. Off by default so established rest commands
	 * keep their byte-for-byte parsing.
	 */
	parseFlagsBeforeRest?: boolean;
}

export interface ParsedArgs {
	flags: Map<string, string | true>;
	flagValues: Map<string, string[]>;
	positionals: string[];
	rest?: string;
	subcommand?: string;
	error?: string; // human-readable cause used in the usage notice
}

function getFlagValuePlaceholder(flag: CommandFlagSpec): string {
	if (flag.valueName) return flag.valueName;
	if (flag.values && flag.values.length > 0) {
		return flag.values.join("|");
	}
	return flag.name.replace(/^--/, "");
}

export function renderArgsSpec(spec: CommandArgsSpec): string {
	const parts: string[] = [];

	if (spec.flags) {
		for (const flag of spec.flags) {
			if (flag.takesValue) {
				const placeholder = getFlagValuePlaceholder(flag);
				parts.push(`[${flag.name} <${placeholder}>]`);
			} else {
				parts.push(`[${flag.name}]`);
			}
		}
	}

	if (spec.positionals) {
		for (const pos of spec.positionals) {
			if (pos.required) {
				parts.push(`<${pos.name}>`);
			} else {
				parts.push(`[${pos.name}]`);
			}
		}
	}

	return parts.join(" ");
}

export function usageLine(entry: { name: string; args?: CommandArgsSpec }, subcommand?: string): string {
	const prefix = `/${entry.name}`;
	const argsSpec = entry.args ?? {};

	if (subcommand && argsSpec.subcommands?.[subcommand]) {
		const subSpec = argsSpec.subcommands[subcommand];
		const subStr = renderArgsSpec(subSpec);
		return `\nusage: ${prefix} ${subcommand}${subStr ? ` ${subStr}` : ""}\n`;
	}

	if (argsSpec.subcommands) {
		const subParts: string[] = [];
		const rootSpec: CommandArgsSpec = {
			...(argsSpec.flags ? { flags: argsSpec.flags } : {}),
			...(argsSpec.positionals ? { positionals: argsSpec.positionals } : {}),
		};
		const rootStr = renderArgsSpec(rootSpec);
		if (rootStr.length > 0) subParts.push(`${prefix} ${rootStr}`);
		for (const [subName, subSpec] of Object.entries(argsSpec.subcommands)) {
			const subStr = renderArgsSpec(subSpec);
			subParts.push(`${prefix} ${subName}${subStr ? ` ${subStr}` : ""}`);
		}
		return `\nusage: ${subParts.join(" | ")}\n`;
	}

	const argsStr = renderArgsSpec(argsSpec);
	return `\nusage: ${prefix}${argsStr ? ` ${argsStr}` : ""}\n`;
}

export function parseArgs(spec: CommandArgsSpec, argsLine: string): ParsedArgs {
	const flags = new Map<string, string | true>();
	const flagValues = new Map<string, string[]>();
	const positionals: string[] = [];
	let subcommand: string | undefined;
	let rest: string | undefined;

	let currentSpec = spec;
	let index = 0;

	const skipWhitespace = () => {
		while (index < argsLine.length) {
			const char = argsLine[index];
			if (char && /\s/.test(char)) {
				index++;
			} else {
				break;
			}
		}
	};

	skipWhitespace();

	if (currentSpec.subcommands && index < argsLine.length) {
		const start = index;
		while (index < argsLine.length) {
			const char = argsLine[index];
			if (char && !/\s/.test(char)) {
				index++;
			} else {
				break;
			}
		}
		const sub = argsLine.slice(start, index);
		if (currentSpec.subcommands[sub]) {
			subcommand = sub;
			currentSpec = currentSpec.subcommands[sub];
			skipWhitespace();
		} else {
			index = start;
		}
	}

	const flagSpecs = currentSpec.flags ?? [];
	const positionalSpecs = currentSpec.positionals ?? [];
	let positionalIndex = 0;

	// A token ends at whitespace unless a quote is open: `--var task="do it"`
	// and `--var "task=do it"` both carry the spaces through, and the quotes
	// themselves are dropped. An unterminated quote runs to the end of the line.
	const readToken = (): { token: string } | null => {
		const tokenStart = index;
		let token = "";
		let quote: string | null = null;
		while (index < argsLine.length) {
			const char = argsLine[index] ?? "";
			if (quote !== null) {
				if (char === quote) quote = null;
				else token += char;
				index++;
				continue;
			}
			if (char === '"' || char === "'") {
				quote = char;
				index++;
				continue;
			}
			if (/\s/.test(char)) break;
			token += char;
			index++;
		}
		if (index === tokenStart) return null;
		return { token };
	};

	const consumeFlag = (matchedFlagSpec: CommandFlagSpec, token: string): string | null => {
		const flagName = matchedFlagSpec.name;
		if (matchedFlagSpec.takesValue) {
			skipWhitespace();
			if (index >= argsLine.length) return `Flag ${token} requires a value`;
			const value = readToken();
			if (value === null) return `Flag ${token} requires a value`;
			const val = value.token;

			if (matchedFlagSpec.values && !matchedFlagSpec.values.includes(val)) {
				return `Invalid value for ${flagName}: ${val}`;
			}

			if (matchedFlagSpec.repeatable) {
				const next = [...(flagValues.get(flagName) ?? []), val];
				flagValues.set(flagName, next);
				flags.set(flagName, next.join(" "));
			} else {
				flagValues.set(flagName, [val]);
				flags.set(flagName, val);
			}
			return null;
		}
		flags.set(flagName, true);
		return null;
	};

	const errorResult = (error: string): ParsedArgs => ({
		flags,
		flagValues,
		positionals,
		...(subcommand !== undefined ? { subcommand } : {}),
		error,
	});

	while (index < argsLine.length) {
		const currentPositionalSpec = positionalSpecs[positionalIndex];
		if (currentPositionalSpec?.rest) {
			if (currentSpec.parseFlagsBeforeRest) {
				while (index < argsLine.length) {
					const tokenStart = index;
					const read = readToken();
					if (read === null) break;
					const matchedFlagSpec = flagSpecs.find((f) => f.name === read.token);
					if (!matchedFlagSpec) {
						index = tokenStart;
						break;
					}
					const error = consumeFlag(matchedFlagSpec, read.token);
					if (error) return errorResult(error);
					skipWhitespace();
				}
			}
			const restVal = argsLine.slice(index).trim();
			if (restVal.length > 0) {
				positionals.push(restVal);
				rest = restVal;
			}
			positionalIndex++;
			index = argsLine.length;
			break;
		}

		const read = readToken();
		if (read === null) break;
		const token = read.token;

		let isFlag = false;
		let matchedFlagSpec: CommandFlagSpec | undefined;

		if (token.startsWith("--")) {
			matchedFlagSpec = flagSpecs.find((f) => f.name === token);
			if (matchedFlagSpec) {
				isFlag = true;
			} else {
				return errorResult(`Unknown flag: ${token}`);
			}
		}

		if (isFlag && matchedFlagSpec) {
			const error = consumeFlag(matchedFlagSpec, token);
			if (error) return errorResult(error);
		} else {
			if (positionalIndex < positionalSpecs.length) {
				positionals.push(token);
				positionalIndex++;
			} else {
				return errorResult(`Unexpected argument: ${token}`);
			}
		}

		skipWhitespace();
	}

	for (let idx = positionalIndex; idx < positionalSpecs.length; idx++) {
		const spec = positionalSpecs[idx];
		if (spec?.required) {
			return {
				flags,
				flagValues,
				positionals,
				...(subcommand !== undefined ? { subcommand } : {}),
				error: `Missing required argument: ${spec.name}`,
			};
		}
	}

	return {
		flags,
		flagValues,
		positionals,
		...(subcommand !== undefined ? { subcommand } : {}),
		...(rest !== undefined ? { rest } : {}),
	};
}

export interface ArgCompletion {
	/** Canonical replacement for the token under the cursor. */
	token: string;
	/** Grammar hint rendered beside the suggestion, e.g. a flag's value placeholder. */
	hint?: string;
	completionSlot?: CompletionSlotName;
	description?: string;
	disabledReason?: string;
	/** A completion with another grammatical slot receives a space on Tab. */
	hasNextSlot: boolean;
}

export interface ArgCompletionResult {
	completions: ArgCompletion[];
	/** Half-open replacement range in argumentText. Quotes are outside the range. */
	tokenStart: number;
	tokenEnd: number;
	quote?: '"' | "'";
	/** Structured second-level list, rather than a flat top-level command row. */
	submenu?: { parent: string; canGoBack: true };
}

interface CompletionToken {
	value: string;
	start: number;
	end: number;
	contentStart: number;
	contentEnd: number;
	quote?: '"' | "'";
}

/** Tokenize without losing source ranges; unterminated quotes intentionally run to EOL. */
function completionTokens(text: string): CompletionToken[] {
	const tokens: CompletionToken[] = [];
	let index = 0;
	while (index < text.length) {
		while (index < text.length && /\s/.test(text[index] ?? "")) index++;
		if (index >= text.length) break;
		const start = index;
		let quote: '"' | "'" | undefined;
		if (text[index] === '"' || text[index] === "'") {
			quote = text[index] as '"' | "'";
			index++;
		}
		const contentStart = index;
		let value = "";
		while (index < text.length) {
			const char = text[index] ?? "";
			if (quote) {
				if (char === quote) break;
			} else if (/\s/.test(char)) {
				break;
			} else if (char === '"' || char === "'") {
				// Quotes embedded in a token group their contents but are not values.
				const embedded = char;
				index++;
				while (index < text.length && text[index] !== embedded) value += text[index++] ?? "";
				if (text[index] === embedded) index++;
				continue;
			}
			value += char;
			index++;
		}
		const contentEnd = index;
		if (quote && text[index] === quote) index++;
		tokens.push({ value, start, end: index, contentStart, contentEnd, ...(quote ? { quote } : {}) });
	}
	return tokens;
}

function tokenAtCursor(text: string, cursor: number): { current: CompletionToken; completed: CompletionToken[] } {
	const safeCursor = Math.max(0, Math.min(cursor, text.length));
	const tokens = completionTokens(text);
	const containing = tokens.find((token) => safeCursor >= token.start && safeCursor <= token.end);
	if (containing) {
		return { current: containing, completed: tokens.filter((token) => token.end <= containing.start) };
	}
	return {
		current: { value: "", start: safeCursor, end: safeCursor, contentStart: safeCursor, contentEnd: safeCursor },
		completed: tokens.filter((token) => token.end <= safeCursor),
	};
}

/**
 * State reached after replaying the completed tokens of an argument line
 * against a spec, mirroring parseArgs: which non-repeatable flags are spent,
 * whether the cursor sits in a flag's value slot, how many positionals are
 * filled, and whether free rest text has begun (after which nothing completes).
 */
interface CompletionWalk {
	usedFlags: Set<string>;
	awaitingValue: CommandFlagSpec | null;
	positionalIndex: number;
	restBegun: boolean;
}

function walkCompletedTokens(spec: CommandArgsSpec, tokens: ReadonlyArray<string>): CompletionWalk {
	const flagSpecs = spec.flags ?? [];
	const positionalSpecs = spec.positionals ?? [];
	const walk: CompletionWalk = { usedFlags: new Set(), awaitingValue: null, positionalIndex: 0, restBegun: false };
	for (const token of tokens) {
		if (walk.awaitingValue) {
			walk.awaitingValue = null;
			continue;
		}
		const atRest = positionalSpecs[walk.positionalIndex]?.rest === true;
		const flagsParseable = !atRest || spec.parseFlagsBeforeRest === true;
		const matched = flagsParseable && token.startsWith("--") ? flagSpecs.find((flag) => flag.name === token) : undefined;
		if (matched) {
			walk.usedFlags.add(matched.name);
			if (matched.takesValue) walk.awaitingValue = matched;
			continue;
		}
		if (atRest) {
			walk.restBegun = true;
			break;
		}
		walk.positionalIndex += 1;
	}
	return walk;
}

function flagCompletions(spec: CommandArgsSpec, walk: CompletionWalk, current: string): ArgCompletion[] {
	const available = (spec.flags ?? []).filter((flag) => flag.repeatable === true || !walk.usedFlags.has(flag.name));
	const lower = current.toLowerCase();
	const rows = available
		.filter((flag) => flag.name.toLowerCase().startsWith(lower))
		.map((flag) => ({ flag, name: flag.name }));
	return rows.map(({ flag, name }) => ({
		token: name,
		...(flag.takesValue ? { hint: `<${getFlagValuePlaceholder(flag)}>` } : {}),
		hasNextSlot: flag.takesValue === true,
	}));
}

/**
 * Complete the trailing token of a slash command's argument text against its
 * args spec: subcommand names in first position, declared flags wherever the
 * grammar still parses flags, and closed value sets in a flag's value slot.
 * Free text (positionals, open flag values, rest) never completes; returning
 * null closes the suggestion list. The walk mirrors parseArgs so a completion
 * is always a token the parser would accept.
 */
export function completeArgs(
	spec: CommandArgsSpec,
	argumentText: string,
	cursor = argumentText.length,
): ArgCompletionResult | null {
	const { current: currentToken, completed: completedTokens } = tokenAtCursor(argumentText, cursor);
	const current = currentToken.value.slice(0, Math.max(0, cursor - currentToken.contentStart));
	const completed = completedTokens.map((token) => token.value);
	const range = {
		tokenStart: currentToken.contentStart,
		tokenEnd: currentToken.contentEnd,
		...(currentToken.quote ? { quote: currentToken.quote } : {}),
	};

	const completions: ArgCompletion[] = [];
	let active = spec;
	let walkTokens = completed;
	let submenu: ArgCompletionResult["submenu"];

	if (spec.subcommands) {
		const first = completed[0];
		if (first === undefined) {
			for (const [name, subSpec] of Object.entries(spec.subcommands)) {
				if (!name.toLowerCase().startsWith(current.toLowerCase())) continue;
				const hint = renderArgsSpec(subSpec);
				completions.push({
					token: name,
					...(hint.length > 0 ? { hint } : {}),
					hasNextSlot: hint.length > 0,
				});
			}
			submenu = { parent: "", canGoBack: true };
		} else if (spec.subcommands[first]) {
			active = spec.subcommands[first];
			walkTokens = completed.slice(1);
		}
	}

	const walk = walkCompletedTokens(active, walkTokens);

	if (walk.restBegun) {
		return completions.length > 0 ? { completions, ...range, ...(submenu ? { submenu } : {}) } : null;
	}

	if (walk.awaitingValue) {
		for (const value of walk.awaitingValue.values ?? []) {
			if (value.toLowerCase().startsWith(current.toLowerCase())) completions.push({ token: value, hasNextSlot: true });
		}
		if (walk.awaitingValue.completionSlot) {
			completions.push({ token: current, completionSlot: walk.awaitingValue.completionSlot, hasNextSlot: true });
		}
		return completions.length > 0 ? { completions, ...range, ...(submenu ? { submenu } : {}) } : null;
	}

	const atRest = (active.positionals ?? [])[walk.positionalIndex]?.rest === true;
	const positional = (active.positionals ?? [])[walk.positionalIndex];
	for (const value of positional?.values ?? []) {
		if (value.toLowerCase().startsWith(current.toLowerCase())) {
			completions.push({ token: value, hasNextSlot: walk.positionalIndex + 1 < (active.positionals?.length ?? 0) });
		}
	}
	if (positional?.completionSlot && !current.startsWith("-")) {
		completions.push({
			token: current,
			completionSlot: positional.completionSlot,
			hasNextSlot: walk.positionalIndex + 1 < (active.positionals?.length ?? 0),
		});
	}
	const flagsParseable = !atRest || active.parseFlagsBeforeRest === true;
	if (flagsParseable && (current.length === 0 || current.startsWith("-"))) {
		completions.push(...flagCompletions(active, walk, current));
	}

	return completions.length > 0 ? { completions, ...range, ...(submenu ? { submenu } : {}) } : null;
}

export type CompletionAcceptance = "accept" | "accept-remainder" | "submit" | "close" | "none" | "disabled";

/** Keyboard contract kept pure so editor adapters can share it. */
export function completionAcceptance(input: {
	key: "tab" | "right" | "enter" | "escape";
	selectionMoved: boolean;
	syntacticallyComplete: boolean;
	disabled?: boolean;
}): CompletionAcceptance {
	if (input.key === "escape") return "close";
	if (input.disabled) return "disabled";
	if (input.key === "tab") return "accept";
	if (input.key === "right") return "accept-remainder";
	if (input.selectionMoved) return "accept";
	return input.syntacticallyComplete ? "submit" : "none";
}

/** Apply either a whole-token acceptance or only its untyped remainder. */
export function replaceCompletionToken(input: {
	line: string;
	range: { start: number; end: number };
	cursor: number;
	value: string;
	mode?: "token" | "remainder";
	appendSpace?: boolean;
}): { line: string; cursor: number } {
	const start = Math.max(0, Math.min(input.range.start, input.line.length));
	const end = Math.max(start, Math.min(input.range.end, input.line.length));
	if (input.mode === "remainder") {
		const cursor = Math.max(start, Math.min(input.cursor, end));
		const typed = input.line.slice(start, cursor);
		if (!input.value.toLowerCase().startsWith(typed.toLowerCase())) return { line: input.line, cursor: input.cursor };
		const remainder = input.value.slice(typed.length);
		return {
			line: `${input.line.slice(0, cursor)}${remainder}${input.line.slice(end)}`,
			cursor: cursor + remainder.length,
		};
	}
	const inserted = `${input.value}${input.appendSpace ? " " : ""}`;
	return {
		line: `${input.line.slice(0, start)}${inserted}${input.line.slice(end)}`,
		cursor: start + inserted.length,
	};
}

export function matchFromSpec(
	entry: {
		name: string;
		args?: CommandArgsSpec;
		fromArgs?: (parsed: ParsedArgs, trimmed: string) => SlashCommand;
	},
	trimmed: string,
): SlashCommand | null {
	const matchedPrefix = `/${entry.name}`;
	if (trimmed !== matchedPrefix && !trimmed.startsWith(`${matchedPrefix} `)) return null;
	const argsLine = trimmed.slice(matchedPrefix.length);
	const parsed = parseArgs(entry.args ?? {}, argsLine);

	if (entry.fromArgs) {
		return entry.fromArgs(parsed, trimmed);
	}

	return null;
}
