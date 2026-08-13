import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";

import { resolvePackageRoot } from "../core/package-root.js";
import { resetXdgCache, resolveClioDirs } from "../core/xdg.js";
import { type RemovalFailure, removePath, reportRemovalFailures } from "./removal.js";
import { printError, printHeader, printOk } from "./shared.js";

const HELP = `clio uninstall [--remove-binary] [--dry-run] [--force]

Remove all Clio Coder state: the config, data, state, and cache roots.

Flags:
  --remove-binary  also remove the launcher symlink when it points at this
                   installation. A real file, or a link into a different clio
                   installation, is kept and reported.
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

function launcherLinkPath(): string {
	const binDir = process.env.CLIO_BIN_DIR?.trim() || join(homedir(), ".local", "bin");
	return join(binDir, "clio");
}

/** The CLI entry of the installation running this command. */
function ownedCliEntry(): string {
	const entry = join(resolvePackageRoot(), "dist", "cli", "index.js");
	try {
		return realpathSync(entry);
	} catch {
		// A source checkout with no build yet, or a dist this process was not
		// launched from. The unresolved path is still the right identity.
		return entry;
	}
}

type LauncherVerdict = { kind: "absent" } | { kind: "keep"; detail: string } | { kind: "remove"; detail: string };

/**
 * Decide whether the launcher at `linkPath` belongs to this installation.
 *
 * Ownership is identity, not shape. The previous rule accepted any symlink
 * whose target path ended in `dist/cli/index.js`, which is a string test three
 * ways too broad: it matched a live symlink into a *different* clio checkout,
 * and it matched a target that is not even a file, so `clio uninstall
 * --remove-binary` from one installation would silently unlink another one's
 * launcher and leave that installation on disk with no way to start it.
 *
 * A link that resolves to this installation's own entry is ours and goes. A
 * link that resolves anywhere else is somebody's, so it stays with the path it
 * points at and the command that removes it deliberately. A dangling link is
 * the one case with no owner to defer to: the installation it named is gone,
 * unlinking it cannot touch a target that does not exist, and leaving it puts
 * a broken `clio` on PATH after an uninstall that claimed to finish. Those are
 * removed when the name they carry is a clio entry, and reported as dangling.
 */
function classifyLauncher(linkPath: string): LauncherVerdict {
	let isSymlink: boolean;
	try {
		isSymlink = lstatSync(linkPath).isSymbolicLink();
	} catch {
		return { kind: "absent" };
	}
	if (!isSymlink) {
		return { kind: "keep", detail: "not a symlink; remove it via your package manager" };
	}

	const owned = ownedCliEntry();
	let resolved: string | null = null;
	try {
		resolved = realpathSync(linkPath);
	} catch {
		resolved = null;
	}

	if (resolved !== null) {
		if (resolved === owned) return { kind: "remove", detail: `-> ${resolved}` };
		return {
			kind: "keep",
			detail: `points at ${resolved}, not this installation (${owned}); remove it with \`rm ${linkPath}\``,
		};
	}

	const raw = readlinkSync(linkPath);
	const danglingTarget = isAbsolute(raw) ? raw : resolve(dirname(linkPath), raw);
	if (danglingTarget.endsWith(join(sep, "dist", "cli", "index.js"))) {
		return { kind: "remove", detail: `-> ${danglingTarget} (dangling; that installation is already gone)` };
	}
	return {
		kind: "keep",
		detail: `dangling link to ${danglingTarget}, which is not a clio entry; remove it with \`rm ${linkPath}\``,
	};
}

/** Returns the failure when the owned launcher existed but could not be unlinked. */
function removeLauncher(dryRun: boolean): RemovalFailure | null {
	const linkPath = launcherLinkPath();
	const verdict = classifyLauncher(linkPath);
	if (verdict.kind === "absent") {
		process.stdout.write(`  binary   absent ${linkPath}\n`);
		return null;
	}
	if (verdict.kind === "keep") {
		process.stdout.write(`  binary   keep   ${linkPath} (${verdict.detail})\n`);
		return null;
	}
	process.stdout.write(`  binary   remove ${linkPath} ${verdict.detail}\n`);
	// Shares removePath so the launcher gets the same unlink-the-link handling
	// every other removed path gets. Removing the link with `rmSync` left a
	// dangling one in place while reporting that it had gone.
	return removePath("binary", linkPath, dryRun);
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
			// A read-only probe that writes. npm drops a debug log into
			// $HOME/.npm/_logs on every invocation, so the documented
			// side-effect-free `--dry-run` path left a file behind in the home
			// directory it had just finished promising not to touch. `logs-max=0`
			// keeps npm from retaining any; the notifier is off for the same reason.
			env: { ...process.env, npm_config_logs_max: "0", npm_config_update_notifier: "false" },
		});
		if (result.status !== 0) return null;
		const prefix = result.stdout.trim();
		return prefix.length > 0 ? prefix : null;
	} catch {
		return null;
	}
}

function printRemovalGuidance(removeBinaryRequested: boolean): void {
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
	// Re-suggesting the flag the operator just passed reads as though it had not
	// run, so the source-symlink line only appears when it is still an option.
	if (!removeBinaryRequested) {
		process.stdout.write("  source symlink:  clio uninstall --remove-binary --force\n");
	}
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
	const roots = [
		["config", dirs.config],
		["data", dirs.data],
		["state", dirs.state],
		["cache", dirs.cache],
	] as const;
	for (const [label, path] of roots) report(label, path);

	// Every root is attempted even after one fails, so a single unwritable
	// subtree cannot leave the other three behind unreported.
	const failures: RemovalFailure[] = [];
	for (const [label, path] of roots) {
		const failure = removePath(label, path, args.dryRun);
		if (failure) failures.push(failure);
	}
	if (args.removeBinary) {
		const failure = removeLauncher(args.dryRun);
		if (failure) failures.push(failure);
	}
	resetXdgCache();

	if (failures.length > 0) {
		printError("uninstall did not remove everything");
		reportRemovalFailures(`clio uninstall${args.removeBinary ? " --remove-binary" : ""} --force`, failures);
		return 1;
	}

	printOk(args.dryRun ? "uninstall preview complete" : "removed Clio Coder state");
	printRemovalGuidance(args.removeBinary);
	return 0;
}
