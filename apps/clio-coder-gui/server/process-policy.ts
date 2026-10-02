import { type ChildProcess, spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve, win32 } from "node:path";
import { Worker } from "node:worker_threads";
import { type CliCommand, commandPlan } from "./cli-commands.js";
import { createStdioTransport, processAlive, processBirthToken, resolvePackageRoot } from "./clio/http-shims.js";
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

/**
 * Opens the installed app. Under WSL that is a standalone Chrome or Edge window; everywhere else, and when
 * no such browser is installed, it is the ordinary opener. Only launcher entry points use it, so a foreground
 * server or a test that asks for a browser still goes through the system opener it was given.
 */
export async function openApp(url: string, env: NodeJS.ProcessEnv = process.env) {
	const app = windowsAppCommand(url, env);
	if (!app) return openBrowser(url, env);
	// A first launch keeps this process alive for the browser's whole life, so it is released, not awaited.
	const child = spawn(app.file, app.argv, { cwd: "/mnt/c/Windows", env, shell: false, detached: true, stdio: "ignore" });
	await new Promise<void>((resolve, reject) => {
		child.once("error", reject);
		child.once("spawn", resolve);
	});
	child.unref();
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
export async function runWindowsPowerShell(script: string, values: Record<string, string> = {}) {
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
		}, 30_000);
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
