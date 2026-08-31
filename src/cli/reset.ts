import { type Dirent, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { initializeClioHome } from "../core/init.js";
import { resetXdgCache, resolveClioDirs } from "../core/xdg.js";
import { type RemovalFailure, removePath, reportRemovalFailures } from "./removal.js";
import { printError, printHeader, printOk } from "./shared.js";
import { terminalColumns, wrapPlain } from "./text-layout.js";

const HELP = `clio-coder reset [--state|--data|--cache|--auth|--config|--all] [--dry-run] [--force]

Recover or wipe Clio Coder state while keeping the clio binary installed.
Each level clears exactly the root (or file) it names and nothing else.

Levels (combinable except --all):
  --state       state root only (default). Holds every session transcript, so a
                reset is the end of resume, /view, and the audit behind them.
  --data        data root only: memory, evidence, evals, vendored tools (durable products)
  --cache       cache root only
  --auth        credentials.yaml only
  --config      settings.yaml only
  --all         all four roots: config, data, state, and cache

Every run reads each selected root and lists what is inside it before removing
anything, so what a level covers is read off that listing rather than off this
text. --dry-run prints the same listing and changes nothing.

Safety:
  --force       required for destructive execution
  --dry-run     print what would be reset without changing anything
`;

/**
 * What losing a root costs, printed under it in the same listing the removal
 * works from.
 *
 * `--data` carried this and `--state` did not, which is backwards: `--state` is
 * what a bare `clio-coder reset` selects, so the one scope that runs without being
 * asked for by name was the one that explained nothing before taking every
 * transcript on the machine.
 */
const ROOT_NOTES: Readonly<Record<string, string>> = {
	state:
		"the state root holds every session transcript and the audit trail beside it; resume and /view lose their history",
	// Vendored tools are named because they are the one durable product a reset
	// cannot regenerate from anything local: getting them back is a download.
	data:
		"the data root holds durable products (memory, evidence, evals, and any vendored external tools, which a reinstall re-downloads)",
};

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

/**
 * The immediate children of `path`, each directory carrying how many entries
 * are inside it. Empty for a file, an absent path, or an unreadable one.
 *
 * This is the inventory, read off the disk on the run that is about to remove
 * it. `--help` used to carry a remembered one, "sessions, audit, receipts,
 * runs, install metadata", which named five things and omitted `interviews/`,
 * `scratch/`, and every dispatch artifact written since that sentence was
 * typed. A list nobody has to maintain cannot drift from what the removal takes.
 */
export function rootContents(path: string): string[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(path, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.map((entry) => {
			if (!entry.isDirectory()) return entry.name;
			let count: number;
			try {
				count = readdirSync(join(path, entry.name)).length;
			} catch {
				return `${entry.name}/`;
			}
			return `${entry.name}/ (${count})`;
		})
		.sort((left, right) => left.localeCompare(right));
}

/** Write `text` indented under a root line, wrapped to the terminal. */
function writeIndented(text: string, indent: number): void {
	const [first = "", ...rest] = wrapPlain(text, Math.max(20, terminalColumns() - indent), indent);
	process.stdout.write(`${" ".repeat(indent)}${first}\n`);
	for (const line of rest) process.stdout.write(`${line}\n`);
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
	return `clio-coder reset ${levels.join(" ")} --force`;
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
		printError("`clio-coder reset` requires --force unless you are using --dry-run");
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
	const selected: Array<{ label: string; path: string }> = args.all
		? [
				{ label: "config", path: dirs.config },
				{ label: "data", path: dirs.data },
				{ label: "state", path: dirs.state },
				{ label: "cache", path: dirs.cache },
			]
		: [
				...(args.config ? [{ label: "settings", path: settingsPath }] : []),
				...(args.auth ? [{ label: "credentials", path: credentialsPath }] : []),
				...(args.data ? [{ label: "data", path: dirs.data }] : []),
				...(args.state ? [{ label: "state", path: dirs.state }] : []),
				...(args.cache ? [{ label: "cache", path: dirs.cache }] : []),
			];

	// The note is a property of the root, not of the flag that selected it, so
	// `--all` and the named scope say the same thing about the same directory.
	for (const entry of selected) {
		report(entry.label, entry.path);
		const contents = rootContents(entry.path);
		if (contents.length > 0) writeIndented(contents.join(", "), 4);
		const note = ROOT_NOTES[entry.label];
		if (note) writeIndented(`note: ${note}`, 2);
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
