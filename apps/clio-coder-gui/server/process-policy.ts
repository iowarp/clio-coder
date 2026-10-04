import { type ChildProcess, spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve, win32 } from "node:path";
import { Worker } from "node:worker_threads";
import { APP_TITLE } from "../contracts/meta.js";
import { type CliCommand, commandPlan } from "./cli-commands.js";
import {
	createStdioTransport,
	processAlive,
	processBirthToken,
	resolveClioDirs,
	resolvePackageRoot,
} from "./clio/http-shims.js";
import { AppProblem } from "./services/problem.js";
import type { WorkerKind, WorkerSettings } from "./worker/protocol.js";

/** All application-owned process/thread creation enters here. Root seams own their internal probes. */
export function startDomainWorker(
	kind: WorkerKind,
	settings: WorkerSettings = {},
	env: NodeJS.ProcessEnv = process.env,
	compiledDirectory?: URL,
): Worker {
	const entry = compiledDirectory
		? new URL(kind === "reads" ? "reads-worker.js" : "ops-worker.js", compiledDirectory)
		: new URL("./worker/source-entry.mjs", import.meta.url);
	return new Worker(entry, { workerData: { ...settings, kind }, env });
}

/** Fixed ACP command: the workspace path is already canonicalized by WorkspaceService. */
export async function startAcpChild(cwd: string, env: NodeJS.ProcessEnv = process.env) {
	const command = await resolveClioCommand(env);
	return createStdioTransport(command.file, [...command.prefix, "acp", "--cwd", cwd, "--permission-timeout", "605000"], {
		cwd,
		env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
	});
}
export async function resolveClioCommand(
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ file: string; prefix: string[] }> {
	const override = env.CLIO_CODER_WEB_CLI;
	if (override) {
		if (!isAbsolute(override)) throw new AppProblem("validation", "CLIO_CODER_WEB_CLI must be an absolute path.");
		const file = await realpath(override).catch(() => {
			throw new AppProblem("unavailable", "The configured Clio CLI cannot be found.");
		});
		if (!(await stat(file)).isFile()) throw new AppProblem("validation", "The configured Clio CLI must be a file.");
		return /\.[cm]?js$/.test(file) ? { file: process.execPath, prefix: [file] } : { file, prefix: [] };
	}
	const checkout = join(resolvePackageRoot(), "dist/cli/index.js");
	if (existsSync(checkout)) return { file: process.execPath, prefix: [await realpath(checkout)] };
	for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
		const file = join(directory, process.platform === "win32" ? "clio-coder.cmd" : "clio-coder");
		try {
			await access(file, constants.X_OK);
			if ((await stat(file)).isFile()) return { file: await realpath(file), prefix: [] };
		} catch {
			/* next PATH entry */
		}
	}
	throw new AppProblem("unavailable", "Build the checkout CLI or set CLIO_CODER_WEB_CLI to its absolute path.");
}
export function signalRecordedChild(pid: number, birthToken: string, signal: "SIGTERM" | "SIGKILL") {
	if (
		!Number.isSafeInteger(pid) ||
		pid <= 0 ||
		birthToken.startsWith("pid-") ||
		processBirthToken(pid) !== birthToken ||
		!processAlive(pid)
	)
		return false;
	try {
		process.kill(process.platform === "win32" ? pid : -pid, signal);
		return true;
	} catch {
		return false;
	}
}
export async function childRunning(pid: number) {
	if (!processAlive(pid)) return false;
	if (process.platform !== "linux") return true;
	try {
		const value = await readFile(`/proc/${pid}/stat`, "utf8");
		return !["Z", "X"].includes(value.slice(value.lastIndexOf(")") + 2).split(" ")[0] ?? "");
	} catch {
		return processAlive(pid);
	}
}

