import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_SETTINGS_YAML } from "../core/defaults.js";
import { initializeClioHome } from "../core/init.js";
import { resetXdgCache, resolveClioDirs } from "../core/xdg.js";
import { printError, printHeader, printOk } from "./shared.js";

const HELP = `clio uninstall

Usage:
  clio uninstall --full --yes
  clio uninstall --keep-settings --yes
  clio uninstall --reset-defaults --yes
  clio uninstall --full --dry-run

Modes:
  --full            remove config, data, and cache directories
  --keep-settings   remove data and cache, keep the config directory intact
  --reset-defaults  wipe state, then recreate a fresh default install

Safety:
  --yes             required for destructive execution
  --dry-run         print what would be removed without changing anything
`;

interface ParsedUninstallArgs {
	full: boolean;
	keepSettings: boolean;
	resetDefaults: boolean;
	yes: boolean;
	dryRun: boolean;
	help: boolean;
}

function parseUninstallArgs(argv: ReadonlyArray<string>): ParsedUninstallArgs {
	const out: ParsedUninstallArgs = {
		full: false,
		keepSettings: false,
		resetDefaults: false,
		yes: false,
		dryRun: false,
		help: false,
	};
	for (const arg of argv) {
		switch (arg) {
			case "--full":
				out.full = true;
				break;
			case "--keep-settings":
				out.keepSettings = true;
				break;
			case "--reset-defaults":
				out.resetDefaults = true;
				break;
			case "--yes":
			case "-y":
				out.yes = true;
				break;
			case "--dry-run":
				out.dryRun = true;
				break;
			case "--help":
			case "-h":
				out.help = true;
				break;
			default:
				throw new Error(`unknown flag: ${arg}`);
		}
	}
	const modes = [out.full, out.keepSettings, out.resetDefaults].filter(Boolean).length;
	if (!out.help && modes !== 1) {
		throw new Error("choose exactly one uninstall mode: --full, --keep-settings, or --reset-defaults");
	}
	return out;
}

function removePath(path: string, dryRun: boolean): void {
	if (!existsSync(path)) return;
	if (dryRun) return;
	rmSync(path, { recursive: true, force: true });
}

function reportAction(label: string, path: string, exists: boolean): void {
	process.stdout.write(`  ${label.padEnd(14)} ${path}${exists ? "" : "  (absent)"}\n`);
}

export function runUninstallCommand(argv: ReadonlyArray<string>): number {
	let args: ParsedUninstallArgs;
	try {
		args = parseUninstallArgs(argv);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		process.stdout.write(HELP);
		return 2;
	}
	if (args.help) {
		process.stdout.write(HELP);
		return 0;
	}
	if (!args.dryRun && !args.yes) {
		printError("`clio uninstall` requires --yes unless you are using --dry-run");
		process.stdout.write(HELP);
		return 2;
	}

	const dirs = resolveClioDirs();
	const settingsPath = join(dirs.config, "settings.yaml");
	const credentialsPath = join(dirs.config, "credentials.yaml");

	printHeader("clio uninstall");
	reportAction("config", dirs.config, existsSync(dirs.config));
	reportAction("data", dirs.data, existsSync(dirs.data));
	reportAction("cache", dirs.cache, existsSync(dirs.cache));

	if (args.full) {
		process.stdout.write(args.dryRun ? "mode: full (dry-run)\n" : "mode: full\n");
		removePath(dirs.config, args.dryRun);
		removePath(dirs.data, args.dryRun);
		removePath(dirs.cache, args.dryRun);
		printOk(args.dryRun ? "full uninstall preview complete" : "removed config, data, and cache");
		resetXdgCache();
		return 0;
	}

	if (args.keepSettings) {
		process.stdout.write(args.dryRun ? "mode: keep-settings (dry-run)\n" : "mode: keep-settings\n");
		removePath(dirs.data, args.dryRun);
		removePath(dirs.cache, args.dryRun);
		printOk(args.dryRun ? "keep-settings preview complete" : "removed data and cache; kept config");
		resetXdgCache();
		return 0;
	}

	process.stdout.write(args.dryRun ? "mode: reset-defaults (dry-run)\n" : "mode: reset-defaults\n");
	if (args.dryRun) {
		reportAction("settings", settingsPath, existsSync(settingsPath));
		reportAction("credentials", credentialsPath, existsSync(credentialsPath));
		printOk("reset-defaults preview complete");
		return 0;
	}

	removePath(dirs.config, false);
	removePath(dirs.data, false);
	removePath(dirs.cache, false);
	resetXdgCache();
	const report = initializeClioHome();
	printOk("recreated a fresh default install");
	process.stdout.write(`  settings       ${join(report.configDir, "settings.yaml")}\n`);
	process.stdout.write(`  credentials    ${join(report.configDir, "credentials.yaml")}\n`);
	process.stdout.write(`  defaultSeeded  ${DEFAULT_SETTINGS_YAML.split("\n")[0] ?? "yes"}\n`);
	return 0;
}
