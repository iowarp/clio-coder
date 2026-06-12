import { existsSync } from "node:fs";
import { resolveClioDirs } from "../core/xdg.js";
import { printError } from "./shared.js";

const HELP = `clio paths [--json]

Print the resolved Clio Coder directories. Read-only: nothing is created.
This is the single source of truth for scripts; parse the --json form instead
of re-implementing the resolution rules.

Resolution order per directory: CLIO_CONFIG_DIR / CLIO_DATA_DIR /
CLIO_STATE_DIR / CLIO_CACHE_DIR beat CLIO_HOME, which beats the platform
defaults (XDG base dirs on Linux).
`;

export function runPathsCommand(args: ReadonlyArray<string> = []): number {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	const json = args.includes("--json");
	const unknown = args.find((arg) => arg !== "--json");
	if (unknown) {
		printError(`unknown flag: ${unknown}`);
		process.stdout.write(HELP);
		return 2;
	}
	const dirs = resolveClioDirs();
	if (json) {
		process.stdout.write(
			`${JSON.stringify({ config: dirs.config, data: dirs.data, state: dirs.state, cache: dirs.cache }, null, 2)}\n`,
		);
		return 0;
	}
	for (const [label, path] of [
		["config", dirs.config],
		["data", dirs.data],
		["state", dirs.state],
		["cache", dirs.cache],
	] as const) {
		process.stdout.write(`${label.padEnd(8)} ${path}${existsSync(path) ? "" : "  (absent)"}\n`);
	}
	return 0;
}