/** Fixed-argv CLI children are owned process groups, independently of ACP sessions. */
export async function runClioCommand(command: CliCommand, cwd: string, env: NodeJS.ProcessEnv = process.env) {
	const plan = commandPlan(command, cwd);
	if (!isAbsolute(cwd) || (await realpath(cwd)) !== cwd || !(await stat(cwd)).isDirectory())
		throw new AppProblem("validation", "CLI workspace must be an existing canonical absolute directory.");
	const executable = await resolveClioCommand(env);
	const child = spawn(executable.file, [...executable.prefix, ...plan.argv], {
		cwd,
		env,
		shell: false,
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
	});
	const birthToken = child.pid ? processBirthToken(child.pid) : "";
	return { child, birthToken };
}

/** One fixed interactive configure child; prompt replies travel on stdin, never argv. */
export async function startConfigureChild(env: NodeJS.ProcessEnv = process.env) {
	const executable = await resolveClioCommand(env);
	const child = spawn(executable.file, [...executable.prefix, "configure", "--gui-host"], {
		env,
		shell: false,
		detached: process.platform !== "win32",
		stdio: ["pipe", "pipe", "pipe"],
	});
	return { child, birthToken: child.pid ? processBirthToken(child.pid) : "" };
}

export function stopClioCommand(child: ChildProcess, birthToken: string | null, signal: "SIGTERM" | "SIGKILL") {
	if (!child.pid || child.exitCode !== null || child.signalCode !== null) return false;
	if (birthToken && !birthToken.startsWith("pid-") && process.platform !== "win32")
		return signalRecordedChild(child.pid, birthToken, signal);
	// A live Node ChildProcess handle still owns the unreaped child; this is not a persisted PID lookup.
	return child.kill(signal);
}

export function browserCommand(
	url: string,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
) {
	const parsed = new URL(url);
	if (
		parsed.protocol !== "http:" ||
		parsed.hostname !== "127.0.0.1" ||
		!parsed.port ||
		parsed.username ||
		parsed.password
	)
		throw new Error("The browser can only open this app's loopback HTTP URL.");
	if (platform === "linux") return { file: "xdg-open", argv: [url] };
	if (platform === "darwin") return { file: "open", argv: [url] };
	if (platform === "win32") {
		// Never cmd.exe or `start`, which interpret shell metacharacters even with shell:false. The
		// system rundll32 is named by absolute path so a PATH entry cannot stand in for it, and
		// FileProtocolHandler hands the one URL argument to the registered browser. Not yet accepted
		// on a Windows desktop, which is why a bare launch still prints the link instead.
		const root = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
		if (!win32.isAbsolute(root)) throw new Error("SystemRoot is not an absolute Windows path.");
		return { file: win32.join(root, "System32", "rundll32.exe"), argv: ["url.dll,FileProtocolHandler", url] };
	}
	throw new Error(
		"Automatic browser opening is supported on Linux, macOS and Windows. Open the printed URL in your browser.",
	);
}

/**
 * Whether a bare launch should open a browser without being asked. Only a person at an interactive
 * terminal with a desktop to open it on gets one: a pipe, a script, a test or an SSH session without
 * a forwarded display prints the link instead, and Windows prints it until its opener is accepted on a Windows desktop; --open still uses it.
 */
export function autoOpenBrowser(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	interactive = process.stdout.isTTY === true,
) {
	if (!interactive) return false;
	if (platform === "darwin") return true;
	if (platform !== "linux") return false;
	// WSL opens the Windows browser through xdg-open or wslview even without a Linux display.
	return !!(env.DISPLAY || env.WAYLAND_DISPLAY || env.WSL_DISTRO_NAME);
}

/** Windows PowerShell as WSL interop reaches it; the shortcut and folder scripts below are the only users. */
export const WINDOWS_POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
/** Browsers that can show the app in its own window, in the order a person would expect them. */
const WINDOWS_APP_BROWSERS = [
	"/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
	"/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
	"/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
	"/mnt/c/Program Files/Microsoft/Edge/Application/msedge.exe",
];

/** WSL with Windows interop. Linux's own opener would reach a Windows tab, never an app window. */
export function isWsl(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
	exists: (path: string) => boolean = existsSync,
) {
	return platform === "linux" && !!env.WSL_DISTRO_NAME && exists(WINDOWS_POWERSHELL);
}

