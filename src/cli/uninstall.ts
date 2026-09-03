import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";

import { resolvePackageRoot } from "../core/package-root.js";
import { resetXdgCache, resolveClioDirs } from "../core/xdg.js";
import { detectInstallMethod } from "../domains/lifecycle/install-method.js";
import { createLifecyclePresenter, type LifecycleItem, measurePath, shortenPath } from "./lifecycle-presenter.js";
import { type RemovalFailure, removePath, reportRemovalFailures } from "./removal.js";
import { printError } from "./shared.js";

const HELP = `clio-coder uninstall [--remove-binary] [--keep-config] [--keep-data] [--dry-run] [--force] [--json]

Remove all Clio Coder state: the config, data, state, and cache roots.

Per-project \`.clio-coder/\` directories are outside those roots and are never removed
here. Every project Clio has run in is recorded in the session metadata, so both
the real run and --dry-run list them and name the command that clears one,
before the launcher is touched.

Flags:
  --keep-config    preserve the configuration root (settings.yaml, credentials)
  --keep-data      preserve the data root (memory, evidence, vendored tools)
  --remove-binary  also remove the launcher symlink when it points at this
                   installation. A real file, or a link into a different clio-coder
                   installation, is kept and reported.
  --dry-run        print what would be removed without changing anything
  --force, -f      skip confirmation prompt and proceed immediately
  --json           emit machine-readable JSON output
  --help, -h       show this message
`;

interface ParsedUninstallArgs {
	removeBinary: boolean;
	keepConfig: boolean;
	keepData: boolean;
	force: boolean;
	dryRun: boolean;
	json: boolean;
	help: boolean;
}

function parseUninstallArgs(argv: ReadonlyArray<string>): ParsedUninstallArgs {
	const parsed: ParsedUninstallArgs = {
		removeBinary: false,
		keepConfig: false,
		keepData: false,
		force: false,
		dryRun: false,
		json: false,
		help: false,
	};
	for (const arg of argv) {
		switch (arg) {
			case "--remove-binary":
				parsed.removeBinary = true;
				break;
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
	return parsed;
}

export interface ProjectContextInventory {
	/** Project directories the session store recorded, one per cwd hash. */
	recorded: number;
	/** Of those, the ones that still have a `.clio-coder/` on disk. */
	dirs: string[];
	/** The session store was not there to read, so nothing could be enumerated. */
	storeAbsent: boolean;
}

/**
 * The projects Clio has run in, read from the session metadata under
 * `<stateDir>/sessions/`.
 */
function projectContextInventory(stateDir: string): ProjectContextInventory {
	const root = join(stateDir, "sessions");
	let hashes: string[];
	try {
		hashes = readdirSync(root);
	} catch {
		return { recorded: 0, dirs: [], storeAbsent: true };
	}
	const dirs = new Set<string>();
	let recorded = 0;
	for (const hash of hashes.sort()) {
		const cwd = firstRecordedCwd(join(root, hash));
		if (cwd === null) continue;
		recorded += 1;
		if (existsSync(join(cwd, ".clio-coder"))) dirs.add(cwd);
	}
	return { recorded, dirs: [...dirs].sort(), storeAbsent: false };
}

/** The `cwd` from the first readable session meta under one cwd-hash directory. */
function firstRecordedCwd(hashDir: string): string | null {
	let sessions: string[];
	try {
		sessions = readdirSync(hashDir);
	} catch {
		return null;
	}
	for (const session of sessions.sort()) {
		try {
			const meta = JSON.parse(readFileSync(join(hashDir, session, "meta.json"), "utf8")) as { cwd?: unknown };
			if (typeof meta.cwd === "string" && meta.cwd.length > 0) return meta.cwd;
		} catch {
			// A tombstoned, partial, or unreadable meta says nothing about the
			// project; the next session under the same hash may still say it.
		}
	}
	return null;
}

function launcherLinkPath(): string {
	const binDir = process.env.CLIO_CODER_BIN_DIR?.trim() || join(homedir(), ".local", "bin");
	return join(binDir, "clio-coder");
}

/** The CLI entry of the installation running this command. */
function ownedCliEntry(): string {
	const entry = join(resolvePackageRoot(), "dist", "cli", "index.js");
	try {
		return realpathSync(entry);
	} catch {
		return entry;
	}
}

type LauncherVerdict = { kind: "absent" } | { kind: "keep"; detail: string } | { kind: "remove"; detail: string };

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

function removeLauncher(dryRun: boolean): RemovalFailure | null {
	const linkPath = launcherLinkPath();
	const verdict = classifyLauncher(linkPath);
	if (verdict.kind === "absent") {
		return null;
	}
	if (verdict.kind === "keep") {
		return null;
	}
	return removePath("binary", linkPath, dryRun);
}

function findClioOnPath(): string | null {
	const names =
		process.platform === "win32" ? ["clio-coder.cmd", "clio-coder.ps1", "clio-coder.exe", "clio-coder"] : ["clio-coder"];
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
			env: { ...process.env, npm_config_logs_max: "0", npm_config_update_notifier: "false" },
		});
		if (result.status !== 0) return null;
		const prefix = result.stdout.trim();
		return prefix.length > 0 ? prefix : null;
	} catch {
		return null;
	}
}

