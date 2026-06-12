import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, sep } from "node:path";

import { resetXdgCache, resolveClioDirs } from "../core/xdg.js";
import { printError, printHeader, printOk } from "./shared.js";

const HELP = `clio uninstall [--remove-binary] [--dry-run] [--force]

Remove all Clio Coder state: the config, data, state, and cache roots.

Flags:
  --remove-binary  also remove the launcher symlink when it resolves into a clio dist
  --dry-run        print what would be removed without changing anything
  --force          required for destructive execution
`;

interface ParsedUninstallArgs {
	removeBinary: boolean;
	force: boolean;
	dryRun: boolean;
	help: boolean;
}

function parseUninstallArgs(argv: ReadonlyArray<string>): ParsedUninstallArgs {
	const parsed: ParsedUninstallArgs = {
		removeBinary: false,
		force: false,
		dryRun: false,
		help: false,
	};
	for (const arg of argv) {
		switch (arg) {
			case "--remove-binary":
				parsed.removeBinary = true;
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
	return parsed;
}

function report(label: string, path: string): void {
	process.stdout.write(`  ${label.padEnd(8)} remove ${path}${existsSync(path) ? "" : "  (absent)"}\n`);
}

function removePath(path: string, dryRun: boolean): void {
	if (!existsSync(path) || dryRun) return;
	rmSync(path, { recursive: true, force: true });
}

function launcherLinkPath(): string {
	const binDir = process.env.CLIO_BIN_DIR?.trim() || join(homedir(), ".local", "bin");
	return join(binDir, "clio");
}

/**
 * The launcher is removable only when it is a symlink whose target is the
 * built CLI entry inside a clio dist (the shape install-local.sh creates).
 * Anything else (a real file, a foreign symlink) is left in place. A dangling
 * link to a removed dist still qualifies via its raw readlink target.
 */
function removeLauncher(dryRun: boolean): void {
	const linkPath = launcherLinkPath();
	let isSymlink: boolean;
	try {
		isSymlink = lstatSync(linkPath).isSymbolicLink();
	} catch {
		process.stdout.write(`  binary   absent ${linkPath}\n`);
		return;
	}
	if (!isSymlink) {
		process.stdout.write(`  binary   keep   ${linkPath} (not a symlink; remove it via your package manager)\n`);
		return;
	}
	let target: string;
	try {
		target = realpathSync(linkPath);
	} catch {
		target = readlinkSync(linkPath);
	}
	if (!target.endsWith(join(sep, "dist", "cli", "index.js"))) {
		process.stdout.write(`  binary   keep   ${linkPath} (does not resolve into a clio dist: ${target})\n`);
		return;
	}
	process.stdout.write(`  binary   remove ${linkPath} -> ${target}\n`);
	if (!dryRun) rmSync(linkPath, { force: true });
}

function findClioOnPath(): string | null {
	const names = process.platform === "win32" ? ["clio.cmd", "clio.ps1", "clio.exe", "clio"] : ["clio"];
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		for (const name of names) {
			const candidate = join(dir, name);
			if (existsSync(candidate)) return candidate;
		}
	}
	return null;
}

function readNpmPrefix(): string | null {
	try {
		const result = spawnSync("npm", ["config", "get", "prefix"], {
			encoding: "utf8",
			timeout: 5000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		if (result.status !== 0) return null;
		const prefix = result.stdout.trim();
		return prefix.length > 0 ? prefix : null;
	} catch {
		return null;
	}
}

function printRemovalGuidance(): void {
	const pathClio = findClioOnPath();
	const npmPrefix = readNpmPrefix();
	const localLink = launcherLinkPath();
	const currentLauncher = process.argv[1];

	process.stdout.write("\nBinary removal guidance:\n");
	if (currentLauncher) process.stdout.write(`  current launcher: ${currentLauncher}\n`);
	process.stdout.write(`  PATH lookup:      ${pathClio ?? "not currently found"}\n`);
	if (npmPrefix) process.stdout.write(`  npm prefix bin:   ${join(npmPrefix, "bin")}\n`);
	process.stdout.write(`  local source bin: ${localLink}${existsSync(localLink) ? "" : "  (absent)"}\n`);
	process.stdout.write("\nUse the removal path that matches how you installed Clio Coder:\n");
	process.stdout.write(
		"  source symlink:  clio uninstall --remove-binary --force (or npm run uninstall:local -- --force)\n",
	);
	process.stdout.write("  npm global:      npm uninstall -g @iowarp/clio-coder\n");
	process.stdout.write("  npm link:        npm unlink -g @iowarp/clio-coder\n");
	process.stdout.write("\nAfter removing or replacing a clio link, clear shell command caches:\n");
	process.stdout.write("  hash -r   # Bash\n");
	process.stdout.write("  rehash    # Zsh\n");
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
	if (!args.dryRun && !args.force) {
		printError("`clio uninstall` requires --force unless you are using --dry-run");
		process.stdout.write(HELP);
		return 2;
	}

	const dirs = resolveClioDirs();
	printHeader("Clio Coder uninstall");
	report("config", dirs.config);
	report("data", dirs.data);
	report("state", dirs.state);
	report("cache", dirs.cache);

	removePath(dirs.config, args.dryRun);
	removePath(dirs.data, args.dryRun);
	removePath(dirs.state, args.dryRun);
	removePath(dirs.cache, args.dryRun);
	if (args.removeBinary) removeLauncher(args.dryRun);
	resetXdgCache();

	printOk(args.dryRun ? "uninstall preview complete" : "removed Clio Coder state");
	printRemovalGuidance();
	return 0;
}
