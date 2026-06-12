import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, relative } from "node:path";

import { resetXdgCache, resolveClioDirs } from "../core/xdg.js";
import { printError, printHeader, printOk } from "./shared.js";

const HELP = `clio uninstall [--keep-config] [--keep-data] [--dry-run] [--force]

Remove Clio Coder state and print package-manager removal guidance. This does not remove the clio binary.

Flags:
  --keep-config  keep settings.yaml and credentials.yaml
  --keep-data    keep sessions, receipts, evidence, memory, and other data
  --dry-run      print what would be removed without changing anything
  --force        required for destructive execution
`;

interface ParsedUninstallArgs {
	keepConfig: boolean;
	keepData: boolean;
	force: boolean;
	dryRun: boolean;
	help: boolean;
}

function parseUninstallArgs(argv: ReadonlyArray<string>): ParsedUninstallArgs {
	const parsed: ParsedUninstallArgs = {
		keepConfig: false,
		keepData: false,
		force: false,
		dryRun: false,
		help: false,
	};
	for (const arg of argv) {
		switch (arg) {
			case "--keep-config":
				parsed.keepConfig = true;
				break;
			case "--keep-data":
				parsed.keepData = true;
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

function report(label: string, path: string, keep: boolean): void {
	const action = keep ? "keep" : "remove";
	process.stdout.write(`  ${label.padEnd(8)} ${action.padEnd(6)} ${path}${existsSync(path) ? "" : "  (absent)"}\n`);
}

function removePath(path: string, dryRun: boolean): void {
	if (!existsSync(path) || dryRun) return;
	rmSync(path, { recursive: true, force: true });
}

function containsPath(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel.length > 0 && !rel.startsWith("..") && !rel.startsWith("/");
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
	const localLink = join(homedir(), ".local", "bin", "clio");
	const currentLauncher = process.argv[1];

	process.stdout.write("\nBinary removal guidance (state removal above does not delete the executable):\n");
	if (currentLauncher) process.stdout.write(`  current launcher: ${currentLauncher}\n`);
	process.stdout.write(`  PATH lookup:      ${pathClio ?? "not currently found"}\n`);
	if (npmPrefix) process.stdout.write(`  npm prefix bin:   ${join(npmPrefix, "bin")}\n`);
	process.stdout.write(`  local source bin: ${localLink}${existsSync(localLink) ? "" : "  (absent)"}\n`);
	process.stdout.write("\nUse the removal path that matches how you installed Clio Coder:\n");
	process.stdout.write("  source checkout: npm run uninstall:local -- --force\n");
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
	report("config", dirs.config, args.keepConfig);
	report("data", dirs.data, args.keepData);
	report("state", dirs.state, args.keepData);
	report("cache", dirs.cache, false);

	if (!args.keepConfig) {
		if (args.keepData && (containsPath(dirs.config, dirs.data) || containsPath(dirs.config, dirs.state))) {
			removePath(join(dirs.config, "settings.yaml"), args.dryRun);
			removePath(join(dirs.config, "credentials.yaml"), args.dryRun);
		} else {
			removePath(dirs.config, args.dryRun);
		}
	}
	if (!args.keepData) {
		removePath(dirs.data, args.dryRun);
		removePath(dirs.state, args.dryRun);
	}
	removePath(dirs.cache, args.dryRun);
	resetXdgCache();

	printOk(args.dryRun ? "uninstall preview complete" : "removed selected Clio Coder state");
	printRemovalGuidance();
	return 0;
}
