import { performance } from "node:perf_hooks";
import { runBashCommand } from "../../core/bash-exec.js";
import type { SessionVerifier } from "../../domains/safety/finish-contract.js";
import type { RunJsonVerifyResult } from "./run-json-schema.js";

/** `run --verify`: the run's acceptance checks, the limit for each, and which the agent's own run was credited for. */
export interface HeadlessVerifyOptions {
	checks: ReadonlyArray<SessionVerifier>;
	timeoutMs: number;
	/** Check ids the last finish decision credited to the agent's own run after its last edit. */
	credited: () => ReadonlySet<string>;
}

/** Where `run --verify` hooks the coordinated shutdown; `HeadlessShutdownHooks` satisfies it. */
export interface HeadlessVerifyShutdownHooks {
	onDrain(hook: () => void | Promise<void>, options?: { timeoutMs: number }): void;
	onForceExit?(hook: () => void): () => void;
}

/**
 * The drain budget covers the bash runner's cancellation: TERM to the check's
 * process group, KILL 5 s later if any of it survives, then a bounded pipe
 * drain. A shorter budget lets shutdown exit with the group still alive.
 */
const VERIFY_SHUTDOWN_MS = 7500;

function killGroup(pid: number): void {
	try {
		process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
	} catch {
		// Already gone.
	}
}

/**
 * Runs each check once the turn has settled, in order, with bash in the run's
 * cwd, as the operator's `!` command runs. A shutdown aborts the check in
 * flight and waits for its process group to be gone, and every later check is
 * skipped. A forced exit, or any exit while a check still runs, kills the
 * group at once.
 */
export async function runHeadlessVerifyChecks(
	options: HeadlessVerifyOptions,
	shutdown: HeadlessVerifyShutdownHooks,
): Promise<RunJsonVerifyResult[]> {
	const controller = new AbortController();
	let activePid: number | null = null;
	let activeRun: Promise<unknown> | null = null;
	const killActive = (): void => {
		if (activePid !== null) killGroup(activePid);
	};
	shutdown.onDrain(
		async () => {
			controller.abort();
			await activeRun;
		},
		{ timeoutMs: VERIFY_SHUTDOWN_MS },
	);
	const offForceExit = shutdown.onForceExit?.(killActive);
	process.once("exit", killActive);
	const credited = options.credited();
	const results: RunJsonVerifyResult[] = [];
	try {
		for (const check of options.checks) {
			if (controller.signal.aborted) break;
			const started = performance.now();
			const pending = runBashCommand(check.command, {
				cwd: process.cwd(),
				timeoutMs: options.timeoutMs,
				signal: controller.signal,
				onSpawn: (pid) => {
					activePid = pid;
				},
			});
			activeRun = pending;
			const run = await pending;
			activePid = null;
			activeRun = null;
			if (run.aborted) break;
			results.push({
				id: check.id,
				command: check.command,
				exitCode: run.exitCode,
				passed: run.exitCode === 0 && run.error === null && !run.timedOut,
				durationMs: Math.round(performance.now() - started),
				timedOut: run.timedOut,
				ranAfterLastEdit: credited.has(check.id),
			});
		}
	} finally {
		offForceExit?.();
		process.removeListener("exit", killActive);
	}
	return results;
}

export function formatHeadlessVerifyResult(result: RunJsonVerifyResult): string {
	const verdict = result.passed ? "passed" : result.timedOut ? "timed out" : "failed";
	const exit = result.exitCode === null ? "no exit code" : `exit ${result.exitCode}`;
	return `clio-coder run: verify ${result.id} ${verdict} (${exit}, ${(result.durationMs / 1000).toFixed(1)}s): ${result.command}`;
}