/**
 * From WSL the app opens as a standalone Chrome or Edge window on the Windows desktop, which is how an
 * installed web app presents itself. The URL stays one literal argument; nothing is interpreted by a shell.
 */
export function windowsAppCommand(
	url: string,
	env: NodeJS.ProcessEnv = process.env,
	exists: (path: string) => boolean = existsSync,
) {
	browserCommand(url, "linux", env);
	if (!isWsl(env, "linux", exists)) return null;
	const file = WINDOWS_APP_BROWSERS.find((candidate) => exists(candidate));
	return file ? { file, argv: [`--app=${url}`] } : null;
}

// Finds an open app window on the Windows desktop and brings it forward. Chrome and Edge top-level
// windows share one window class, and a browser tab's title ends with the browser's own name, so a
// title that ends with the app's name is an app window: one this launcher opened, or the app installed
// from the browser. Windows are visited front to back, so the one last used is taken.
//
// SetForegroundWindow and WScript.Shell's AppActivate only flash the taskbar button when the caller is
// not the foreground process, which a launcher never is. SwitchToThisWindow is the Alt+Tab switch: it
// takes the foreground and restores a minimized window. Asked for the window already in front it
// switches away instead, so that window is left alone. The switch lands a moment after the call and is
// lost if this process has exited by then, so the script waits for it, at most half a second. The C#
// holds no single quote, because it travels inside a PowerShell single-quoted string, and stays within
// what Windows PowerShell compiles.
const FOCUS_WINDOW_SOURCE = [
	"using System; using System.Diagnostics; using System.Runtime.InteropServices; using System.Text; using System.Threading;",
	"public static class ClioDesktop {",
	"delegate bool Visit(IntPtr window, IntPtr state);",
	'[DllImport("user32.dll")] static extern bool EnumWindows(Visit visit, IntPtr state);',
	'[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);',
	'[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int count);',
	'[DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr window);',
	'[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int count);',
	'[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);',
	'[DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();',
	'[DllImport("user32.dll")] static extern void SwitchToThisWindow(IntPtr window, bool altTab);',
	"public static bool Focus(string suffix) {",
	"IntPtr found = IntPtr.Zero;",
	"EnumWindows((window, state) => {",
	"if (!IsWindowVisible(window)) return true;",
	"StringBuilder kind = new StringBuilder(64);",
	'if (GetClassName(window, kind, kind.Capacity) == 0 || kind.ToString() != "Chrome_WidgetWin_1") return true;',
	"StringBuilder title = new StringBuilder(GetWindowTextLength(window) + 1);",
	"GetWindowText(window, title, title.Capacity);",
	"if (!title.ToString().EndsWith(suffix, StringComparison.Ordinal)) return true;",
	"uint process; GetWindowThreadProcessId(window, out process);",
	'try { string owner = Process.GetProcessById((int)process).ProcessName; if (owner != "chrome" && owner != "msedge") return true; }',
	"catch (Exception) { return true; }",
	"found = window; return false; }, IntPtr.Zero);",
	"if (found == IntPtr.Zero) return false;",
	"if (GetForegroundWindow() != found) SwitchToThisWindow(found, true);",
	"for (int wait = 0; wait < 25 && GetForegroundWindow() != found; wait++) Thread.Sleep(20);",
	"return true; } }",
].join(" ");
const FOCUS_WINDOW_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	`Add-Type -TypeDefinition '${FOCUS_WINDOW_SOURCE}'`,
	"if ([ClioDesktop]::Focus($env:CLIO_WIN_TITLE)) { [Console]::Out.Write('focused') } else { [Console]::Out.Write('none') }",
].join("; ");

/**
 * Brings an open app window to the front on the Windows desktop and says whether there was one. A
 * script that fails or times out counts as no window, so the launch falls back to opening one.
 */
export async function focusAppWindow() {
	try {
		return (await runWindowsPowerShell(FOCUS_WINDOW_SCRIPT, { CLIO_WIN_TITLE: APP_TITLE }, 5_000)) === "focused";
	} catch {
		return false;
	}
}

