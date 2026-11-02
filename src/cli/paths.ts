import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { clioProjectRoot } from "../core/project-root.js";
import { resolveClioDirs } from "../core/xdg.js";
import {
	defaultInstallRoot,
	inactiveInstallerRecord,
	inspectInstallation,
	launcherPathFor,
} from "../domains/lifecycle/install-method.js";
import { printError } from "./shared.js";

const HELP = `clio-coder paths [--json]

Print where Clio Coder lives, from this directory. Read-only: nothing is created.
This is the single source of truth for scripts; parse the --json form instead
of re-implementing the resolution rules.

  config, data, state, cache   the four per-user roots
  install    the installer root, and whether this binary runs from it
  launcher   the clio-coder launcher that belongs to this installation
  project    where a new project .clio-coder/ entry goes from here. Each existing
             entry comes from the nearest .clio-coder/ that has it, up to the
             repository root.

Resolution order per root: CLIO_CODER_CONFIG_DIR / CLIO_CODER_DATA_DIR /
CLIO_CODER_STATE_DIR / CLIO_CODER_CACHE_DIR beat CLIO_CODER_HOME, which beats the platform
defaults (XDG base dirs on Linux).
`;

function launcherNote(path: string): string {
	try {
		if (lstatSync(path).isSymbolicLink()) return `  -> ${readlinkSync(path)}`;
		return "";
	} catch {
		return "  (absent)";
	}
}

export function runPathsCommand(args: ReadonlyArray<string> = []): number {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	const json = args.includes("--json");
	const unknown = args.find((arg) => arg !== "--json");
	if (unknown) {
		printError(`unknown flag: ${unknown}`);
		process.stderr.write(HELP);
		return 2;
	}
	const dirs = resolveClioDirs();
	const installation = inspectInstallation();
	const install = installation.installer?.root ?? inactiveInstallerRecord(installation)?.root ?? defaultInstallRoot();
	const installActive = installation.installer !== undefined;
	const launcher = launcherPathFor(installation);
	const project = clioProjectRoot(process.cwd());
	if (json) {
		process.stdout.write(
			`${JSON.stringify(
				{
					config: dirs.config,
					data: dirs.data,
					state: dirs.state,
					cache: dirs.cache,
					install,
					installActive,
					launcher,
					project,
				},
				null,
				2,
			)}\n`,
		);
		return 0;
	}
	const absent = (path: string): string => (existsSync(path) ? "" : "  (absent)");
	const installNote = !existsSync(install)
		? "  (absent)"
		: installActive
			? "  (running from here)"
			: "  (not running from here)";
	const rows: ReadonlyArray<readonly [string, string]> = [
		["config", `${dirs.config}${absent(dirs.config)}`],
		["data", `${dirs.data}${absent(dirs.data)}`],
		["state", `${dirs.state}${absent(dirs.state)}`],
		["cache", `${dirs.cache}${absent(dirs.cache)}`],
		["install", `${install}${installNote}`],
		["launcher", `${launcher}${launcherNote(launcher)}`],
		["project", `${project}${existsSync(join(project, ".clio-coder")) ? "" : "  (no .clio-coder/ yet)"}`],
	];
	for (const [label, value] of rows) process.stdout.write(`${label.padEnd(8)} ${value}\n`);
	return 0;
}
