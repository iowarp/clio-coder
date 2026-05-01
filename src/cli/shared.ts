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

/**
 * Pull the optional top-level `--api-key <value>` startup flag out of argv.
 * Only flags before the first subcommand are global; after the first
 * positional token, `--api-key` belongs to that subcommand (for example
 * `clio auth login openai --api-key ...` or `clio configure --api-key ...`).
 */
export function extractApiKeyFlag(argv: ReadonlyArray<string>): { apiKey?: string; rest: string[] } {
	const rest: string[] = [];
	let apiKey: string | undefined;
	let sawSubcommand = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (sawSubcommand || arg !== "--api-key") {
			if (arg !== undefined) rest.push(arg);
			if (arg !== undefined && !arg.startsWith("-")) sawSubcommand = true;
			continue;
		}
		const value = argv[i + 1];
		if (value === undefined || value.startsWith("-")) continue;
		apiKey = value;
		i += 1;
	}
	return apiKey === undefined ? { rest } : { apiKey, rest };
}

/**
 * Pre-extract the top-level `--no-context-files` (alias `-nc`) flag from argv
 * before subcommand parsing. Like `extractApiKeyFlag`, only flags before the
 * first positional token are global; later occurrences pass through in `rest`
 * so the subcommand can decide what to do with them. Unlike `extractApiKeyFlag`
 * (which returns an optional string), this returns `noContextFiles: boolean`
 * always (default `false`) because the flag is a binary toggle without an
 * associated value. Consumed in `bootOrchestrator` to suppress the prompts
 * domain `context.files` dynamic fragment.
 */
export function extractNoContextFilesFlag(argv: ReadonlyArray<string>): { noContextFiles: boolean; rest: string[] } {
	const rest: string[] = [];
	let noContextFiles = false;
	let sawSubcommand = false;
	for (const arg of argv) {
		if (arg === undefined) continue;
		if (!sawSubcommand && (arg === "--no-context-files" || arg === "-nc")) {
			noContextFiles = true;
			continue;
		}
		rest.push(arg);
		if (!arg.startsWith("-")) sawSubcommand = true;
	}
	return { noContextFiles, rest };
}