/**
 * Opens the installed app. Under WSL that is a standalone Chrome or Edge window; everywhere else, and when
 * no such browser is installed, it is the ordinary opener. Only launcher entry points use it, so a foreground
 * server or a test that asks for a browser still goes through the system opener it was given.
 *
 * Each launch delivers a fresh local link, so a window left on a retired port or token can reconnect.
 */
export async function openApp(
	url: string,
	env: NodeJS.ProcessEnv = process.env,
	directory = join(resolveClioDirs().state, "gui/background"),
): Promise<"focused" | "opened"> {
	if (isWsl(env)) {
		const { openManagedWindowsApp } = await import("./launcher/windows.js");
		if (await openManagedWindowsApp(url, directory)) return "opened";
	}
	const app = windowsAppCommand(url, env);
	if (!app) {
		await openBrowser(url, env);
		return "opened";
	}
	// A title cannot prove that a window has the current origin or token. Always deliver the launch link.
	// A first launch keeps this process alive for the browser's whole life, so it is released, not awaited.
	const child = spawn(app.file, app.argv, { cwd: "/mnt/c/Windows", env, shell: false, detached: true, stdio: "ignore" });
	await new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.once("spawn", resolve);
	});
	child.unref();
	return "opened";
}

/** The OS opener owns the browser. Reap only our short-lived opener, never the user's browser. */
export async function openBrowser(url: string, env: NodeJS.ProcessEnv = process.env) {
	const command = browserCommand(url, process.platform, env);
	const child = spawn(command.file, command.argv, { env, shell: false, stdio: "ignore" });
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
		}, 10_000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolve();
			else reject(new Error("The desktop could not open a browser. Open the printed URL manually."));
		});
	});
}

export function serviceCommand(
	action: "show" | "enable" | "start" | "restart" | "stop" | "disable" | "reload",
	unit: string,
	unitFile: string,
) {
	if (!/^clio-coder-gui-[a-f0-9]{12}\.service$/.test(unit) || !isAbsolute(unitFile) || !unitFile.endsWith(`/${unit}`))
		throw new Error("Invalid Clio background service identity.");
	if (action === "reload") return ["--user", "daemon-reload"];
	if (action === "show")
		return ["--user", "show", unit, "--property=FragmentPath,ActiveState,UnitFileState,MainPID,Result"];
	if (action === "enable") return ["--user", "enable", "--now", "--", unitFile];
	if (action === "disable") return ["--user", "disable", "--now", "--", unit];
	return ["--user", action, "--", unit];
}
function isTemporaryUnitFile(unitFile: string): boolean {
	const roots = [tmpdir(), "/tmp", "/var/tmp"].map((root) => resolve(root));
	const target = resolve(unitFile);
	return roots.some((root) => target.startsWith(`${root}/`));
}

export async function controlService(
	action: Parameters<typeof serviceCommand>[0],
	unit: string,
	unitFile: string,
	env: NodeJS.ProcessEnv = process.env,
) {
	if (process.platform !== "linux")
		throw new Error("Background setup currently requires Linux with a systemd user session.");
	// `systemctl --user enable` links the unit into the user manager's own
	// ~/.config/systemd/user and default.target.wants, which no environment
	// override redirects. A unit file in a temp directory is a test fixture, and
	// enabling it once left real login units pointing at deleted scratch paths.
	if (action === "enable" && isTemporaryUnitFile(unitFile) && env.CLIO_CODER_REAL_SYSTEMD !== "1")
		throw new Error("Refusing to enable a background service whose unit file lives in a temporary directory.");
	const child = spawn("systemctl", serviceCommand(action, unit, unitFile), {
		env,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
	});
	return new Promise<string>((resolve, reject) => {
		const output: Buffer[] = [];
		let bytes = 0,
			exceeded = false;
		const timer = setTimeout(() => {
			exceeded = true;
			child.kill("SIGKILL");
		}, 20_000);
		const collect = (chunk: Buffer, stdout: boolean) => {
			bytes += chunk.length;
			if (bytes > 65_536) {
				exceeded = true;
				child.kill("SIGKILL");
			} else if (stdout) output.push(chunk);
		};
		child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
		child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
		child.once("error", () => {
			clearTimeout(timer);
			reject(new Error("systemctl is unavailable. Background setup requires a running Linux systemd user session."));
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (code === 0 && !exceeded) resolve(Buffer.concat(output).toString("utf8"));
			else
				reject(new Error(`Background service ${action} failed. Check the user service manager and journal for ${unit}.`));
		});
	});
}

