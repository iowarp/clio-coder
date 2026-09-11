import { spawn } from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
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
): Worker {
	return new Worker(new URL("./worker/source-entry.mjs", import.meta.url), { workerData: { ...settings, kind }, env });
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

export function stopClioCommand(
	child: Awaited<ReturnType<typeof runClioCommand>>["child"],
	birthToken: string | null,
	signal: "SIGTERM" | "SIGKILL",
) {
	if (!child.pid || child.exitCode !== null || child.signalCode !== null) return false;
	if (birthToken && !birthToken.startsWith("pid-") && process.platform !== "win32")
		return signalRecordedChild(child.pid, birthToken, signal);
	// A live Node ChildProcess handle still owns the unreaped child; this is not a persisted PID lookup.
	return child.kill(signal);
}

export function browserCommand(url: string, platform: NodeJS.Platform = process.platform) {
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
	// cmd.exe interprets shell metacharacters even with shell:false. Refuse until a native launcher is verified.
	throw new Error("Automatic browser opening is supported on Linux and macOS. Open the printed URL in your browser.");
}

/** The OS opener owns the browser. Reap only our short-lived opener, never the user's browser. */
export async function openBrowser(url: string, env: NodeJS.ProcessEnv = process.env) {
	const command = browserCommand(url);
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
	action: "show" | "enable" | "start" | "stop" | "disable" | "reload",
	unit: string,
	unitFile: string,
) {
	if (!/^clio-coder-web-[a-f0-9]{12}\.service$/.test(unit) || !isAbsolute(unitFile) || !unitFile.endsWith(`/${unit}`))
		throw new Error("Invalid Clio background service identity.");
	if (action === "reload") return ["--user", "daemon-reload"];
	if (action === "show")
		return ["--user", "show", unit, "--property=FragmentPath,ActiveState,UnitFileState,MainPID,Result"];
	if (action === "enable") return ["--user", "enable", "--now", "--", unitFile];
	if (action === "disable") return ["--user", "disable", "--now", "--", unit];
	return ["--user", action, "--", unit];
}
export async function controlService(
	action: Parameters<typeof serviceCommand>[0],
	unit: string,
	unitFile: string,
	env: NodeJS.ProcessEnv = process.env,
) {
	if (process.platform !== "linux")
		throw new Error("Background setup currently requires Linux with a systemd user session.");
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
