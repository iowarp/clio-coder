import { type Dirent, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { initializeClioHome } from "../core/init.js";
import { resetXdgCache, resolveClioDirs } from "../core/xdg.js";
import { createLifecyclePresenter, type LifecycleItem, measurePath } from "./lifecycle-presenter.js";
import { type RemovalFailure, removePath, reportRemovalFailures } from "./removal.js";
import { printError } from "./shared.js";

const HELP = `clio-coder reset [--state|--data|--cache|--auth|--config|--all] [--dry-run] [--force] [--json]

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

Safety:
  --force, -f   required for destructive execution in non-interactive environments
  --dry-run     print what would be reset without changing anything
  --json        emit machine-readable JSON output
  --help, -h    show this message
`;

const ROOT_NOTES: Readonly<Record<string, string>> = {
	state:
		"the state root holds every session transcript and the audit trail beside it; resume and /view lose their history",
	data:
		"the data root holds durable products (memory, evidence, evals, and vendored tools, which must be re-downloaded)",
	config: "reverts settings.yaml preferences to default",
	auth: "removes saved API keys and credentials in credentials.yaml",
	cache: "clears disposable temporary caches",
	all: "wipes all local state, caches, settings, and credentials, then bootstraps a clean default environment",
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

function rootContents(path: string): string[] {
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

function launcherLinkPath(): string {
	const binDir = process.env.CLIO_CODER_BIN_DIR?.trim() || join(homedir(), ".local", "bin");
	return join(binDir, "clio-coder");
}

export async function runResetCommand(argv: ReadonlyArray<string>): Promise<number> {
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

	const isInteractive = Boolean(process.stdin.isTTY);
	if (!args.dryRun && !args.force && !isInteractive) {
		printError("`clio-coder reset` requires confirmation or --force in non-interactive environments");
		process.stdout.write(HELP);
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
	const binPath = launcherLinkPath();
	const binSize = measurePath(binPath);

	const items: LifecycleItem[] = [];

	// State
	if (resetState) {
		const contents = rootContents(dirs.state);
		const detail = contents.length > 0 ? contents.slice(0, 4).join(", ") + (contents.length > 4 ? "..." : "") : undefined;
		items.push({
			label: "State",
			path: dirs.state,
			bytes: stateSize.bytes,
			status: stateSize.exists ? "remove" : "absent",
			detail,
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

	// Binary launcher always survives reset
	items.push({
		label: "Binary",
		path: binPath,
		bytes: binSize.bytes,
		status: binSize.exists ? "keep" : "absent",
		detail: binSize.exists ? "survives" : undefined,
	});

	presenter.listItems("State and components inventory", items);

	// Print note about what will be reset and what survives
	const activeNotes = [
		resetState ? ROOT_NOTES.state : null,
		resetData ? ROOT_NOTES.data : null,
		args.config ? ROOT_NOTES.config : null,
		args.auth ? ROOT_NOTES.auth : null,
		args.all ? ROOT_NOTES.all : null,
	].filter((n): n is string => Boolean(n));

	for (const note of activeNotes) {
		presenter.rail(`Note: ${note}`);
	}

	const survivingItems = items.filter((item) => item.status === "keep").map((item) => item.label);
	if (survivingItems.length > 0) {
		presenter.rail(`Surviving components: ${survivingItems.join(", ")}`);
	}
	presenter.rail();

	if (args.dryRun) {
		presenter.warn("Dry run - no changes made");
		presenter.done(args.all ? "reset --all preview complete" : "reset preview complete");
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
			{ label: "config", path: dirs.config },
			{ label: "data", path: dirs.data },
			{ label: "state", path: dirs.state },
			{ label: "cache", path: dirs.cache },
		);
	} else {
		if (args.config) toRemove.push({ label: "settings", path: settingsPath });
		if (args.auth) toRemove.push({ label: "credentials", path: credentialsPath });
		if (args.data) toRemove.push({ label: "data", path: dirs.data });
		if (args.state) toRemove.push({ label: "state", path: dirs.state });
		if (args.cache) toRemove.push({ label: "cache", path: dirs.cache });
	}

	const failures: RemovalFailure[] = [];
	for (const entry of toRemove) {
		const failure = removePath(entry.label, entry.path, false);
		if (failure) failures.push(failure);
		else presenter.completedStep(`Reset ${entry.label}`);
	}

	resetXdgCache();
	initializeClioHome();
	presenter.completedStep("Bootstrapped fresh environment skeletons");

	if (failures.length > 0) {
		presenter.fail("reset did not remove everything");
		reportRemovalFailures(resetInvocation(args), failures);
		return 1;
	}

	presenter.done(args.all ? "reset config, data, state, and cache" : "reset complete");
	return 0;
}
