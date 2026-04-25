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
 * Pull the optional top-level `--no-context-files` (alias `-nc`) startup flag
 * out of argv. Mirrors `extractApiKeyFlag`: only flags before the first
 * subcommand are global; after the first positional token the flag is left in
 * place so the subcommand can decide what to do with it.
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
