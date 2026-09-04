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

Per-project \`.clio-coder/\` directories sit outside those roots and are never
removed here. Every project Clio has run in is recorded in the session metadata,
so the real run and --dry-run both list them and name the command that clears one.
Shell startup files are reported, never edited.

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

/**
 * Shell startup files that mention Clio. Uninstall reports them and never edits
 * them: a login file is the user's own, an installer is not the only thing that
 * writes `clio-coder` into one, and a wrong automated edit costs a working
 * shell. Naming the file and leaving the edit to the operator is the honest
 * trade, so these rows are listed as kept rather than as removals.
 */
function detectShellRcEdits(): string[] {
	const candidates = [join(homedir(), ".bashrc"), join(homedir(), ".zshrc"), join(homedir(), ".profile")];
	const results: string[] = [];
	for (const file of candidates) {
		try {
			const content = readFileSync(file, "utf8");
			if (content.includes("clio-coder") || content.includes("CLIO_CODER")) results.push(file);
		} catch {
			// Absent or unreadable says nothing to report.
		}
	}
	return results;
}

/**
 * The one fact worth a line after the roots are gone: a second clio-coder that
 * this uninstall did not touch is still first on PATH, so the next `clio-coder`
 * runs it and the operator would conclude the uninstall failed.
 */
function survivingClioOnPath(localLink: string): string | null {
	return otherClioOnPath(findClioOnPath(), localLink);
}

/**
 * How the launcher row reads. `--remove-binary` promises to unlink only a
 * symlink into this installation; every other shape is kept, and saying so on
 * the inventory is the difference between an operator who knows a launcher
 * survived and one who finds out from the next `clio-coder`.
 */
function launcherItemStatus(verdict: LauncherVerdict, removeRequested: boolean): LifecycleItem["status"] {
	if (verdict.kind === "absent") return "absent";
	if (verdict.kind === "keep") return "skip";
	return removeRequested ? "remove" : "skip";
}

function launcherItemDetail(verdict: LauncherVerdict, removeRequested: boolean): string | undefined {
	if (verdict.kind === "absent") return undefined;
	if (verdict.kind === "keep") return verdict.detail;
	return removeRequested ? undefined : "kept; --remove-binary unlinks it";
}

/** The removal command that matches how this installation was put on disk. */
function binaryRemovalAdvice(method: "source" | "npm", linkPath: string): { lead: string; command: string } {
	if (method === "npm") {
		const prefix = readNpmPrefix();
		return {
			lead: prefix === null ? "To remove the launcher, run:" : `To remove the launcher from ${join(prefix, "bin")}, run:`,
			command: "npm uninstall -g @iowarp/clio-coder\nhash -r",
		};
	}
	return { lead: "To finish removing the launcher, run:", command: `rm "${linkPath}"\nhash -r` };
}

export async function runUninstallCommand(argv: ReadonlyArray<string>): Promise<number> {
	let args: ParsedUninstallArgs;
	try {
		args = parseUninstallArgs(argv);
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
		printError("`clio-coder uninstall` needs a terminal to confirm; pass --force to skip the prompt");
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
	const linkPath = launcherLinkPath();
	const linkSize = measurePath(linkPath);
	const launcher = classifyLauncher(linkPath);
	const shellEdits = detectShellRcEdits();

	// The state root's own children (audit, sessions) are inside the State row
	// and go with it; listing them again as separate removals double-counted the
	// bytes and promised per-child results that one recursive delete never
	// produces.
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
			detail: stateSize.exists ? "sessions, audit, receipts" : undefined,
		},
		{
			label: "Launcher",
			path: linkPath,
			bytes: linkSize.bytes,
			status: launcherItemStatus(launcher, args.removeBinary),
			detail: launcherItemDetail(launcher, args.removeBinary),
		},
	];

	// A login file is reported, never edited; see detectShellRcEdits.
	for (const file of shellEdits) {
		items.push({ label: "Shell config", path: file, status: "skip", detail: "mentions clio-coder; edit it by hand" });
	}

	presenter.listItems("The following will be removed", items);

	const projectInv = projectContextInventory(dirs.state);
	if (projectInv.dirs.length > 0) {
		presenter.note("Per-project context, which uninstall does not remove:");
		for (const dir of projectInv.dirs) {
			presenter.substep(shortenPath(join(dir, ".clio-coder")), "–");
		}
		presenter.commandAdvice("To clear one, run inside that project:", "clio-coder context reset --all");
	}

	// The same guidance on the dry run and on the real run, so the preview is the
	// listing the run produces and nothing more.
	const survivor = survivingClioOnPath(linkPath);
	const advice = binaryRemovalAdvice(method, linkPath);

	if (args.dryRun) {
		presenter.warn("Dry run: no changes made");
		if (launcher.kind !== "absent" && !args.removeBinary) presenter.commandAdvice(advice.lead, advice.command);
		if (survivor !== null)
			presenter.warn(`Another clio-coder stays on your PATH at ${survivor}; it is a separate install`);
		presenter.done("Done");
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

	// Only a symlink into this installation is ever unlinked. Reporting the
	// removal from `--remove-binary` alone announced one for a launcher the
	// classifier had already decided to keep.
	let launcherRemoved = false;
	if (args.removeBinary && launcher.kind === "remove") {
		const failure = removePath("launcher", linkPath, false);
		if (failure) failures.push(failure);
		else {
			presenter.completedStep("Removed launcher");
			launcherRemoved = true;
		}
	}

	resetXdgCache();

	if (failures.length > 0) {
		presenter.fail("uninstall did not remove everything");
		reportRemovalFailures(
			`clio-coder uninstall${args.removeBinary ? " --remove-binary" : ""}${args.keepConfig ? " --keep-config" : ""}${args.keepData ? " --keep-data" : ""} --force`,
			failures,
		);
		presenter.finish();
		return 1;
	}

	if (launcher.kind !== "absent" && !launcherRemoved) presenter.commandAdvice(advice.lead, advice.command);
	if (survivor !== null)
		presenter.warn(`Another clio-coder stays on your PATH at ${survivor}; it is a separate install`);

	presenter.message("Thank you for using Clio Coder.");
	presenter.done("Done");
	return 0;
}