function otherClioOnPath(pathClio: string | null, localLink: string): string | null {
	if (pathClio === null) return null;
	if (pathClio === localLink) return null;
	const resolve = (path: string): string | null => {
		try {
			return realpathSync(path);
		} catch {
			return null;
		}
	};
	const resolvedPathClio = resolve(pathClio);
	if (resolvedPathClio !== null && resolvedPathClio === resolve(localLink)) return null;
	return pathClio;
}

function detectShellRcEdits(): Array<{ file: string; hasEntry: boolean }> {
	const candidates = [join(homedir(), ".bashrc"), join(homedir(), ".zshrc"), join(homedir(), ".profile")];
	const results: Array<{ file: string; hasEntry: boolean }> = [];
	for (const file of candidates) {
		if (existsSync(file)) {
			try {
				const content = readFileSync(file, "utf8");
				if (content.includes("clio-coder") || content.includes("CLIO_CODER")) {
					results.push({ file, hasEntry: true });
				}
			} catch {
				// ignore unreadable
			}
		}
	}
	return results;
}

function printRemovalGuidance(removeBinaryRequested: boolean, method: "source" | "npm", localLink: string): void {
	const pathClio = findClioOnPath();
	const npmPrefix = readNpmPrefix();
	const currentLauncher = process.argv[1];

	process.stdout.write("\nBinary removal guidance:\n");
	if (currentLauncher) process.stdout.write(`  current launcher: ${currentLauncher}\n`);
	process.stdout.write(`  PATH lookup:      ${pathClio ?? "not currently found"}\n`);
	if (npmPrefix) process.stdout.write(`  npm prefix bin:   ${join(npmPrefix, "bin")}\n`);
	process.stdout.write(`  local source bin: ${localLink}${existsSync(localLink) ? "" : "  (absent)"}\n`);
	const survivor = otherClioOnPath(pathClio, localLink);
	if (survivor !== null) {
		process.stdout.write(`\nanother clio-coder remains on your PATH at ${survivor}\n`);
		process.stdout.write("  it is a different installation from the one this uninstall touched\n");
		process.stdout.write(`  check it with: ${survivor} --version\n`);
	}
	process.stdout.write("\nUse the removal path that matches how you installed Clio Coder:\n");
	if (!removeBinaryRequested && method === "source") {
		process.stdout.write("  source symlink:  clio-coder uninstall --remove-binary --force\n");
	}
	process.stdout.write("  npm global:      npm uninstall -g @iowarp/clio-coder\n");
	process.stdout.write("  npm link:        npm unlink -g @iowarp/clio-coder\n");
	process.stdout.write("\nAfter removing or replacing a clio-coder link, clear shell command caches:\n");
	process.stdout.write("  hash -r   # Bash\n");
	process.stdout.write("  rehash    # Zsh\n");
}

