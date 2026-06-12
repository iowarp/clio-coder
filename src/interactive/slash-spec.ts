import type { SlashCommand } from "./slash-commands.js";

export interface CommandFlagSpec {
	/** Primary flag, e.g. "--target". */
	name: string;
	/** Accepted synonyms, e.g. ["--worker-profile", "--worker"]. */
	aliases?: ReadonlyArray<string>;
	/** True when the flag consumes the next token as its value. */
	takesValue?: boolean;
	/** True when every occurrence should be retained instead of last-one-wins. */
	repeatable?: boolean;
	/** Closed set of legal values; parse failure produces the usage result. */
	values?: ReadonlyArray<string>;
	/** Usage placeholder, e.g. "profile" renders as `[--worker <profile>]`. */
	valueName?: string;
}

export interface CommandPositionalSpec {
	name: string; // e.g. "agent", "task"
	required: boolean;
	/** Greedy tail: consumes the rest of the line verbatim (task text, compact instructions). */
	rest?: boolean;
}

export interface CommandArgsSpec {
	flags?: ReadonlyArray<CommandFlagSpec>;
	positionals?: ReadonlyArray<CommandPositionalSpec>;
	/** Subcommands with their own args, e.g. share export/import. */
	subcommands?: Record<string, CommandArgsSpec>;
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

function renderArgsSpec(spec: CommandArgsSpec): string {
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

	while (index < argsLine.length) {
		const currentPositionalSpec = positionalSpecs[positionalIndex];
		if (currentPositionalSpec?.rest) {
			const restVal = argsLine.slice(index).trim();
			if (restVal.length > 0) {
				positionals.push(restVal);
				rest = restVal;
			}
			positionalIndex++;
			index = argsLine.length;
			break;
		}

		const tokenStart = index;
		while (index < argsLine.length) {
			const char = argsLine[index];
			if (char && !/\s/.test(char)) {
				index++;
			} else {
				break;
			}
		}
		const token = argsLine.slice(tokenStart, index);
		if (token.length === 0) break;

		let isFlag = false;
		let matchedFlagSpec: CommandFlagSpec | undefined;

		if (token.startsWith("--")) {
			matchedFlagSpec = flagSpecs.find((f) => f.name === token || f.aliases?.includes(token));
			if (matchedFlagSpec) {
				isFlag = true;
			} else {
				return {
					flags,
					flagValues,
					positionals,
					...(subcommand !== undefined ? { subcommand } : {}),
					error: `Unknown flag: ${token}`,
				};
			}
		}

		if (isFlag && matchedFlagSpec) {
			const flagName = matchedFlagSpec.name;
			if (matchedFlagSpec.takesValue) {
				skipWhitespace();
				if (index >= argsLine.length) {
					return {
						flags,
						flagValues,
						positionals,
						...(subcommand !== undefined ? { subcommand } : {}),
						error: `Flag ${token} requires a value`,
					};
				}
				const valStart = index;
				while (index < argsLine.length) {
					const char = argsLine[index];
					if (char && !/\s/.test(char)) {
						index++;
					} else {
						break;
					}
				}
				const val = argsLine.slice(valStart, index);

				if (matchedFlagSpec.values && !matchedFlagSpec.values.includes(val)) {
					return {
						flags,
						flagValues,
						positionals,
						...(subcommand !== undefined ? { subcommand } : {}),
						error: `Invalid value for ${flagName}: ${val}`,
					};
				}

				if (matchedFlagSpec.repeatable) {
					const next = [...(flagValues.get(flagName) ?? []), val];
					flagValues.set(flagName, next);
					flags.set(flagName, next.join(" "));
				} else {
					flagValues.set(flagName, [val]);
					flags.set(flagName, val);
				}
			} else {
				flags.set(flagName, true);
			}
		} else {
			if (positionalIndex < positionalSpecs.length) {
				positionals.push(token);
				positionalIndex++;
			} else {
				return {
					flags,
					flagValues,
					positionals,
					...(subcommand !== undefined ? { subcommand } : {}),
					error: `Unexpected argument: ${token}`,
				};
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

export function matchFromSpec(
	entry: {
		name: string;
		aliases?: ReadonlyArray<string>;
		args?: CommandArgsSpec;
		fromArgs?: (parsed: ParsedArgs, trimmed: string) => SlashCommand;
	},
	trimmed: string,
): SlashCommand | null {
	const nameOrAlias = [entry.name, ...(entry.aliases ?? [])];
	let matchedPrefix: string | null = null;
	for (const term of nameOrAlias) {
		const prefix = `/${term}`;
		if (trimmed === prefix || trimmed.startsWith(`${prefix} `)) {
			matchedPrefix = prefix;
			break;
		}
	}
	if (!matchedPrefix) return null;

	const argsLine = trimmed.slice(matchedPrefix.length);
	const parsed = parseArgs(entry.args ?? {}, argsLine);

	if (entry.fromArgs) {
		return entry.fromArgs(parsed, trimmed);
	}

	return null;
}
