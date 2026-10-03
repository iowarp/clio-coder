import { spawn } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmdirSync,
	rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { resolvePackageRoot } from "../core/package-root.js";
import { runCommandVector } from "../core/safe-exec.js";
import { safeResourceWrite } from "../core/safe-resource-write.js";
import { clioDirLayoutProblems, resetXdgCache, resolveClioDirs } from "../core/xdg.js";
import type { Installation } from "../domains/lifecycle/install-method.js";
import {
	INSTALLER_LAUNCHER_MARK,
	inspectInstallation,
	installationCommand,
} from "../domains/lifecycle/install-method.js";
import { GUI_UNINSTALL_ADVICE, prepareGuiUninstall } from "./gui.js";
import { stopLegacyDocsBeforeRemoval } from "./legacy-docs-cleanup.js";
import type { LifecycleItem } from "./lifecycle-presenter.js";
import { createLifecyclePresenter, measurePath, shortenPath } from "./lifecycle-presenter.js";
import type { RemovalFailure } from "./removal.js";
import { removePath, reportRemovalFailures } from "./removal.js";
import { printError } from "./shared.js";

const HELP = `clio-coder uninstall [--remove-binary] [--keep-config] [--keep-data] [--dry-run] [--force] [--json]

Remove all Clio Coder state: the config, data, state, and cache roots.

Per-project \`.clio-coder/\` directories sit outside those roots and are never
removed here. Every project Clio has run in is recorded in the session metadata,
so the real run and --dry-run both list them and name the command that clears one.
Shell startup files are reported, never edited.
Owned graphical background services are stopped and disabled before their state is
removed; their desktop launchers are removed using the app's ownership manifests.

Flags:
  --keep-config    preserve the configuration root (settings.yaml, credentials)
  --keep-data      preserve the data root (memory, evidence, vendored tools)
  --remove-binary  also remove the launcher symlink when it points at this
                   installation. A real file, or a link into a different clio-coder
                   installation, is kept and reported. For an install.sh install,
                   also remove its launcher, its private Node and every installed version.
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

/**
 * Delete `paths`, then `emptyRoot` if nothing else is left in it, from a
 * detached cmd.exe once this process and its .cmd launcher have exited. A
 * one-line `cmd /c` cannot wait on a PID, so it waits a few seconds and makes a
 * second pass for a slow exit. cmd.exe, not PowerShell: a detached PowerShell
 * gets no console and exits before running anything.
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
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-EncodedCommand",
			Buffer.from(script, "utf16le").toString("base64"),
		],
		{
			detached: true,
			stdio: "ignore",
			windowsHide: true,
		},
	).unref();
}

function launcherLinkPath(): string {
	const binDir = process.env.CLIO_CODER_BIN_DIR?.trim() || join(homedir(), ".local", "bin");
	return join(binDir, "clio-coder");
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
function detectShellRcEdits(): string[] {
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
	const results: string[] = [];
	for (const file of new Set(candidates)) {
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

	presenter.header("Uninstall Clio Coder", "uninstall");
	presenter.step(
		`Installation method: ${method === "source" ? "source symlink" : method === "npm" ? "npm global" : method === "installer" ? "install.sh" : method}`,
	);

	const configSize = measurePath(dirs.config);
	const dataSize = measurePath(dirs.data);
	const stateSize = measurePath(dirs.state);
	const cacheSize = measurePath(dirs.cache);
	const installerRecord = method === "installer" ? installation.installer : undefined;
	const linkPath =
		installerRecord?.launcher ||
		(method === "npm" && installation.prefix ? join(installation.prefix, "bin", "clio-coder") : launcherLinkPath());
	const linkSize = measurePath(linkPath);
	const launcher = classifyLauncher(linkPath, installation);
	const runtimeSize = installerRecord ? measurePath(installerRecord.root) : null;
	const shellEdits = detectShellRcEdits();
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
	if (installerRecord && runtimeSize) {
		items.push({
			label: "Runtime and versions",
			path: installerRecord.root,
			bytes: runtimeSize.bytes,
			status: !runtimeSize.exists ? "absent" : args.removeBinary ? "remove" : "skip",
			detail: args.removeBinary
				? `Node v${installerRecord.nodeVersion} and installed versions`
				: "kept; --remove-binary removes it",
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
		if (state) state.detail = "sessions, audit, receipts; gui is kept";
	}

	// A login file is reported, never edited; see detectShellRcEdits.
	for (const file of shellEdits) {
		items.push({ label: "Shell config", path: file, status: "skip", detail: "mentions clio-coder; edit it by hand" });
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

	if (args.dryRun) {
		presenter.warn("Dry run: no changes made");
		if (
			!(method === "installer" && args.removeBinary) &&
			(method !== "source" || (launcher.kind !== "absent" && !args.removeBinary))
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
	if (installerRecord) {
		installLock = join(installerRecord.root, ".install-lock");
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
		if (installerRecord) {
			const active = join(installerRecord.root, ".active");
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
			args.removeBinary &&
			installerRecord?.manager === "winget" &&
			installerRecord.pathAdded &&
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
				presenter.fail("Could not remove the manager-owned PATH addition", result.stderr);
				presenter.finish();
				return 1;
			}
			presenter.completedStep("Removed only the manager-owned PATH addition");
		}
		const failures: RemovalFailure[] = [];
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
		// removal from `--remove-binary` alone announced one for a launcher the
		// classifier had already decided to keep.
		let launcherRemoved = false;
		// Windows keeps a running node.exe locked, and cmd.exe rereads the .cmd
		// launcher after Node exits. Both go once this process and its launcher exit.
		const deferToExit = process.platform === "win32" && installerRecord !== undefined && args.removeBinary;
		const deferred: string[] = [];
		if (deferToExit && launcher.kind === "remove") {
			deferred.push(linkPath);
			presenter.completedStep("Launcher will be removed when this command exits");
			launcherRemoved = true;
		} else if (args.removeBinary && launcher.kind === "remove") {
			const failure = removePath("launcher", linkPath, false);
			if (failure) failures.push(failure);
			else {
				presenter.completedStep("Removed launcher");
				launcherRemoved = true;
			}
		}

		// The running Node and package live under this root. Unlinking them is safe
		// on Linux and macOS: the open files stay readable until this process exits.
		let runtimeRemoved = false;
		if (deferToExit && installerRecord && runtimeSize?.exists) {
			deferred.push(
				...["runtime", "versions", "launchers", "launcher.cjs", ".active", ".installer-owner", "install.json"].map((name) =>
					join(installerRecord.root, name),
				),
			);
			scheduleRemovalAfterExit(deferred, installerRecord.root);
			deferredLock = true;
			presenter.completedStep("Runtime and installed versions will be removed when this command exits");
			runtimeRemoved = true;
		} else if (deferred.length > 0) {
			scheduleRemovalAfterExit(deferred, null);
		} else if (args.removeBinary && installerRecord && runtimeSize?.exists) {
			// Only what install.sh creates is removed, then the root if it is left
			// empty: --install-dir may have named a directory that holds other files.
			const failed = [
				"runtime",
				"versions",
				"launchers",
				"launcher.cjs",
				".active",
				".installer-owner",
				"install.json",
			].flatMap((name) => removePath("runtime", join(installerRecord.root, name), false) ?? []);
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

		const installerGone = method === "installer" && runtimeRemoved && launcher.kind !== "keep";
		if (!installerGone && (method !== "source" || (launcher.kind !== "absent" && !launcherRemoved)))
			presenter.commandAdvice(advice.lead, advice.command);
		if (survivor !== null)
			presenter.warn(`Another clio-coder stays on your PATH at ${survivor}; it is a separate install`);

		presenter.message("Thank you for using Clio Coder.");
		presenter.done("Done");
		return 0;
	} finally {
		if (installLock && !deferredLock) {
			rmSync(installLock, { recursive: true, force: true });
			if (installerRecord) {
				try {
					rmdirSync(installerRecord.root);
				} catch {
					/* Other files in a shared install root are preserved. */
				}
			}
		}
	}
}
