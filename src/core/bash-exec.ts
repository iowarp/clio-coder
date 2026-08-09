import { spawn } from "node:child_process";

// Hard memory-safety ceiling for a single command's captured output. This is
// deliberately far above any display cap (see BASH_DISPLAY_MAX_BYTES in
// bash.ts, ~16 KB): output is retained and spilled to an offload file up to
// this bound, and only a runaway command that blows past it gets the child
// killed. Never truncate merely because the *display* cap was hit — the tail
// (failing assertion, compiler error, exit summary) must survive.
export const BASH_HARD_CAP_BYTES = 16 * 1024 * 1024;

// setTimeout silently clamps delays above 2^31-1 (or non-finite) down to 1ms,
// which would turn a large caller-supplied timeout into a near-instant kill.
// Clamp to a valid timer range: <=0/NaN disables the timeout, huge/Infinity caps
// at the longest schedulable delay.
const TIMEOUT_MAX_MS = 2_147_483_647;
export function clampTimeoutMs(ms: number): number {
	if (Number.isNaN(ms) || ms <= 0) return 0;
	return ms >= TIMEOUT_MAX_MS ? TIMEOUT_MAX_MS : Math.floor(ms);
}

const CLIO_CONTROL_ENV_KEYS = ["CLIO_INTERACTIVE", "CLIO_RESUME_SESSION_ID"] as const;

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

// Login-profile sourcing is the dominant per-call spawn overhead: `-l`
// re-reads /etc/profile and the user's profile chain on EVERY call (~10ms on
// a lean profile, hundreds of ms with nvm/conda in it). The profile exists to
// shape the environment, so capture that environment once per process and
// spawn every subsequent command as a plain `bash -c` with the snapshot. Each
// call still gets a fresh shell — only the env composition is cached, so
// there is no state bleed and cancellation semantics are untouched. When the
// capture fails (profile error, timeout, no PATH), every call falls back to
// the historical per-call `-lc`.
const LOGIN_ENV_CAPTURE_TIMEOUT_MS = 10_000;

let loginEnvCapture: Promise<NodeJS.ProcessEnv | null> | null = null;

/** NUL-delimited `env -0` output to an env map; null when unusable (no PATH). */
export function parseNullDelimitedEnv(raw: string): NodeJS.ProcessEnv | null {
	const env: NodeJS.ProcessEnv = {};
	for (const entry of raw.split("\0")) {
		if (entry.length === 0) continue;
		const eq = entry.indexOf("=");
		if (eq <= 0) continue;
		env[entry.slice(0, eq)] = entry.slice(eq + 1);
	}
	return typeof env.PATH === "string" && env.PATH.length > 0 ? env : null;
}

function captureLoginEnv(): Promise<NodeJS.ProcessEnv | null> {
	return new Promise((resolve) => {
		let stdout = "";
		let settled = false;
		const finish = (value: NodeJS.ProcessEnv | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(value);
		};
		const child = spawn("/bin/bash", ["-lc", "env -0"], {
			env: buildToolEnv(),
			stdio: ["ignore", "pipe", "ignore"],
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(null);
		}, LOGIN_ENV_CAPTURE_TIMEOUT_MS);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.on("error", () => finish(null));
		child.on("close", (code) => finish(code === 0 ? parseNullDelimitedEnv(stdout) : null));
	});
}

interface BashSpawnPlan {
	mode: "-c" | "-lc";
	env: NodeJS.ProcessEnv;
}

async function bashSpawnPlan(): Promise<BashSpawnPlan> {
	loginEnvCapture ??= captureLoginEnv();
	const captured = await loginEnvCapture;
	if (captured === null) return { mode: "-lc", env: buildToolEnv() };
	// Captured (login-transformed) values win; keys added to process.env after
	// the capture still flow through; the CLIO control keys are re-stripped
	// last so they never reach the child from either source.
	const env: NodeJS.ProcessEnv = { ...process.env, ...captured };
	for (const key of CLIO_CONTROL_ENV_KEYS) {
		Reflect.deleteProperty(env, key);
	}
	return { mode: "-c", env };
}

export function combineBashOutput(result: Pick<BashCommandResult, "stdout" | "stderr">): string {
	const { stdout, stderr } = result;
	return stderr.length > 0 ? `${stdout}${stdout.endsWith("\n") || stdout.length === 0 ? "" : "\n"}${stderr}` : stdout;
}

export async function runBashCommand(command: string, options: RunBashCommandOptions = {}): Promise<BashCommandResult> {
	const plan = await bashSpawnPlan();
	return new Promise((resolve) => {
		const timeout = clampTimeoutMs(options.timeoutMs ?? 300_000);
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

		const child = spawn("/bin/bash", [plan.mode, command], {
			...(options.cwd === undefined ? {} : { cwd: options.cwd }),
			env: plan.env,
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
			if (outputCapped) return;
			outputBytes += chunk.byteLength;
			if (outputBytes > BASH_HARD_CAP_BYTES) {
				// Keep the bytes seen so far (including this chunk's prefix would
				// overshoot memory, so append the remaining budget) and stop the
				// child. Truncation for display is tail-biased downstream.
				const remaining = BASH_HARD_CAP_BYTES - (outputBytes - chunk.byteLength);
				if (remaining > 0) {
					const slice = chunk.subarray(0, remaining).toString("utf8");
					if (target === "stdout") stdout += slice;
					else stderr += slice;
				}
				outputCapped = true;
				killChild();
				return;
			}
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
