import { spawn } from "node:child_process";

export const BASH_MAX_OUTPUT_BYTES = 1_000_000;

const CLIO_CONTROL_ENV_KEYS = ["CLIO_DEV", "CLIO_SELF_DEV", "CLIO_INTERACTIVE", "CLIO_RESUME_SESSION_ID"] as const;

export interface BashCommandResult {
	error: NodeJS.ErrnoException | null;
	stdout: string;
	stderr: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	aborted: boolean;
	timedOut: boolean;
	outputCapped: boolean;
}

export interface RunBashCommandOptions {
	cwd?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export function buildToolEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of CLIO_CONTROL_ENV_KEYS) {
		Reflect.deleteProperty(env, key);
	}
	return env;
}

export function combineBashOutput(result: Pick<BashCommandResult, "stdout" | "stderr">): string {
	const { stdout, stderr } = result;
	return stderr.length > 0 ? `${stdout}${stdout.endsWith("\n") || stdout.length === 0 ? "" : "\n"}${stderr}` : stdout;
}

export function runBashCommand(command: string, options: RunBashCommandOptions = {}): Promise<BashCommandResult> {
	return new Promise((resolve) => {
		const timeout = options.timeoutMs ?? 300_000;
		let aborted = false;
		let timedOut = false;
		let settled = false;
		let timeoutId: ReturnType<typeof setTimeout> | null = null;
		let killGraceTimer: ReturnType<typeof setTimeout> | null = null;
		let killSent = false;
		let stdout = "";
		let stderr = "";
		let outputBytes = 0;
		let outputCapped = false;

		const child = spawn("/bin/bash", ["-lc", command], {
			...(options.cwd === undefined ? {} : { cwd: options.cwd }),
			env: buildToolEnv(),
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});

		const clearKillGraceTimer = (): void => {
			if (!killGraceTimer) return;
			clearTimeout(killGraceTimer);
			killGraceTimer = null;
		};

		const sendSignal = (signalName: NodeJS.Signals): void => {
			const pid = child.pid;
			if (pid && process.platform !== "win32") {
				try {
					process.kill(-pid, signalName);
					return;
				} catch {
					// Fall through to killing the shell process directly.
				}
			}
			child.kill(signalName);
		};

		const killChild = (): void => {
			if (killSent) return;
			killSent = true;
			sendSignal("SIGTERM");
			killGraceTimer = setTimeout(() => {
				sendSignal("SIGKILL");
			}, 5000);
		};

		function onAbort(): void {
			aborted = true;
			killChild();
		}

		if (timeout > 0) {
			timeoutId = setTimeout(() => {
				timedOut = true;
				killChild();
			}, timeout);
		}

		if (options.signal?.aborted) {
			onAbort();
		} else {
			options.signal?.addEventListener("abort", onAbort, { once: true });
		}

		const appendChunk = (target: "stdout" | "stderr", chunk: Buffer): void => {
			outputBytes += chunk.byteLength;
			if (outputBytes > BASH_MAX_OUTPUT_BYTES * 2) {
				outputCapped = true;
				killChild();
				return;
			}
			if (outputCapped) return;
			if (target === "stdout") stdout += chunk.toString("utf8");
			else stderr += chunk.toString("utf8");
		};

		child.stdout?.on("data", (chunk: Buffer) => appendChunk("stdout", chunk));
		child.stderr?.on("data", (chunk: Buffer) => appendChunk("stderr", chunk));
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			if (timeoutId) clearTimeout(timeoutId);
			clearKillGraceTimer();
			options.signal?.removeEventListener("abort", onAbort);
			resolve({
				error: error as NodeJS.ErrnoException,
				stdout,
				stderr,
				exitCode: null,
				signal: null,
				aborted,
				timedOut,
				outputCapped,
			});
		});
		child.on("close", (code, signalName) => {
			if (settled) return;
			settled = true;
			if (timeoutId) clearTimeout(timeoutId);
			clearKillGraceTimer();
			options.signal?.removeEventListener("abort", onAbort);
			const error =
				code === 0 && signalName === null
					? null
					: ({
							name: "Error",
							message: signalName ? `command terminated by ${signalName}` : `command exited with code ${code ?? "?"}`,
							code: code ?? undefined,
							signal: signalName ?? undefined,
						} as NodeJS.ErrnoException);
			resolve({ error, stdout, stderr, exitCode: code, signal: signalName, aborted, timedOut, outputCapped });
		});
	});
}
