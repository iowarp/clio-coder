import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { initializeClioHome } from "../core/init.js";
import { resetXdgCache, resolveClioDirs } from "../core/xdg.js";
import { printError, printHeader, printOk } from "./shared.js";

const HELP = `clio reset [--state|--auth|--config|--all] [--dry-run] [--force]

Recover or wipe Clio state while keeping the clio binary installed.

Modes:
  --state       reset data and cache only (default)
  --auth        reset stored credentials only
  --config      reset settings.yaml only
  --all         reset config, data, and cache to fresh defaults

Safety:
  --force       required for destructive execution
  --dry-run     print what would be reset without changing anything
`;

interface ParsedResetArgs {
	state: boolean;
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
	if (!parsed.help && parsed.all && (parsed.state || parsed.auth || parsed.config)) {
		throw new Error("--all cannot be combined with --state, --auth, or --config");
	}
	if (!parsed.help && !parsed.all && !parsed.state && !parsed.auth && !parsed.config) {
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

	printHeader("clio reset");
	if (args.all) {
		report("config", dirs.config);
		report("data", dirs.data);
		report("cache", dirs.cache);
		removePath(dirs.config, args.dryRun);
		removePath(dirs.data, args.dryRun);
		removePath(dirs.cache, args.dryRun);
		resetXdgCache();
		if (!args.dryRun) initializeClioHome();
		printOk(args.dryRun ? "reset --all preview complete" : "reset config, data, and cache");
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
	if (args.state) {
		report("data", dirs.data);
		report("cache", dirs.cache);
		removePath(dirs.data, args.dryRun);
		removePath(dirs.cache, args.dryRun);
	}

	resetXdgCache();
	if (!args.dryRun) initializeClioHome();
	printOk(args.dryRun ? "reset preview complete" : "reset complete");
	return 0;
}
