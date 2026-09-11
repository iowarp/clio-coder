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
	const entry =
		kind === "reads"
			? new URL("./worker/reads-main.ts", import.meta.url)
			: new URL("./worker/ops-main.ts", import.meta.url);
	return new Worker(entry, { workerData: settings, env });
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
