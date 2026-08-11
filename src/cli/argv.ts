/**
 * Dependency-light CLI argument parsing and terminal formatting. This module
 * imports nothing from the domain graph (only `chalk`), so `cli/index.ts` can
 * parse argv and dispatch without dragging provider/auth code (and its
 * transitive pi-* externals) into the eagerly loaded startup chunk. `shared.ts`
 * re-exports everything here for the command modules, which already pay for the
 * heavier graph.
 */

import chalk from "chalk";

export function printError(message: string, detail?: string): void {
	const head = chalk.red("error:");
	process.stderr.write(`${head} ${message}\n`);
	if (detail) process.stderr.write(`  ${detail}\n`);
}

export function printOk(message: string): void {
	process.stdout.write(`${chalk.green("ok:")} ${message}\n`);
}

export function printHeader(message: string): void {
	process.stdout.write(`${chalk.cyan(message)}\n`);
}

export function columnWidths(rows: ReadonlyArray<ReadonlyArray<string>>): number[] {
	const widths: number[] = [];
	for (const row of rows) {
		for (let i = 0; i < row.length; i += 1) {
			widths[i] = Math.max(widths[i] ?? 0, row[i]?.length ?? 0);
		}
	}
	return widths;
}

export function formatColumnRow(row: ReadonlyArray<string>, widths: ReadonlyArray<number>, gap = 2): string {
	return row
		.map((cell, index) => {
			if (index === row.length - 1) return cell;
			return cell.padEnd((widths[index] ?? cell.length) + gap);
		})
		.join("")
		.trimEnd();
}

export function formatColumns(rows: ReadonlyArray<ReadonlyArray<string>>, gap = 2): string {
	if (rows.length === 0) return "";
	const widths = columnWidths(rows);
	return `${rows.map((row) => formatColumnRow(row, widths, gap)).join("\n")}\n`;
}

export function parseFlags(argv: string[]): { flags: Set<string>; positional: string[] } {
	const flags = new Set<string>();
	const positional: string[] = [];
	for (const arg of argv) {
		if (arg.startsWith("--")) flags.add(arg.slice(2));
		else if (arg.startsWith("-") && arg.length > 1) flags.add(arg.slice(1));
		else positional.push(arg);
	}
	return { flags, positional };
}

export interface GlobalCliFlags {
	apiKey?: string;
	noContextFiles: boolean;
	noSkills: boolean;
	skillPaths: string[];
	rest: string[];
	error?: string;
}

const ROOT_FLAG_TOKENS = new Set(["--help", "-h", "--all", "--version", "-v"]);

/**
 * Extract every global startup flag in one order-independent pass. Only flags
 * before the first positional command are global; later occurrences belong to
 * the subcommand. Keeping the value-taking flags in the same state machine is
 * important: three sequential extractors used to mistake one another's values
 * for the command boundary, so `--skill path --api-key SECRET paths` treated
 * SECRET as a subcommand and printed it in an error.
 */
export function extractGlobalFlags(
	argv: ReadonlyArray<string>,
	isSubcommand: (token: string) => boolean = () => false,
): GlobalCliFlags {
	const rest: string[] = [];
	let apiKey: string | undefined;
	let noContextFiles = false;
	let noSkills = false;
	const skillPaths: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === undefined) continue;
		if (arg === "--") {
			rest.push(...argv.slice(i + 1));
			break;
		}
		if (!arg.startsWith("-")) {
			rest.push(...argv.slice(i));
			break;
		}
		if (ROOT_FLAG_TOKENS.has(arg)) {
			rest.push(arg);
			continue;
		}
		if (arg === "--no-context-files" || arg === "-nc") {
			noContextFiles = true;
			continue;
		}
		if (arg === "--no-skills") {
			noSkills = true;
			continue;
		}
		if (arg === "--api-key" || arg === "--skill") {
			const value = argv[i + 1];
			if (value === undefined || value.startsWith("-") || isSubcommand(value)) {
				return {
					noContextFiles,
					noSkills,
					skillPaths,
					rest,
					error: `${arg} requires a value`,
					...(apiKey === undefined ? {} : { apiKey }),
				};
			}
			if (arg === "--api-key") apiKey = value;
			else skillPaths.push(value);
			i += 1;
			continue;
		}
		return {
			noContextFiles,
			noSkills,
			skillPaths,
			rest,
			error: `unknown global option: ${arg}`,
			...(apiKey === undefined ? {} : { apiKey }),
		};
	}
	return {
		noContextFiles,
		noSkills,
		skillPaths,
		rest,
		...(apiKey === undefined ? {} : { apiKey }),
	};
}
