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
 * Pull the optional `--api-key <value>` startup flag out of argv. Returned
 * `rest` preserves order and drops the flag pair so downstream parsers (the
 * subcommand router, `clio run`, etc.) never see it. The value may be an empty
 * string if the user passed `--api-key` without an argument or with `--`; in
 * that case we treat the flag as absent and leave the next arg untouched.
 */
export function extractApiKeyFlag(argv: ReadonlyArray<string>): { apiKey?: string; rest: string[] } {
	const rest: string[] = [];
	let apiKey: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg !== "--api-key") {
			if (arg !== undefined) rest.push(arg);
			continue;
		}
		const value = argv[i + 1];
		if (value === undefined || value.startsWith("-")) continue;
		apiKey = value;
		i += 1;
	}
	return apiKey === undefined ? { rest } : { apiKey, rest };
}
