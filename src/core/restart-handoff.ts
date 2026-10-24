import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { relaunchScript } from "./relaunch-script.js";
import { restartIntentPath } from "./restart-intent.js";
import { markRestartHandoff } from "./restart-status.js";
import type { getTerminationCoordinator } from "./termination.js";

/** Keep the shell's foreground job alive while the restarted child owns the terminal. */
export function armRestartHandoff(stateDir: string, termination: ReturnType<typeof getTerminationCoordinator>): void {
	termination.setExitHandoff(async () => {
		try {
			return await new Promise<number>((resolve, reject) => {
				const [script, ...args] = process.argv.slice(1);
				const argv = script === undefined ? [] : [relaunchScript(script), ...args];
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
					resolve(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : signal === "SIGHUP" ? 129 : 1));
				});
			});
		} catch (error) {
			rmSync(restartIntentPath(stateDir), { force: true });
			process.stderr.write(`Restart failed: ${error instanceof Error ? error.message : String(error)}\n`);
			return 1;
		}
	});
}