/**
 * Runs one fixed PowerShell script on the Windows side. Values travel as environment variables forwarded
 * through WSLENV, never inside the script text, so no path or argument is ever parsed as PowerShell.
 */
export async function runWindowsPowerShell(script: string, values: Record<string, string> = {}, timeoutMs = 30_000) {
	for (const name of Object.keys(values))
		if (!/^CLIO_WIN_[A-Z0-9_]+$/.test(name)) throw new Error("Invalid Windows script variable name.");
	if (!isWsl()) throw new Error("Windows integration requires WSL with Windows interop.");
	const env: NodeJS.ProcessEnv = {
		...process.env,
		...values,
		WSLENV: [...(process.env.WSLENV ? [process.env.WSLENV] : []), ...Object.keys(values)].join(":"),
	};
	const child = spawn(
		WINDOWS_POWERSHELL,
		["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
		{ cwd: "/mnt/c/Windows", env, shell: false, stdio: ["ignore", "pipe", "pipe"] },
	);
	return new Promise<string>((resolve, reject) => {
		const output: Buffer[] = [];
		let bytes = 0,
			stderr = "",
			exceeded = false;
		const timer = setTimeout(() => {
			exceeded = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > 65_536) {
				exceeded = true;
				child.kill("SIGKILL");
			} else output.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < 400) stderr += chunk.toString("utf8");
		});
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (code === 0 && !exceeded) resolve(Buffer.concat(output).toString("utf8").replace(/\r/g, ""));
			else
				reject(new Error(`Windows PowerShell failed${stderr ? `: ${stderr.trim().split("\n")[0]?.slice(0, 200)}` : "."}`));
		});
	});
}

/** What a folder dialog run produced. `raw` is the dialog's own spelling, Windows paths included. */
export type FolderPickerResult =
	| { status: "picked"; raw: string; windows: boolean }
	| { status: "cancelled" }
	| { status: "unavailable"; reason: string };
export type FolderPickerPlan =
	| { file: string; argv: string[]; cwd?: string; windows: boolean; cancelCodes: number[] }
	| { unavailable: string };

// The dialog is owned by a hidden topmost form so it opens in front of the browser rather than behind it.
// Exit 3 is this script's cancel; output is UTF-8 so non-ASCII folder names survive the pipe.
const FOLDER_DIALOG_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
	"Add-Type -AssemblyName System.Windows.Forms",
	"$owner = New-Object System.Windows.Forms.Form",
	"$owner.TopMost = $true",
	"$owner.ShowInTaskbar = $false",
	"$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
	"$dialog.Description = 'Open workspace'",
	"$dialog.ShowNewFolderButton = $true",
	"$result = $dialog.ShowDialog($owner)",
	"$owner.Dispose()",
	"if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) { [Console]::Out.Write($dialog.SelectedPath); exit 0 }",
	"exit 3",
].join("; ");
const powershellArgs = ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command"];

function onPath(name: string, env: NodeJS.ProcessEnv, exists: (path: string) => boolean) {
	for (const directory of (env.PATH ?? "").split(delimiter).filter((entry) => isAbsolute(entry))) {
		const file = join(directory, name);
		if (exists(file)) return file;
	}
	return null;
}

/**
 * The fixed native folder dialog for this host. Only the home directory reaches argv, as one literal
 * argument; the PowerShell script is a constant. WSL prefers the Windows dialog over a WSLg one, because
 * that is the desktop the person is looking at.
 */
