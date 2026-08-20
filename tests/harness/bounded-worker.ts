/**
 * Bounded runner for tests that spawn a real parent process which itself
 * publishes a (possibly detached, group-leading) worker pid. Imposes an outer
 * deadline, runs idempotent kill-and-reap cleanup over the whole process group
 * on every timeout and failure path, and uses taskkill as the explicit
 * process-tree fallback on Windows, which has no negative-pid signaling.
 *
 * Shared by the spawn-boundary contract test and the built-worker descendant
 * smoke (#148) so both lanes leak nothing on any exit path.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const CLEANUP_SETTLE_MS = 5_000;

export function workerPidFrom(stderr: string): number | null {
	const match = stderr.match(/WORKER_PID=(\d+)/);
	return match?.[1] === undefined ? null : Number(match[1]);
}

function workerPidFromFile(path: string | undefined): number | null {
	if (path === undefined || !existsSync(path)) return null;
	const pid = Number(readFileSync(path, "utf8").trim());
	return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function waitForClose(child: ReturnType<typeof spawn>): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
	return new Promise((resolve) => child.once("close", () => resolve()));
}

function waitForCloseBounded(child: ReturnType<typeof spawn>): Promise<void> {
	return new Promise((resolve, reject) => {
		const deadline = setTimeout(() => reject(new Error("generated parent survived cleanup")), CLEANUP_SETTLE_MS);
		void waitForClose(child).then(() => {
			clearTimeout(deadline);
			resolve();
		});
	});
}

export function processTargetIsAlive(pid: number, group: boolean): boolean {
	try {
		process.kill(group ? -pid : pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForProcessTargetExit(pid: number, group: boolean): Promise<void> {
	const deadline = Date.now() + CLEANUP_SETTLE_MS;
	while (processTargetIsAlive(pid, group) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	if (processTargetIsAlive(pid, group)) {
		throw new Error(`detached worker ${group ? "group " : ""}${pid} survived cleanup`);
	}
}

async function killWindowsProcessTree(pid: number): Promise<void> {
	await new Promise<void>((resolve) => {
		const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
		const deadline = setTimeout(() => {
			killer.kill("SIGKILL");
			resolve();
		}, CLEANUP_SETTLE_MS);
		killer.once("error", () => {
			clearTimeout(deadline);
			resolve();
		});
		killer.once("close", () => {
			clearTimeout(deadline);
			resolve();
		});
	});
}

/**
 * Build one idempotent failure cleanup for a generated parent and the detached
 * worker it published. POSIX workers lead process groups; Windows has no
 * negative-pid signaling, so taskkill is the explicit process-tree fallback.
 */
function createFailureCleanup(child: ReturnType<typeof spawn>, workerPid: () => number | null): () => Promise<void> {
	let cleanup: Promise<void> | undefined;
	return () => {
		cleanup ??= (async () => {
			const pid = workerPid();
			if (pid !== null) {
				if (process.platform === "win32") {
					await killWindowsProcessTree(pid);
				} else {
					try {
						process.kill(-pid, "SIGKILL");
					} catch {
						try {
							process.kill(pid, "SIGKILL");
						} catch {
							// The worker already settled.
						}
					}
				}
			}
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await waitForCloseBounded(child);
			if (pid !== null) await waitForProcessTargetExit(pid, process.platform !== "win32");
		})();
		return cleanup;
	};
}

export interface BoundedParentResult {
	code: number | null;
	stderr: string;
	workerPid: number | null;
	cleanupRan: boolean;
}

export interface BoundedParentOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	outerDeadlineMs: number;
	workerPidFile?: string;
	/**
	 * Written to the parent's stdin, which then stays open: a worker parent
	 * treats stdin EOF as control-channel close and aborts its run, so the pipe
	 * lives until the process exits. Absent, stdin is not a pipe at all.
	 */
	stdin?: string;
	/**
	 * Spawn the parent detached so it leads its own process group and, when no
	 * pid file or WORKER_PID line names a deeper worker, treat the parent's own
	 * pid as the published group to reap. Used when the parent process is
	 * itself the worker under test (the direct `clio-coder worker` path).
	 */
	parentIsWorker?: boolean;
}

export function runBoundedParent(
	command: string,
	args: string[],
	options: BoundedParentOptions,
): Promise<BoundedParentResult> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: [options.stdin === undefined ? "ignore" : "pipe", "ignore", "pipe"],
			...(options.parentIsWorker === true && process.platform !== "win32" ? { detached: true } : {}),
		});
		let stderr = "";
		let settled = false;
		let cleanupRan = false;
		let publishedWorkerPid: number | null = null;
		const groupPid = (): number | null =>
			publishedWorkerPid ?? (options.parentIsWorker === true ? (child.pid ?? null) : null);
		const cleanup = createFailureCleanup(child, groupPid);
		const finish = async (code: number | null, relevantFailure: boolean): Promise<void> => {
			if (settled) return;
			settled = true;
			clearTimeout(overallDeadline);
			publishedWorkerPid ??= workerPidFromFile(options.workerPidFile);
			if (relevantFailure) {
				cleanupRan = true;
				try {
					await cleanup();
				} catch (error) {
					stderr += `\n[test] cleanup failed: ${String(error)}`;
					code = -1;
				}
			} else if (publishedWorkerPid !== null) {
				try {
					await waitForProcessTargetExit(publishedWorkerPid, process.platform !== "win32");
				} catch (error) {
					stderr += `\n[test] ${String(error)}`;
					code = -1;
				}
			}
			resolve({ code, stderr, workerPid: publishedWorkerPid, cleanupRan });
		};
		const overallDeadline = setTimeout(() => {
			stderr += "\n[test] parent exceeded the outer deadline";
			void finish(-1, true);
		}, options.outerDeadlineMs);
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
			publishedWorkerPid ??= workerPidFrom(stderr);
		});
		child.once("error", (error) => {
			stderr += `\n[test] spawn error: ${String(error)}`;
			void finish(-1, true);
		});
		child.once("close", (code) => void finish(code, code !== 0));
		if (options.stdin !== undefined) child.stdin?.write(options.stdin);
	});
}
