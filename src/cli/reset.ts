import { type Dirent, readdirSync } from "node:fs";
import { join } from "node:path";

import { initializeClioHome } from "../core/init.js";
import { resetXdgCache, resolveClioDirs } from "../core/xdg.js";
import { createLifecyclePresenter, type LifecycleItem, measurePath } from "./lifecycle-presenter.js";
import { type RemovalFailure, removePath, reportRemovalFailures } from "./removal.js";
import { printError } from "./shared.js";

const HELP = `clio-coder reset [--state|--data|--cache|--auth|--config|--all] [--dry-run] [--force] [--json]

Recover or wipe Clio Coder state while keeping the clio-coder launcher installed.
Each level clears exactly the root (or file) it names and nothing else, then the
empty roots are recreated so the next run has somewhere to write.

Levels (combinable except --all):
  --state       state root only (default). Holds every session transcript, so a
                reset is the end of resume, /view, and the audit behind them.
  --data        data root only: memory, evidence, evals, vendored tools (durable products)
  --cache       cache root only
  --auth        credentials.yaml only
  --config      settings.yaml only
  --all         all four roots whole: config (settings, credentials, and anything
                else under it), data, state, and cache

Safety:
  --force, -f   required for destructive execution in non-interactive environments
  --dry-run     print what would be reset without changing anything
  --json        emit machine-readable JSON output
  --help, -h    show this message
`;

const ROOT_NOTES = {
	state: "State holds every session transcript and the audit trail; resume and /view lose their history.",
	data: "Data holds memory, evidence, evals, and vendored tools; the tools have to be downloaded again.",
	config: "Settings return to their defaults.",
	auth: "Saved API keys are gone; each target has to be authenticated again.",
	cache: "Cache is disposable and rebuilds itself.",
	all: "Everything goes: settings, credentials, memory, evidence, transcripts, and caches. A clean install remains.",
} as const;

