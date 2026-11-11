import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { relaunchScript } from "./relaunch-script.js";
import { RESTART_EXEC_ENV, restartIntentPath } from "./restart-intent.js";
import { markRestartHandoff } from "./restart-status.js";
import type { getTerminationCoordinator } from "./termination.js";

/** Keep the shell's foreground job alive while the restarted child owns the terminal. */
/**
 * What to print when the restarted child exited non-zero within `windowMs`
 * without consuming the restart intent: the command that resumes the
 * session by hand. Null when the child started properly or exited cleanly.
 */
export function restartFallbackAdvice(
	stateDir: string,
	code: number,
	elapsedMs: number,
	windowMs = 15_000,
): string | null {
	if (code === 0 || elapsedMs >= windowMs) return null;
	let sessionId: unknown;
	try {
		sessionId = JSON.parse(readFileSync(restartIntentPath(stateDir), "utf8")).sessionId;
	} catch {
		return null;
	}
	rmSync(restartIntentPath(stateDir), { force: true });
	const resume = typeof sessionId === "string" ? `, then /resume ${sessionId}` : "";
	return `Restart failed: the new build exited with code ${code} before it resumed the session. Run clio-coder${resume}.\n`;
}

type Execve = (file: string, args?: readonly string[], env?: NodeJS.ProcessEnv) => never;

/**
 * Replaces this process with the restarted build, keeping its pid, process
 * group and terminal, so the parent is gone instead of guarding a nested child
 * (Q-M5). Returns false when exec is unavailable (Windows, a Node without
 * process.execve) or fails before replacing the image; the caller then falls
 * back to the spawned guardian.
 */
function execRestart(
	execve: Execve | undefined = (process as { execve?: Execve }).execve,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (typeof execve !== "function" || platform === "win32") return false;
	const [script, ...args] = process.argv.slice(1);
	const argv = script === undefined ? [] : [relaunchScript(script), ...args];
	const env = { ...process.env, [RESTART_EXEC_ENV]: String(process.pid) };
	try {
		markRestartHandoff();
		execve(process.execPath, [process.execPath, ...process.execArgv, ...argv], env);
		return true;
	} catch (error) {
		process.stderr.write(
			`Restart could not replace this process (${error instanceof Error ? error.message : String(error)}); starting it as a child.\n`,
		);
		return false;
	}
}

export function armRestartHandoff(
	stateDir: string,
	termination: ReturnType<typeof getTerminationCoordinator>,
	execve?: Execve,
): void {
	termination.setExitHandoff(async () => {
		if (execRestart(execve)) return 0;
		try {
			return await new Promise<number>((resolve, reject) => {
				const [script, ...args] = process.argv.slice(1);
				const argv = script === undefined ? [] : [relaunchScript(script), ...args];
				const started = Date.now();
				const child = spawn(process.execPath, [...process.execArgv, ...argv], {
					cwd: process.cwd(),
					env: process.env,
					stdio: "inherit",
				});
				const interrupt = (): void => {}; // Ctrl+C already reaches the foreground child.
				const terminate = (): void => {
					child.kill("SIGTERM");
				};
				const hangup = (): void => {
					child.kill("SIGHUP");
				};
				const cleanup = (): void => {
					process.off("SIGINT", interrupt);
					process.off("SIGTERM", terminate);
					process.off("SIGHUP", hangup);
				};
				process.on("SIGINT", interrupt);
				process.on("SIGTERM", terminate);
				process.on("SIGHUP", hangup);
				child.once("error", (error) => {
					cleanup();
					reject(error);
				});
				child.once("spawn", () => {
					markRestartHandoff();
				});
				child.once("exit", (code, signal) => {
					cleanup();
					const status = code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : signal === "SIGHUP" ? 129 : 1);
					const advice = existsSync(restartIntentPath(stateDir))
						? restartFallbackAdvice(stateDir, status, Date.now() - started)
						: null;
					if (advice) process.stderr.write(advice);
					resolve(status);
				});
			});
		} catch (error) {
			rmSync(restartIntentPath(stateDir), { force: true });
			process.stderr.write(`Restart failed: ${error instanceof Error ? error.message : String(error)}\n`);
			return 1;
		}
	});
}