export function folderPickerCommand(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
	home = homedir(),
	exists: (path: string) => boolean = existsSync,
): FolderPickerPlan {
	if (platform === "win32") {
		const root = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
		if (!win32.isAbsolute(root)) return { unavailable: "SystemRoot is not an absolute Windows path." };
		return {
			file: win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
			argv: [...powershellArgs, FOLDER_DIALOG_SCRIPT],
			windows: true,
			cancelCodes: [3],
		};
	}
	if (platform === "darwin")
		return {
			file: "/usr/bin/osascript",
			argv: ["-e", 'POSIX path of (choose folder with prompt "Open workspace")'],
			windows: false,
			// osascript exits 1 with "User canceled. (-128)"; it is told apart from failure by stderr.
			cancelCodes: [],
		};
	if (platform !== "linux") return { unavailable: "No native folder dialog is supported on this platform." };
	if (isWsl(env, platform, exists))
		return {
			file: WINDOWS_POWERSHELL,
			argv: [...powershellArgs, FOLDER_DIALOG_SCRIPT],
			cwd: "/mnt/c/Windows",
			windows: true,
			cancelCodes: [3],
		};
	if (!env.DISPLAY && !env.WAYLAND_DISPLAY)
		return { unavailable: "No desktop display is available to show a folder dialog. Type the path instead." };
	const zenity = onPath("zenity", env, exists);
	if (zenity)
		return {
			file: zenity,
			argv: ["--file-selection", "--directory", "--title=Open workspace", `--filename=${home.replace(/\/?$/, "/")}`],
			windows: false,
			cancelCodes: [1, 5],
		};
	const kdialog = onPath("kdialog", env, exists);
	if (kdialog)
		return {
			file: kdialog,
			argv: ["--title", "Open workspace", "--getexistingdirectory", home],
			windows: false,
			cancelCodes: [1],
		};
	return { unavailable: "Install zenity or kdialog to browse folders, or type the path instead." };
}

/** Runs the native folder dialog once. The dialog is killed on abort or after `timeoutMs`. */
export async function runFolderPicker(
	signal?: AbortSignal,
	timeoutMs = 300_000,
	plan: FolderPickerPlan = folderPickerCommand(),
	env: NodeJS.ProcessEnv = process.env,
): Promise<FolderPickerResult> {
	if ("unavailable" in plan) return { status: "unavailable", reason: plan.unavailable };
	if (signal?.aborted) return { status: "cancelled" };
	const child = spawn(plan.file, plan.argv, {
		...(plan.cwd !== undefined ? { cwd: plan.cwd } : {}),
		env,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
	});
	return new Promise<FolderPickerResult>((resolve) => {
		const output: Buffer[] = [];
		let bytes = 0,
			stderr = "",
			ended: "timeout" | "abort" | "overflow" | null = null;
		const stop = (reason: NonNullable<typeof ended>) => {
			ended ??= reason;
			child.kill("SIGKILL");
		};
		const timer = setTimeout(() => stop("timeout"), timeoutMs);
		const onAbort = () => stop("abort");
		signal?.addEventListener("abort", onAbort, { once: true });
		const finish = (result: FolderPickerResult) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve(result);
		};
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > 65_536) stop("overflow");
			else output.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderr.length < 400) stderr += chunk.toString("utf8");
		});
		child.once("error", (error) =>
			finish({
				status: "unavailable",
				reason: `The folder dialog could not start: ${error instanceof Error ? error.message : String(error)}`,
			}),
		);
		child.once("close", (code) => {
			if (ended === "abort") return finish({ status: "cancelled" });
			if (ended === "timeout") return finish({ status: "unavailable", reason: "The folder dialog timed out." });
			if (ended === "overflow")
				return finish({ status: "unavailable", reason: "The folder dialog returned an oversized answer." });
			const raw = Buffer.concat(output)
				.toString("utf8")
				.replace(/\r?\n$/, "")
				.replace(/\r/g, "");
			if (code === 0 && raw) return finish({ status: "picked", raw, windows: plan.windows });
			if ((code !== null && plan.cancelCodes.includes(code)) || /User canceled|\(-128\)/.test(stderr))
				return finish({ status: "cancelled" });
			finish({
				status: "unavailable",
				reason: `The folder dialog failed${stderr ? `: ${stderr.trim().split("\n")[0]?.slice(0, 200)}` : "."}`,
			});
		});
	});
}
