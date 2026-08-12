import { existsSync } from "node:fs";
import { join } from "node:path";

import { initializeClioHome } from "../core/init.js";
import { resetXdgCache, resolveClioDirs } from "../core/xdg.js";
import { type RemovalFailure, removePath, reportRemovalFailures } from "./removal.js";
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

/** Reconstruct the invocation to rerun after a partial failure. */
function resetInvocation(args: ParsedResetArgs): string {
	const levels = (
		[
			["all", args.all],
			["config", args.config],
			["auth", args.auth],
			["data", args.data],
			["state", args.state],
			["cache", args.cache],
		] as const
	)
		.filter(([, on]) => on)
		.map(([name]) => `--${name}`);
	return `clio reset ${levels.join(" ")} --force`;
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

	// Announce every selected path first, then delete. A failure partway
	// through therefore never leaves the operator guessing which paths the
	// command had reached, and the dry run prints the identical list.
	const selected: Array<{ label: string; path: string; note?: string }> = args.all
		? [
				{ label: "config", path: dirs.config },
				{ label: "data", path: dirs.data },
				{ label: "state", path: dirs.state },
				{ label: "cache", path: dirs.cache },
			]
		: [
				...(args.config ? [{ label: "settings", path: settingsPath }] : []),
				...(args.auth ? [{ label: "credentials", path: credentialsPath }] : []),
				...(args.data
					? [
							{
								label: "data",
								path: dirs.data,
								note: "  note: the data root holds durable products (memory, evidence, evals)\n",
							},
						]
					: []),
				...(args.state ? [{ label: "state", path: dirs.state }] : []),
				...(args.cache ? [{ label: "cache", path: dirs.cache }] : []),
			];

	for (const entry of selected) {
		report(entry.label, entry.path);
		if (entry.note) process.stdout.write(entry.note);
	}

	const failures: RemovalFailure[] = [];
	for (const entry of selected) {
		const failure = removePath(entry.label, entry.path, args.dryRun);
		if (failure) failures.push(failure);
	}

	resetXdgCache();
	// Bootstrapping runs even after a partial failure: the roots that were
	// removed still need their skeleton back, and it is idempotent for the ones
	// that survived.
	if (!args.dryRun) initializeClioHome();

	if (failures.length > 0) {
		printError("reset did not remove everything");
		reportRemovalFailures(resetInvocation(args), failures);
		return 1;
	}

	if (args.dryRun) {
		printOk(args.all ? "reset --all preview complete" : "reset preview complete");
	} else {
		printOk(args.all ? "reset config, data, state, and cache" : "reset complete");
	}
	return 0;
}