interface ParsedResetArgs {
	state: boolean;
	data: boolean;
	cache: boolean;
	auth: boolean;
	config: boolean;
	all: boolean;
	force: boolean;
	dryRun: boolean;
	json: boolean;
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
		json: false,
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
			case "--json":
				parsed.json = true;
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

/**
 * What sits directly under a root, named so the operator recognizes what the
 * reset takes. Directories keep their trailing slash; the list is capped so one
 * crowded root cannot push the decision off the screen.
 */
function rootContents(path: string, limit = 4): string | undefined {
	let entries: Dirent[];
	try {
		entries = readdirSync(path, { withFileTypes: true });
	} catch {
		return undefined;
	}
	if (entries.length === 0) return undefined;
	const names = entries
		.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
		.sort((left, right) => left.localeCompare(right));
	const shown = names.slice(0, limit).join(", ");
	return names.length > limit ? `${shown}, +${names.length - limit} more` : shown;
}

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

export async function runResetCommand(argv: ReadonlyArray<string>): Promise<number> {
	let args: ParsedResetArgs;
	try {
		args = parseResetArgs(argv);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		process.stderr.write(HELP);
		return 2;
	}
	if (args.help) {
		process.stdout.write(HELP);
		return 0;
	}

	// One sentence, and nothing on stdout: a caller that piped this run is
	// parsing stdout, and a help dump there is indistinguishable from output.
	const isInteractive = Boolean(process.stdin.isTTY);
	if (!args.dryRun && !args.force && !isInteractive) {
		printError("`clio-coder reset` needs a terminal to confirm; pass --force to skip the prompt");
		return 2;
	}

	const dirs = resolveClioDirs();
	const settingsPath = join(dirs.config, "settings.yaml");
	const credentialsPath = join(dirs.config, "credentials.yaml");
	const presenter = createLifecyclePresenter({ json: args.json });

	presenter.header("Reset Clio Coder", "reset");

	// Determine scopes to clear
	const resetData = args.all || args.data;
	const resetState = args.all || args.state;
	const resetCache = args.all || args.cache;

	const configSize = measurePath(dirs.config);
	const dataSize = measurePath(dirs.data);
	const stateSize = measurePath(dirs.state);
	const cacheSize = measurePath(dirs.cache);

	const items: LifecycleItem[] = [];

	// State
	if (resetState) {
		items.push({
			label: "State",
			path: dirs.state,
			bytes: stateSize.bytes,
			status: stateSize.exists ? "remove" : "absent",
			detail: rootContents(dirs.state),
		});
	} else {
		items.push({
			label: "State",
			path: dirs.state,
			bytes: stateSize.bytes,
			status: stateSize.exists ? "keep" : "absent",
			detail: stateSize.exists ? "survives" : undefined,
		});
	}

	// Data
	if (resetData) {
		items.push({
			label: "Data",
			path: dirs.data,
			bytes: dataSize.bytes,
			status: dataSize.exists ? "remove" : "absent",
		});
	} else {
		items.push({
			label: "Data",
			path: dirs.data,
			bytes: dataSize.bytes,
			status: dataSize.exists ? "keep" : "absent",
			detail: dataSize.exists ? "survives" : undefined,
		});
	}

	// Config / settings / auth
	if (args.all) {
		items.push({
			label: "Config",
			path: dirs.config,
			bytes: configSize.bytes,
			status: configSize.exists ? "remove" : "absent",
		});
	} else {
		const stSettings = measurePath(settingsPath);
		if (args.config) {
			items.push({
				label: "Settings",
				path: settingsPath,
				bytes: stSettings.bytes,
				status: stSettings.exists ? "remove" : "absent",
			});
		} else {
			items.push({
				label: "Settings",
				path: settingsPath,
				bytes: stSettings.bytes,
				status: stSettings.exists ? "keep" : "absent",
				detail: stSettings.exists ? "survives" : undefined,
			});
		}

		const stCreds = measurePath(credentialsPath);
		if (args.auth) {
			items.push({
				label: "Credentials",
				path: credentialsPath,
				bytes: stCreds.bytes,
				status: stCreds.exists ? "remove" : "absent",
			});
		} else {
			items.push({
				label: "Credentials",
				path: credentialsPath,
				bytes: stCreds.bytes,
				status: stCreds.exists ? "keep" : "absent",
				detail: stCreds.exists ? "survives" : undefined,
			});
		}
	}

	// Cache
	if (resetCache) {
		items.push({
			label: "Cache",
			path: dirs.cache,
			bytes: cacheSize.bytes,
			status: cacheSize.exists ? "remove" : "absent",
		});
	} else {
		items.push({
			label: "Cache",
			path: dirs.cache,
			bytes: cacheSize.bytes,
			status: cacheSize.exists ? "keep" : "absent",
			detail: cacheSize.exists ? "survives" : undefined,
		});
	}

	// The launcher is not listed. Reset never touches it, and a row for a path a
	// command cannot act on is one more line between the operator and the four
	// that decide whether to go ahead.
	presenter.listItems("The following will be cleared", items);

	// One consequence line, not one per scope. `--all` states the whole outcome,
	// so the per-root notes underneath it would only repeat it.
	const notes: string[] = args.all
		? [ROOT_NOTES.all]
		: [
				resetState ? ROOT_NOTES.state : null,
				resetData ? ROOT_NOTES.data : null,
				args.config ? ROOT_NOTES.config : null,
				args.auth ? ROOT_NOTES.auth : null,
			].filter((note): note is NonNullable<typeof note> => note !== null);
	for (const note of notes) presenter.note(note);

	// Only when something actually survives. On `--all` the note above already
	// says nothing does, and on a scoped reset over an empty home every row is
	// absent, which is not the same claim as "it was there and it is going".
	const surviving = items.filter((item) => item.status === "keep").map((item) => item.label);
	if (surviving.length > 0) presenter.note(`Survives: ${surviving.join(", ")}`);

	if (args.dryRun) {
		presenter.warn("Dry run: no changes made");
		presenter.done("Done");
		return 0;
	}

	if (!args.force) {
		const confirmed = await presenter.confirm("Are you sure you want to reset the selected state?", false);
		if (!confirmed) {
			presenter.warn("Reset cancelled");
			presenter.done("Cancelled");
			return 0;
		}
	}

	const toRemove: Array<{ label: string; path: string }> = [];
	if (args.all) {
		toRemove.push(
			{ label: "Config", path: dirs.config },
			{ label: "Data", path: dirs.data },
			{ label: "State", path: dirs.state },
			{ label: "Cache", path: dirs.cache },
		);
	} else {
		if (args.config) toRemove.push({ label: "Settings", path: settingsPath });
		if (args.auth) toRemove.push({ label: "Credentials", path: credentialsPath });
		if (args.data) toRemove.push({ label: "Data", path: dirs.data });
		if (args.state) toRemove.push({ label: "State", path: dirs.state });
		if (args.cache) toRemove.push({ label: "Cache", path: dirs.cache });
	}

	// `removePath` returns null both for a path it deleted and for one that was
	// never there, so presence is asked here. Announcing "Reset Cache" over an
	// absent cache is the one result line an operator cannot check.
	const failures: RemovalFailure[] = [];
	let cleared = 0;
	for (const entry of toRemove) {
		const existed = measurePath(entry.path).exists;
		const failure = removePath(entry.label, entry.path, false);
		if (failure) failures.push(failure);
		else if (existed) {
			presenter.completedStep(`Cleared ${entry.label}`);
			cleared += 1;
		}
	}
	if (failures.length === 0 && cleared === 0)
		presenter.completedStep("Nothing to clear; every selected root was already empty");

	resetXdgCache();
	initializeClioHome();
	presenter.completedStep("Recreated the empty roots");

	if (failures.length > 0) {
		presenter.fail("reset did not clear everything");
		reportRemovalFailures(resetInvocation(args), failures);
		presenter.finish();
		return 1;
	}

	presenter.done("Done");
	return 0;
}