export async function runUninstallCommand(argv: ReadonlyArray<string>): Promise<number> {
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

	const isInteractive = Boolean(process.stdin.isTTY);
	if (!args.dryRun && !args.force && !isInteractive) {
		printError("`clio-coder uninstall` requires confirmation or --force in non-interactive environments");
		process.stdout.write(HELP);
		return 2;
	}

	const dirs = resolveClioDirs();
	const method = detectInstallMethod();
	const presenter = createLifecyclePresenter({ json: args.json });

	presenter.header("Uninstall Clio Coder", "uninstall");
	presenter.step(`Installation method: ${method === "source" ? "source symlink" : "npm global"}`);

	const configSize = measurePath(dirs.config);
	const dataSize = measurePath(dirs.data);
	const stateSize = measurePath(dirs.state);
	const cacheSize = measurePath(dirs.cache);
	const logsPath = join(dirs.state, "audit");
	const logsSize = measurePath(logsPath);
	const sessionsPath = join(dirs.state, "sessions");
	const sessionsSize = measurePath(sessionsPath);
	const linkPath = launcherLinkPath();
	const linkSize = measurePath(linkPath);
	const shellEdits = detectShellRcEdits();

	const items: LifecycleItem[] = [
		{
			label: "Data",
			path: dirs.data,
			bytes: dataSize.bytes,
			status: args.keepData ? "keep" : dataSize.exists ? "remove" : "absent",
			detail: args.keepData ? "kept by --keep-data" : undefined,
		},
		{
			label: "Cache",
			path: dirs.cache,
			bytes: cacheSize.bytes,
			status: cacheSize.exists ? "remove" : "absent",
		},
		{
			label: "Config",
			path: dirs.config,
			bytes: configSize.bytes,
			status: args.keepConfig ? "keep" : configSize.exists ? "remove" : "absent",
			detail: args.keepConfig ? "kept by --keep-config" : undefined,
		},
		{
			label: "State",
			path: dirs.state,
			bytes: stateSize.bytes,
			status: stateSize.exists ? "remove" : "absent",
		},
		{
			label: "Logs",
			path: logsPath,
			bytes: logsSize.bytes,
			status: logsSize.exists ? "remove" : "absent",
		},
		{
			label: "Sessions",
			path: sessionsPath,
			bytes: sessionsSize.bytes,
			status: sessionsSize.exists ? "remove" : "absent",
		},
		{
			label: "Binary",
			path: linkPath,
			bytes: linkSize.bytes,
			status: linkSize.exists ? (args.removeBinary ? "remove" : "skip") : "absent",
			detail: !args.removeBinary && linkSize.exists ? "kept (use --remove-binary to unlink)" : undefined,
		},
	];

	if (shellEdits.length > 0) {
		for (const edit of shellEdits) {
			items.push({
				label: "Shell PATH",
				path: edit.file,
				status: "clean",
				detail: `in ${shortenPath(edit.file)}`,
			});
		}
	} else {
		items.push({
			label: "Shell PATH",
			path: join(homedir(), ".bashrc"),
			status: "clean",
			detail: "no shell configuration edits detected",
		});
	}

	presenter.listItems("The following will be removed", items);

	const projectInv = projectContextInventory(dirs.state);
	if (projectInv.dirs.length > 0) {
		presenter.rail("Per-project context (not removed by uninstall):");
		for (const dir of projectInv.dirs) {
			presenter.substep(shortenPath(join(dir, ".clio-coder")), "–");
		}
		presenter.commandAdvice(
			"To clear project context, run inside each project before removing binary:",
			"clio-coder context reset --all",
		);
		presenter.rail();
	}

	if (args.dryRun) {
		presenter.warn("Dry run - no changes made");
		presenter.done("Done");
		if (!args.json) printRemovalGuidance(args.removeBinary, method, linkPath);
		return 0;
	}

	if (!args.force) {
		const confirmed = await presenter.confirm("Are you sure you want to uninstall?", false);
		if (!confirmed) {
			presenter.warn("Uninstall cancelled");
			presenter.done("Cancelled");
			return 0;
		}
	}

	const failures: RemovalFailure[] = [];

	if (cacheSize.exists) {
		const failure = removePath("cache", dirs.cache, false);
		if (failure) failures.push(failure);
		else presenter.completedStep("Removed Cache");
	}

	if (!args.keepData && dataSize.exists) {
		const failure = removePath("data", dirs.data, false);
		if (failure) failures.push(failure);
		else presenter.completedStep("Removed Data");
	}

	if (!args.keepConfig && configSize.exists) {
		const failure = removePath("config", dirs.config, false);
		if (failure) failures.push(failure);
		else presenter.completedStep("Removed Config");
	}

	if (stateSize.exists) {
		const failure = removePath("state", dirs.state, false);
		if (failure) failures.push(failure);
		else presenter.completedStep("Removed State");
	}

	if (args.removeBinary && linkSize.exists) {
		const failure = removeLauncher(false);
		if (failure) failures.push(failure);
		else presenter.completedStep("Removed Binary launcher");
	}

	resetXdgCache();

	if (failures.length > 0) {
		presenter.fail("uninstall did not remove everything");
		reportRemovalFailures(
			`clio-coder uninstall${args.removeBinary ? " --remove-binary" : ""}${args.keepConfig ? " --keep-config" : ""}${args.keepData ? " --keep-data" : ""} --force`,
			failures,
		);
		return 1;
	}

	if (!args.removeBinary) {
		if (method === "source") {
			presenter.commandAdvice("To finish removing the binary, run:", `rm "${linkPath}"`);
		} else {
			presenter.commandAdvice("To finish removing the binary, run:", "npm uninstall -g @iowarp/clio-coder");
		}
	}

	presenter.message("Thank you for using Clio Coder!");
	presenter.done("Done");
	return 0;
}
