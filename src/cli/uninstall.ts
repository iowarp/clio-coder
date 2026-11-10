import { spawn } from "node:child_process";
import {
	closeSync,
	existsSync,
	fchmodSync,
	fchownSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { resolvePackageRoot } from "../core/package-root.js";
import { runCommandVector } from "../core/safe-exec.js";
import { safeResourceWrite } from "../core/safe-resource-write.js";
import { clioDirLayoutProblems, removableClioRootProblem, resetXdgCache, resolveClioDirs } from "../core/xdg.js";
import type { Installation } from "../domains/lifecycle/install-method.js";
import {
	INSTALLER_LAUNCHER_MARK,
	INSTALLER_OWNED_ENTRIES,
	inactiveInstallerRecord,
	inspectInstallation,
	installationCommand,
	launcherPathFor,
} from "../domains/lifecycle/install-method.js";
import {
	inactiveInstallerLauncher,
	inactiveInstallerRoots,
	installerExeFiles,
	installRootHolders,
	installRootServiceFiles,
} from "../domains/lifecycle/install-plan.js";
import { GUI_UNINSTALL_ADVICE, prepareGuiUninstall } from "./gui.js";
import { stopLegacyDocsBeforeRemoval } from "./legacy-docs-cleanup.js";
import type { LifecycleItem, LifecyclePresenter } from "./lifecycle-presenter.js";
import { createLifecyclePresenter, measurePath, shortenPath } from "./lifecycle-presenter.js";
import type { RemovalFailure } from "./removal.js";
import { refuseForOpenSessions, removePath, reportRemovalFailures } from "./removal.js";
import { printError } from "./shared.js";

const HELP = `clio-coder uninstall [--keep-binary] [--keep-package] [--keep-config] [--keep-data] [--dry-run] [--force] [--json]
clio-coder uninstall --inactive [--dry-run] [--force] [--json]

Remove Clio Coder: the config, data, state, and cache roots, the launcher, and for
an install.sh install its private Node and every installed version.

Per-project \`.clio-coder/\` directories sit outside those roots and are never
removed here. Every project Clio has run in is recorded in the session metadata,
so the real run and --dry-run both list them and name the command that clears one.
The PATH block install.sh --modify-path appended goes with the launcher when its
two marked lines are unchanged; any other mention in a shell startup file is
reported, never edited. Clio's private pane host is stopped before its binary is
removed. Uninstall stops while a session is still open.
Owned graphical background services are stopped and disabled before their state is
removed; their desktop launchers are removed using the app's ownership manifests.

Flags:
  --keep-config    preserve the configuration root (settings.yaml, credentials)
  --keep-data      preserve the data root (memory, the project store, vendored tools)
  --keep-binary    keep the launcher and, for an install.sh install, its private Node and
                   installed versions. Without it the launcher goes only when it belongs
                   to this installation: a real file, or a link into a different clio-coder
                   installation, is kept and reported.
  --keep-package   for an npm global install, leave the package itself; uninstall
                   otherwise runs npm uninstall -g --prefix <its prefix> last
  --inactive       remove only installer roots this binary does not run from, left behind
                   after moving to a checkout or a package manager, and their own
                   launcher. Your config, data, sessions and this installation stay.
  --dry-run        print what would be removed without changing anything
  --force, -f      skip confirmation prompt and proceed immediately
  --json           emit machine-readable JSON output
  --help, -h       show this message
`;

interface ParsedUninstallArgs {
	keepBinary: boolean;
	keepConfig: boolean;
	keepData: boolean;
	inactive: boolean;
	keepPackage: boolean;
	force: boolean;
	dryRun: boolean;
	json: boolean;
	help: boolean;
}

function parseUninstallArgs(argv: ReadonlyArray<string>): ParsedUninstallArgs {
	const parsed: ParsedUninstallArgs = {
		keepBinary: false,
		keepConfig: false,
		keepData: false,
		inactive: false,
		keepPackage: false,
		force: false,
		dryRun: false,
		json: false,
		help: false,
	};
	for (const arg of argv) {
		switch (arg) {
			case "--keep-binary":
				parsed.keepBinary = true;
				break;
			case "--keep-config":
				parsed.keepConfig = true;
				break;
			case "--keep-data":
				parsed.keepData = true;
				break;
			case "--keep-package":
				parsed.keepPackage = true;
				break;
			case "--inactive":
				parsed.inactive = true;
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
	if (parsed.inactive && (parsed.keepBinary || parsed.keepPackage || parsed.keepConfig || parsed.keepData))
		throw new Error("--inactive already keeps the binary, config and data; drop the --keep-* flags");
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

/**
 * Delete `paths`, then `emptyRoot` if nothing else is left in it, from a
 * detached cmd.exe once this process and its .cmd launcher have exited.
 * cmd gives PowerShell the console it needs to wait on the PID and retry locked
 * files; launching detached PowerShell directly exits before running the script.
 */
function scheduleRemovalAfterExit(paths: string[], emptyRoot: string | null): void {
	const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
	const targets = paths.map(literal).join(",");
	const script =
		`$ErrorActionPreference='Stop'; $owner=${process.pid}; while (Get-Process -Id $owner -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 250 }; Start-Sleep -Seconds 1; ` +
		`$targets=@(${targets}); for ($i=0; $i -lt 30; $i++) { foreach ($p in $targets) { if (Test-Path -LiteralPath $p) { try { Remove-Item -LiteralPath $p -Recurse -Force } catch { } } }; if (-not ($targets | Where-Object { Test-Path -LiteralPath $_ })) { break }; Start-Sleep -Seconds 1 }; ` +
		(emptyRoot
			? `if (-not ($targets | Where-Object { Test-Path -LiteralPath $_ })) { Remove-Item -LiteralPath ${literal(join(emptyRoot, ".install-lock"))} -Recurse -Force -ErrorAction SilentlyContinue; if (-not (Get-ChildItem -LiteralPath ${literal(emptyRoot)} -Force)) { Remove-Item -LiteralPath ${literal(emptyRoot)} -Force } } else { [Console]::Error.WriteLine('Deferred cleanup incomplete; retained install lock for recovery') }`
			: "");
	spawn(
		"cmd.exe",
		[
			"/d",
			"/s",
			"/c",
			`powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`,
		],
		{
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		},
	).unref();
}

/**
 * The files a launcher of this installation may resolve to: the CLI entry, and
 * the Node version guard that package managers link as the bin since #408.
 */
function ownedCliEntries(): string[] {
	return [join("dist", "cli", "index.js"), join("bin", "clio-coder.cjs")].map((relative) => {
		const entry = join(resolvePackageRoot(), relative);
		try {
			return realpathSync(entry);
		} catch {
			return entry;
		}
	});
}

/** A launcher file scripts/install.sh wrote for this install root. */
function isInstallerLauncher(linkPath: string, installation: Installation): boolean {
	const record = installation.installer;
	if (record === undefined) return false;
	if (installerExeFiles(linkPath, record.root)) return true;
	try {
		// The sh launcher carries the mark as a comment line, the Windows .cmd as a
		// `rem` line; both name the install root they run from.
		const text = readFileSync(linkPath, "utf8");
		const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
		return text.includes(INSTALLER_LAUNCHER_MARK) && fold(text).includes(fold(`${record.root}${sep}`));
	} catch {
		return false;
	}
}

type LauncherVerdict = { kind: "absent" } | { kind: "keep"; detail: string } | { kind: "remove"; detail: string };

function classifyLauncher(linkPath: string, installation: Installation): LauncherVerdict {
	let isSymlink: boolean;
	try {
		isSymlink = lstatSync(linkPath).isSymbolicLink();
	} catch {
		return { kind: "absent" };
	}
	if (!isSymlink) {
		if (isInstallerLauncher(linkPath, installation)) return { kind: "remove", detail: "install.sh launcher" };
		return { kind: "keep", detail: "not a symlink; remove it via your package manager" };
	}

	const owned = ownedCliEntries();
	let resolved: string | null = null;
	try {
		resolved = realpathSync(linkPath);
	} catch {
		resolved = null;
	}

	if (resolved !== null) {
		if (owned.includes(resolved)) return { kind: "remove", detail: `-> ${resolved}` };
		return {
			kind: "keep",
			detail: `points at ${resolved}, not this installation (${owned[0]}); remove it with \`rm ${linkPath}\``,
		};
	}

	const raw = readlinkSync(linkPath);
	const danglingTarget = isAbsolute(raw) ? raw : resolve(dirname(linkPath), raw);
	if (
		danglingTarget.endsWith(join(sep, "dist", "cli", "index.js")) ||
		danglingTarget.endsWith(join(sep, "bin", "clio-coder.cjs"))
	) {
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
/** Sockets of Clio's private herdr hosts that still exist, from `<state>/mux/<hash>/socket-path`. */
function privatePaneHosts(stateDir: string): string[] {
	const mux = join(stateDir, "mux");
	let roots: string[];
	try {
		roots = readdirSync(mux);
	} catch {
		return [];
	}
	return roots.flatMap((name) => {
		try {
			const socket = readFileSync(join(mux, name, "socket-path"), "utf8").trim();
			return isAbsolute(socket) && lstatSync(socket).isSocket() ? [socket] : [];
		} catch {
			return [];
		}
	});
}

/** Ask a private host to stop and wait for its socket to go quiet. True when it is gone. */
async function stopPaneHost(socketPath: string): Promise<boolean> {
	const { createMuxClient } = await import("../domains/mux/index.js");
	const answers = async (): Promise<boolean> => {
		const client = createMuxClient({ socketPath, connectTimeoutMs: 500, requestTimeoutMs: 500 });
		try {
			await client.ping({ timeoutMs: 500 });
			return true;
		} catch {
			return false;
		} finally {
			await client.close();
		}
	};
	if (!(await answers())) return true;
	const client = createMuxClient({ socketPath, connectTimeoutMs: 500, requestTimeoutMs: 2_000 });
	await client.serverStop().catch(() => undefined);
	await client.close();
	for (let attempt = 0; attempt < 30; attempt++) {
		if (!(await answers())) return true;
		await new Promise((done) => setTimeout(done, 100));
	}
	return false;
}

const PATH_BLOCK_MARK = "# added by clio-coder install.sh";

/**
 * The 0-based index of the mark line of the block `install.sh --modify-path`
 * appended for `binDir`, when both of its lines are still exactly as written.
 */
function markedPathBlock(text: ReadonlyArray<string>, binDir: string): number | null {
	const written = [`export PATH="${binDir}:$PATH"`, `fish_add_path "${binDir}"`];
	const index = text.findIndex((line, at) => line === PATH_BLOCK_MARK && written.includes(text[at + 1] ?? ""));
	return index < 0 ? null : index;
}

/**
 * Remove the marked block and the blank line install.sh put before it. True when the file changed.
 * The edit is byte-exact (latin1 maps each byte to one code unit, so bytes outside the block,
 * valid UTF-8 or not, are written back unchanged), and lands by renaming a synced copy over
 * the resolved file: a full disk or a kill leaves the original as it was.
 */
function removePathBlock(file: string, binDir: string): boolean {
	const real = realpathSync(file);
	const original = readFileSync(real);
	const text = original.toString("latin1").split("\n");
	const index = markedPathBlock(text, Buffer.from(binDir, "utf8").toString("latin1"));
	if (index === null) return false;
	const start = index > 0 && text[index - 1] === "" ? index - 1 : index;
	text.splice(start, index + 2 - start);
	const stat = statSync(real);
	const temp = join(dirname(real), `.${basename(real)}.clio-coder-${process.pid}.tmp`);
	let fd: number | null = null;
	try {
		fd = openSync(temp, "wx", stat.mode & 0o7777);
		writeFileSync(fd, Buffer.from(text.join("\n"), "latin1"));
		fchmodSync(fd, stat.mode & 0o7777);
		if (process.platform !== "win32" && (stat.uid !== process.getuid?.() || stat.gid !== process.getgid?.()))
			fchownSync(fd, stat.uid, stat.gid);
		fsyncSync(fd);
		closeSync(fd);
		fd = null;
		renameSync(temp, real);
	} catch (error) {
		if (fd !== null) closeSync(fd);
		rmSync(temp, { force: true });
		throw error;
	}
	return true;
}

/** What else lives in the launcher's directory, the launcher itself aside. */
function otherBinEntries(binDir: string, launcher: string): string[] {
	try {
		return readdirSync(binDir).filter((name) => name !== basename(launcher));
	} catch {
		return [];
	}
}

function sharedBinReason(launcher: string): string {
	return `other programs in ${shortenPath(dirname(launcher))} rely on it`;
}

function detectShellRcEdits(binDir: string): Array<{ file: string; lines: number[]; block: boolean }> {
	const home = homedir();
	const zdotdir = process.env.ZDOTDIR?.trim();
	const xdgConfig = process.env.XDG_CONFIG_HOME?.trim();
	// The same files scripts/install.sh --modify-path appends to, ZDOTDIR and fish included.
	const candidates = [
		join(home, ".bashrc"),
		join(home, ".zshrc"),
		...(zdotdir && isAbsolute(zdotdir) ? [join(zdotdir, ".zshrc")] : []),
		join(home, ".profile"),
		join(xdgConfig && isAbsolute(xdgConfig) ? xdgConfig : join(home, ".config"), "fish", "config.fish"),
	];
	const results: Array<{ file: string; lines: number[]; block: boolean }> = [];
	for (const file of new Set(candidates)) {
		try {
			const content = readFileSync(file, "utf8");
			const text = content.split("\n");
			const block = markedPathBlock(text, binDir);
			const lines = text.flatMap((line, index) => {
				if (index === block || index === (block ?? -2) + 1) return [];
				if (
					line.includes("clio-coder") ||
					line.includes("CLIO_CODER") ||
					text[index - 1]?.includes("# added by clio-coder install.sh")
				)
					return [index + 1];
				return [];
			});
			if (lines.length || block !== null) results.push({ file, lines, block: block !== null });
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
 * How the launcher row reads. Uninstall unlinks only a
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
	return removeRequested ? undefined : "kept by --keep-binary";
}

/** The removal command that matches how this installation was put on disk. */
function binaryRemovalAdvice(installation: Installation, linkPath: string): { lead: string; command: string } {
	if (installation.kind === "installer")
		return {
			lead: "To remove the private Node, the installed versions and the launcher, run:",
			command: `${installationCommand(installation, "uninstall")}${process.platform === "win32" ? "" : "\nhash -r"}`,
		};
	if (installation.kind === "source")
		return { lead: "To finish removing the launcher, run:", command: `rm "${linkPath}"\nhash -r` };
	return {
		lead: "To remove the package with its original package manager, run:",
		command: `${installationCommand(installation, "uninstall")}${process.platform === "win32" ? "" : "\nhash -r"}`,
	};
}

/** The launcher an inactive root wrote, when it still runs that root and nothing else replaced it. */
/**
 * `uninstall --inactive`: only installer roots left behind by a move to another
 * install method. Homes, the running installation and the desktop app stay.
 */
async function uninstallInactive(
	installation: Installation,
	args: ParsedUninstallArgs,
	presenter: LifecyclePresenter,
): Promise<number> {
	presenter.header("Remove inactive installs", "uninstall");
	const roots = inactiveInstallerRoots(installation);
	if (roots.length === 0) {
		presenter.note("No installer root other than the one this binary runs from.");
		presenter.done("Done");
		return 0;
	}
	const items: LifecycleItem[] = [];
	const launchers = new Map<string, string>();
	for (const record of roots) {
		const size = measurePath(record.root);
		items.push({
			label: "Inactive install",
			path: record.root,
			bytes: size.bytes,
			status: "remove",
			detail: "installer root this binary does not run from",
		});
		const launcher = inactiveInstallerLauncher(record);
		if (launcher) {
			launchers.set(record.root, launcher);
			items.push({ label: "Its launcher", path: launcher, status: "remove", detail: "install.sh launcher for it" });
		}
	}
	presenter.listItems("The following will be removed", items);
	presenter.note("Config, data, sessions, this installation and the desktop app stay.");
	const holders = roots.flatMap((record) =>
		installRootHolders(record.root).map((holder) => `${holder} holds ${shortenPath(record.root)}`),
	);
	if (holders.length > 0) {
		presenter.fail("Processes still run from an inactive install");
		for (const holder of holders) presenter.note(holder);
		presenter.commandAdvice(
			"Close them (for a Clio session: clio-coder session list, then clio-coder session terminate <id>) and retry:",
			"clio-coder uninstall --inactive",
		);
		presenter.finish();
		return 1;
	}
	const services = roots.flatMap((record) => installRootServiceFiles(record.root));
	if (services.length > 0) {
		presenter.fail("The graphical app is still installed from an inactive install");
		for (const file of services) presenter.note(`${shortenPath(file)} starts it from there`);
		presenter.commandAdvice(
			"Move it to this installation once its work is finished, then retry:",
			"clio-coder gui background install --handover",
		);
		presenter.finish();
		return 1;
	}
	if (args.dryRun) {
		presenter.warn("Dry run: no changes made");
		presenter.done("Done");
		return 0;
	}
	if (!args.force && !(await presenter.confirm("Remove these inactive installs?", false))) {
		presenter.warn("Cancelled");
		presenter.done("Cancelled");
		return 0;
	}
	const failures: RemovalFailure[] = [];
	for (const record of roots) {
		const lock = join(record.root, ".install-lock");
		try {
			mkdirSync(lock);
			safeResourceWrite(join(lock, "pid"), `${process.pid}\n`);
			safeResourceWrite(join(lock, "uninstall"), "1\n");
		} catch (error) {
			presenter.fail(
				`${shortenPath(record.root)} is locked by an installer; retry after it exits`,
				error instanceof Error ? error.message : String(error),
			);
			presenter.finish();
			return 1;
		}
		try {
			// A launch that raced the check above is caught by its receipt.
			const late = [...installRootHolders(record.root), ...installRootServiceFiles(record.root)];
			if (late.length > 0) {
				presenter.fail(`Processes started from ${shortenPath(record.root)}`);
				for (const holder of late) presenter.note(holder);
				presenter.finish();
				return 1;
			}
			const targets = INSTALLER_OWNED_ENTRIES.map((name) => join(record.root, name));
			const launcher = launchers.get(record.root);
			if (launcher) targets.push(launcher, ...(installerExeFiles(launcher, record.root) ?? []));
			const failed = targets.flatMap((target) => removePath("inactive install", target, false) ?? []);
			failures.push(...failed);
			if (failed.length === 0) presenter.completedStep(`Removed ${shortenPath(record.root)}`);
		} finally {
			rmSync(lock, { recursive: true, force: true });
			try {
				rmdirSync(record.root);
			} catch {
				/* Other files in a shared install root are preserved. */
			}
		}
	}
	if (failures.length > 0) {
		presenter.fail("uninstall --inactive did not remove everything");
		reportRemovalFailures("clio-coder uninstall --inactive --force", failures);
		presenter.finish();
		return 1;
	}
	presenter.done("Done");
	return 0;
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
	const layoutProblems = clioDirLayoutProblems(dirs);
	if (layoutProblems.length > 0) {
		printError(
			`uninstall refused an unsafe directory layout: ${layoutProblems.join("; ")}. ` +
				"Run `clio-coder doctor` after setting four absolute, distinct, non-nesting roots.",
		);
		return 2;
	}
	const installation = inspectInstallation();
	const method = installation.kind;
	const presenter = createLifecyclePresenter({ json: args.json });
	if (args.inactive) return uninstallInactive(installation, args, presenter);

	presenter.header("Uninstall Clio Coder", "uninstall");
	presenter.step(
		`Installation method: ${method === "source" ? "source symlink" : method === "npm" ? "npm global" : method === "installer" ? "installer" : method}`,
	);

	const configSize = measurePath(dirs.config);
	const dataSize = measurePath(dirs.data);
	const stateSize = measurePath(dirs.state);
	const cacheSize = measurePath(dirs.cache);
	const installerRecord = method === "installer" ? installation.installer : undefined;
	const linkPath = launcherPathFor(installation);
	const inactiveInstall = inactiveInstallerRecord(installation);
	const inactiveSize = inactiveInstall ? measurePath(inactiveInstall.root) : null;
	const linkSize = measurePath(linkPath);
	const launcher = classifyLauncher(linkPath, installation);
	const launcherFiles =
		launcher.kind === "remove" && installerRecord ? (installerExeFiles(linkPath, installerRecord.root) ?? []) : [];
	const runtimeSize = installerRecord ? measurePath(installerRecord.root) : null;
	const shellEdits = detectShellRcEdits(dirname(linkPath));
	const paneHosts = process.platform === "win32" ? [] : privatePaneHosts(dirs.state);
	const npmPrefix = method === "npm" && process.platform !== "win32" ? installation.prefix : null;
	const removePackage = npmPrefix !== null && !args.keepBinary && !args.keepPackage;
	let web: Awaited<ReturnType<typeof prepareGuiUninstall>>;
	try {
		const desktopPrefix =
			process.env.XDG_DATA_HOME && isAbsolute(process.env.XDG_DATA_HOME)
				? process.env.XDG_DATA_HOME
				: join(homedir(), ".local/share");
		web = await prepareGuiUninstall({ stateDir: dirs.state, desktopPrefix });
	} catch (error) {
		presenter.fail(error instanceof Error ? error.message : "Web installation ownership could not be checked.");
		presenter.finish();
		return 1;
	}

	// A root that is not provably Clio's is never deleted recursively; it is kept and named.
	const notClio = (role: "config" | "data" | "state" | "cache", exists: boolean): string | null => {
		const problem = exists ? removableClioRootProblem(role, dirs[role]) : null;
		return problem ? `not a Clio-only directory (${problem}); remove Clio's files inside it by hand` : null;
	};
	const refused = {
		data: args.keepData ? null : notClio("data", dataSize.exists),
		cache: notClio("cache", cacheSize.exists),
		config: args.keepConfig ? null : notClio("config", configSize.exists),
		state: notClio("state", stateSize.exists),
	};

	// The state root's own children (telemetry, sessions) are inside the State row
	// and go with it; listing them again as separate removals double-counted the
	// bytes and promised per-child results that one recursive delete never
	// produces.
	const items: LifecycleItem[] = [
		{
			label: "Data",
			path: dirs.data,
			bytes: dataSize.bytes,
			status: args.keepData ? "keep" : refused.data ? "skip" : dataSize.exists ? "remove" : "absent",
			detail: args.keepData ? "kept by --keep-data" : (refused.data ?? undefined),
		},
		{
			label: "Cache",
			path: dirs.cache,
			bytes: cacheSize.bytes,
			status: refused.cache ? "skip" : cacheSize.exists ? "remove" : "absent",
			detail: refused.cache ?? undefined,
		},
		{
			label: "Config",
			path: dirs.config,
			bytes: configSize.bytes,
			status: args.keepConfig ? "keep" : refused.config ? "skip" : configSize.exists ? "remove" : "absent",
			detail: args.keepConfig ? "kept by --keep-config" : (refused.config ?? undefined),
		},
		{
			label: "State",
			path: dirs.state,
			bytes: stateSize.bytes,
			status: refused.state ? "skip" : stateSize.exists ? "remove" : "absent",
			detail: refused.state ?? (stateSize.exists ? "sessions, telemetry" : undefined),
		},
		{
			label: "Launcher",
			path: linkPath,
			bytes: linkSize.bytes,
			status: launcherItemStatus(launcher, !args.keepBinary),
			detail: launcherItemDetail(launcher, !args.keepBinary),
		},
		...launcherFiles.map(
			(file): LifecycleItem => ({
				label: "Launcher file",
				path: file,
				bytes: measurePath(file).bytes,
				status: args.keepBinary ? "keep" : "remove",
				detail: args.keepBinary ? "kept by --keep-binary" : undefined,
			}),
		),
	];
	if (installerRecord && runtimeSize) {
		items.push({
			label: "Runtime and versions",
			path: installerRecord.root,
			bytes: runtimeSize.bytes,
			status: !runtimeSize.exists ? "absent" : !args.keepBinary ? "remove" : "skip",
			detail: !args.keepBinary ? `Node v${installerRecord.nodeVersion} and installed versions` : "kept by --keep-binary",
		});
	}
	if (inactiveInstall && inactiveSize) {
		items.push({
			label: "Inactive install",
			path: inactiveInstall.root,
			bytes: inactiveSize.bytes,
			status: args.keepBinary ? "skip" : "remove",
			detail: args.keepBinary ? "kept by --keep-binary" : "installer root this binary does not run from",
		});
	}
	for (const item of web.items) items.push({ ...item, status: "remove", detail: "verified app ownership" });
	for (const item of web.unmanaged)
		items.push({ ...item, status: "skip", detail: "this build has no graphical application to remove it with" });
	// The background service reads its configuration from state/gui. Deleting that would strand the
	// service with nothing left to uninstall it by, so state/gui stays whenever anything is unmanaged.
	const keepGuiState = web.unmanaged.length > 0 && existsSync(join(dirs.state, "gui"));
	if (keepGuiState) {
		const state = items.find((item) => item.label === "State");
		if (state && !refused.state) state.detail = "sessions, telemetry; gui is kept";
	}

	for (const socket of paneHosts)
		items.push({
			label: "Pane host",
			path: socket,
			status: "remove",
			detail: "Clio's private herdr host; stopped first",
		});
	if (npmPrefix !== null)
		items.push({
			label: "npm package",
			path: installation.root,
			status: removePackage ? "remove" : "skip",
			detail: removePackage
				? `npm uninstall -g --prefix ${shortenPath(npmPrefix)}, run last`
				: `kept by ${args.keepPackage ? "--keep-package" : "--keep-binary"}`,
		});
	// Only the exact block install.sh wrote is removed, and only with the launcher it
	// points at; any other mention is reported and never edited.
	// The block put a shared directory on PATH, and other tools (pipx, uv, pip --user)
	// rely on it once they install there, so it goes only when the launcher was alone.
	const binShared = otherBinEntries(dirname(linkPath), linkPath).length > 0;
	const removePathBlocks = !args.keepBinary && launcher.kind !== "keep" && !binShared;
	const pathBlockKept =
		args.keepBinary || launcher.kind === "keep" ? "kept with the launcher" : sharedBinReason(linkPath);
	for (const { file, lines, block } of shellEdits) {
		if (block)
			items.push({
				label: "PATH block",
				path: file,
				status: removePathBlocks ? "remove" : "skip",
				detail: removePathBlocks ? `the two lines marked "${PATH_BLOCK_MARK}"` : pathBlockKept,
			});
		if (lines.length)
			items.push({
				label: "Shell config",
				path: file,
				status: "skip",
				detail: `mentions clio-coder on lines ${lines.join(", ")}; edit it by hand`,
			});
	}

	presenter.listItems("The following will be removed", items);
	if (web.unmanaged.length > 0) {
		presenter.warn(
			`Graphical application files stay in place${keepGuiState ? `, with ${shortenPath(join(dirs.state, "gui"))}` : ""}`,
		);
		presenter.commandAdvice(GUI_UNINSTALL_ADVICE.lead, GUI_UNINSTALL_ADVICE.command);
	}

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
	const advice = binaryRemovalAdvice(installation, linkPath);

	if (refuseForOpenSessions(dirs.state, presenter, args.dryRun)) {
		presenter.finish();
		return 1;
	}

	if (args.dryRun) {
		presenter.warn("Dry run: no changes made");
		if (
			!(method === "installer" && !args.keepBinary) &&
			(method !== "source" || (launcher.kind !== "absent" && (args.keepBinary || launcher.kind === "keep")))
		)
			presenter.commandAdvice(advice.lead, advice.command);
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

	let installLock: string | null = null;
	let deferredLock = false;
	const removedInstall = installerRecord ?? (args.keepBinary ? null : inactiveInstall);
	if (removedInstall) {
		installLock = join(removedInstall.root, ".install-lock");
		try {
			mkdirSync(installLock);
			safeResourceWrite(join(installLock, "pid"), `${process.pid}\n`);
			safeResourceWrite(join(installLock, "uninstall"), "1\n");
		} catch (error) {
			presenter.fail(
				"Native installation is locked; retry after the installer exits",
				error instanceof Error ? error.message : String(error),
			);
			presenter.finish();
			return 1;
		}
	}
	try {
		if (removedInstall) {
			const active = join(removedInstall.root, ".active");
			const own = new Set([process.pid, Number(process.env.CLIO_CODER_LAUNCHER_PID)]);
			if (existsSync(active)) {
				for (const name of readdirSync(active)) {
					const pid = Number(name.replace(/\.json$/, ""));
					if (!Number.isSafeInteger(pid) || pid <= 0 || own.has(pid)) continue;
					let live = true;
					try {
						process.kill(pid, 0);
					} catch (error) {
						live = !(error instanceof Error && "code" in error && error.code === "ESRCH");
					}
					if (live) {
						presenter.fail(`Another native session (pid ${pid}) is still running; close it before uninstalling`);
						presenter.finish();
						return 1;
					}
				}
			}
		}
		if (
			process.platform === "win32" &&
			!args.keepBinary &&
			installerRecord?.pathAdded &&
			installerRecord.pathEntry === dirname(installerRecord.launcher)
		) {
			const entry = `'${installerRecord.pathEntry.replaceAll("'", "''")}'`;
			const script = `$ErrorActionPreference='Stop'; $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$true); if ($key -and ($key.GetValueNames() -contains 'Path')) { try { $raw=[string]$key.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames); $kind=$key.GetValueKind('Path'); $parts=@($raw -split ';' | Where-Object { $_ -cne ${entry} }); $next=$parts -join ';'; if ($next -cne $raw) { $key.SetValue('Path',$next,$kind); [Environment]::SetEnvironmentVariable('CLIO_CODER_PATH_REFRESH',$null,'User') } } finally { $key.Dispose() } }`;
			const result = await runCommandVector(
				"powershell.exe",
				[
					"-NoProfile",
					"-NonInteractive",
					"-ExecutionPolicy",
					"Bypass",
					"-EncodedCommand",
					Buffer.from(script, "utf16le").toString("base64"),
				],
				{ timeoutMs: 30_000 },
			);
			if (result.exitCode !== 0) {
				presenter.fail("Could not remove the PATH entry the installer added", result.stderr);
				presenter.finish();
				return 1;
			}
			presenter.completedStep("Removed only the PATH entry the installer added");
		}
		const failures: RemovalFailure[] = [];
		const kept: string[] = [];
		const stayed = new Set<string>();
		// The pinned herdr binary lives in the data root; its server goes first.
		for (const socket of paneHosts) {
			if (await stopPaneHost(socket)) presenter.completedStep(`Stopped the pane host at ${shortenPath(socket)}`);
			else {
				stayed.add(`Pane host|${socket}`);
				kept.push(`Pane host: ${shortenPath(socket)} (it did not stop; it exits with its terminal)`);
			}
		}
		try {
			await stopLegacyDocsBeforeRemoval();
			await web.remove();
			for (const item of web.items) presenter.completedStep(`Removed ${item.label}`);
		} catch (error) {
			presenter.fail(
				error instanceof Error ? error.message : "Could not stop the graphical installation; Clio state was preserved.",
			);
			presenter.finish();
			return 1;
		}

		if (cacheSize.exists && !refused.cache) {
			const failure = removePath("cache", dirs.cache, false);
			if (failure) failures.push(failure);
			else presenter.completedStep("Removed Cache");
		}

		if (!args.keepData && dataSize.exists && !refused.data) {
			const failure = removePath("data", dirs.data, false);
			if (failure) failures.push(failure);
			else presenter.completedStep("Removed Data");
		}

		if (!args.keepConfig && configSize.exists && !refused.config) {
			const failure = removePath("config", dirs.config, false);
			if (failure) failures.push(failure);
			else presenter.completedStep("Removed Config");
		}

		if (stateSize.exists && !refused.state) {
			const targets = keepGuiState
				? readdirSync(dirs.state)
						.filter((name) => name !== "gui")
						.map((name) => join(dirs.state, name))
				: [dirs.state];
			const failed = targets.flatMap((path) => removePath("state", path, false) ?? []);
			failures.push(...failed);
			if (!failed.length) presenter.completedStep(keepGuiState ? "Removed State, except gui" : "Removed State");
		}

		// Only a symlink into this installation is ever unlinked. Reporting the
		// removal from the request alone announced one for a launcher the
		// classifier had already decided to keep.
		let launcherRemoved = false;
		// Windows keeps a running node.exe locked, and cmd.exe rereads the .cmd
		// launcher after Node exits. Both go once this process and its launcher exit.
		const deferToExit = process.platform === "win32" && installerRecord !== undefined && !args.keepBinary;
		const deferred: string[] = [];
		if (deferToExit && launcher.kind === "remove") {
			deferred.push(linkPath, ...launcherFiles);
			presenter.completedStep("Launcher will be removed when this command exits");
			launcherRemoved = true;
		} else if (!args.keepBinary && launcher.kind === "remove") {
			const failed = [linkPath, ...launcherFiles].flatMap((file) => removePath("launcher", file, false) ?? []);
			failures.push(...failed);
			if (failed.length === 0) {
				presenter.completedStep("Removed launcher");
				launcherRemoved = true;
			}
		}

		const sharedNow = removePathBlocks && otherBinEntries(dirname(linkPath), linkPath).length > 0;
		if (sharedNow)
			for (const { file, block } of shellEdits) {
				if (!block) continue;
				stayed.add(`PATH block|${file}`);
				kept.push(`PATH block: ${shortenPath(file)} (${sharedBinReason(linkPath)})`);
			}
		else if (removePathBlocks)
			for (const { file, block } of shellEdits) {
				if (!block) continue;
				try {
					if (removePathBlock(file, dirname(linkPath)))
						presenter.completedStep(`Removed the PATH block from ${shortenPath(file)}`);
					else {
						stayed.add(`PATH block|${file}`);
						kept.push(`PATH block: ${shortenPath(file)} (it changed since the listing, so it was left alone)`);
					}
				} catch (error) {
					stayed.add(`PATH block|${file}`);
					kept.push(`PATH block: ${shortenPath(file)} (${error instanceof Error ? error.message : String(error)})`);
				}
			}

		// The running Node and package live under this root. Unlinking them is safe
		// on Linux and macOS: the open files stay readable until this process exits.
		let runtimeRemoved = false;
		if (deferToExit && installerRecord && runtimeSize?.exists) {
			deferred.push(...INSTALLER_OWNED_ENTRIES.map((name) => join(installerRecord.root, name)));
			scheduleRemovalAfterExit(deferred, installerRecord.root);
			deferredLock = true;
			presenter.completedStep("Runtime and installed versions will be removed when this command exits");
			runtimeRemoved = true;
		} else if (deferred.length > 0) {
			scheduleRemovalAfterExit(deferred, null);
		} else if (!args.keepBinary && installerRecord && runtimeSize?.exists) {
			// Only what install.sh creates is removed, then the root if it is left
			// empty: --install-dir may have named a directory that holds other files.
			const failed = INSTALLER_OWNED_ENTRIES.flatMap(
				(name) => removePath("runtime", join(installerRecord.root, name), false) ?? [],
			);
			failures.push(...failed);
			if (failed.length === 0) {
				try {
					rmdirSync(installerRecord.root);
				} catch {
					// Other files remain in a shared --install-dir; they are not ours to remove.
				}
				presenter.completedStep("Removed runtime and installed versions");
				runtimeRemoved = true;
			}
		}

		if (inactiveInstall && !args.keepBinary) {
			const failed = INSTALLER_OWNED_ENTRIES.flatMap(
				(name) => removePath("inactive install", join(inactiveInstall.root, name), false) ?? [],
			);
			failures.push(...failed);
			if (failed.length === 0) presenter.completedStep("Removed the inactive install");
		}

		resetXdgCache();

		// Last: npm deletes the package this process runs from, which POSIX allows.
		let packageRemoved = false;
		if (removePackage && npmPrefix !== null && failures.length === 0) {
			const besideNode = join(dirname(process.execPath), "npm");
			const result = await runCommandVector(
				existsSync(besideNode) ? besideNode : "npm",
				["uninstall", "-g", "--prefix", npmPrefix, "@iowarp/clio-coder"],
				{ timeoutMs: 120_000 },
			);
			if (result.exitCode === 0) {
				presenter.completedStep(`Removed the npm package from ${shortenPath(npmPrefix)}`);
				packageRemoved = true;
			} else {
				stayed.add(`npm package|${installation.root}`);
				kept.push(`npm package: npm uninstall exited ${result.exitCode ?? "on a signal"}`);
			}
		}

		if (failures.length > 0) {
			presenter.fail("uninstall did not remove everything");
			reportRemovalFailures(
				`clio-coder uninstall${args.keepBinary ? " --keep-binary" : ""}${args.keepConfig ? " --keep-config" : ""}${args.keepData ? " --keep-data" : ""} --force`,
				failures,
			);
			presenter.finish();
			return 1;
		}

		const installerGone = method === "installer" && runtimeRemoved && launcher.kind !== "keep";
		if (!installerGone && !packageRemoved && (method !== "source" || (launcher.kind !== "absent" && !launcherRemoved)))
			presenter.commandAdvice(advice.lead, advice.command);
		presenter.outcome(
			items
				.filter((item) => item.status === "remove" && !stayed.has(`${item.label}|${item.path}`))
				.map((item) => `${item.label}: ${shortenPath(item.path)}`),
			[
				...items
					.filter((item) => item.status === "keep" || item.status === "skip")
					.map((item) => `${item.label}: ${shortenPath(item.path)}${item.detail ? ` (${item.detail})` : ""}`),
				...kept,
			],
		);
		if (survivor !== null)
			presenter.warn(`Another clio-coder stays on your PATH at ${survivor}; it is a separate install`);
		if (Object.values(refused).some((reason) => reason !== null)) {
			presenter.fail("uninstall kept a root that is not Clio's own; see Kept, and why");
			presenter.finish();
			return 1;
		}

		presenter.message("Thank you for using Clio Coder.");
		presenter.done("Done");
		return 0;
	} finally {
		if (installLock && !deferredLock) {
			rmSync(installLock, { recursive: true, force: true });
			if (removedInstall) {
				try {
					rmdirSync(removedInstall.root);
				} catch {
					/* Other files in a shared install root are preserved. */
				}
			}
		}
	}
}
