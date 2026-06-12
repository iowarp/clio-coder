import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { initializeClioHome } from "../core/init.js";
import { resetXdgCache, resolveClioDirs } from "../core/xdg.js";
import { printError, printHeader, printOk } from "./shared.js";

const HELP = `clio reset [--state|--data|--cache|--auth|--config|--all] [--dry-run] [--force]

Recover or wipe Clio Coder state while keeping the clio binary installed.
Each level clears exactly the root (or file) it names and nothing else.

Levels (combinable except --all):
  --state       state root only: sessions, audit, receipts, runs, install metadata (default)
  --data        data root only: memory, evidence, evals (durable products)
  --cache       cache root only
  --auth        credentials.yaml only
  --config      settings.yaml only
  --all         all four roots: config, data, state, and cache

Safety:
  --force       required for destructive execution
  --dry-run     print what would be reset without changing anything
`;

interface ParsedResetArgs {
	state: boolean;
	data: boolean;
	cache: boolean;
	auth: boolean;
	config: boolean;
	all: boolean;
	force: boolean;
	dryRun: boolean;
	help: boolean;
}

function parseResetArgs(argv: ReadonlyArray<string>): ParsedResetArgs {
	const parsed: ParsedResetArgs = {
		state: false,
		data: false,
		cache: false,
		auth: false,
		config: false,
		all: false,
		force: false,
		dryRun: false,
		help: false,
	};
	for (const arg of argv) {
		switch (arg) {
			case "--state":
				parsed.state = true;
				break;
			case "--data":
				parsed.data = true;
				break;
			case "--cache":
				parsed.cache = true;
				break;
			case "--auth":
				parsed.auth = true;
				break;
			case "--config":
				parsed.config = true;
				break;
			case "--all":
				parsed.all = true;
				break;
			case "--force":
			case "-f":
				parsed.force = true;
				break;
			case "--dry-run":
				parsed.dryRun = true;
				break;
			case "--help":
			case "-h":
				parsed.help = true;
				break;
			default:
				throw new Error(`unknown flag: ${arg}`);
		}
	}
	const levels = [parsed.state, parsed.data, parsed.cache, parsed.auth, parsed.config];
	if (!parsed.help && parsed.all && levels.some(Boolean)) {
		throw new Error("--all cannot be combined with --state, --data, --cache, --auth, or --config");
	}
	if (!parsed.help && !parsed.all && !levels.some(Boolean)) {
		parsed.state = true;
	}
	return parsed;
}

function report(label: string, path: string): void {
	process.stdout.write(`  ${label.padEnd(12)} ${path}${existsSync(path) ? "" : "  (absent)"}\n`);
}

function removePath(path: string, dryRun: boolean): void {
	if (!existsSync(path) || dryRun) return;
	rmSync(path, { recursive: true, force: true });
}

export function runResetCommand(argv: ReadonlyArray<string>): number {
	let args: ParsedResetArgs;
	try {
		args = parseResetArgs(argv);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		process.stdout.write(HELP);
		return 2;
	}
	if (args.help) {
		process.stdout.write(HELP);
		return 0;
	}
	if (!args.dryRun && !args.force) {
		printError("`clio reset` requires --force unless you are using --dry-run");
		process.stdout.write(HELP);
		return 2;
	}

	const dirs = resolveClioDirs();
	const settingsPath = join(dirs.config, "settings.yaml");
	const credentialsPath = join(dirs.config, "credentials.yaml");

	printHeader("Clio Coder reset");
	if (args.all) {
		report("config", dirs.config);
		report("data", dirs.data);
		report("state", dirs.state);
		report("cache", dirs.cache);
		removePath(dirs.config, args.dryRun);
		removePath(dirs.data, args.dryRun);
		removePath(dirs.state, args.dryRun);
		removePath(dirs.cache, args.dryRun);
		resetXdgCache();
		if (!args.dryRun) initializeClioHome();
		printOk(args.dryRun ? "reset --all preview complete" : "reset config, data, state, and cache");
		return 0;
	}

	if (args.config) {
		report("settings", settingsPath);
		removePath(settingsPath, args.dryRun);
	}
	if (args.auth) {
		report("credentials", credentialsPath);
		removePath(credentialsPath, args.dryRun);
	}
	if (args.data) {
		report("data", dirs.data);
		process.stdout.write("  note: the data root holds durable products (memory, evidence, evals)\n");
		removePath(dirs.data, args.dryRun);
	}
	if (args.state) {
		report("state", dirs.state);
		removePath(dirs.state, args.dryRun);
	}
	if (args.cache) {
		report("cache", dirs.cache);
		removePath(dirs.cache, args.dryRun);
	}

	resetXdgCache();
	if (!args.dryRun) initializeClioHome();
	printOk(args.dryRun ? "reset preview complete" : "reset complete");
	return 0;
}
