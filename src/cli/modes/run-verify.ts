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

/**
 * Runs each check once the turn has settled, in order, with bash in the run's
 * cwd, as the operator's `!` command runs. A shutdown aborts the check in
 * flight, and every later check is skipped.
 */
export async function runHeadlessVerifyChecks(
	options: HeadlessVerifyOptions,
	onDrain: (hook: () => void) => void,
): Promise<RunJsonVerifyResult[]> {
	const controller = new AbortController();
	onDrain(() => controller.abort());
	const credited = options.credited();
	const results: RunJsonVerifyResult[] = [];
	for (const check of options.checks) {
		if (controller.signal.aborted) break;
		const started = performance.now();
		const run = await runBashCommand(check.command, {
			cwd: process.cwd(),
			timeoutMs: options.timeoutMs,
			signal: controller.signal,
		});
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
	return results;
}

export function formatHeadlessVerifyResult(result: RunJsonVerifyResult): string {
	const verdict = result.passed ? "passed" : result.timedOut ? "timed out" : "failed";
	const exit = result.exitCode === null ? "no exit code" : `exit ${result.exitCode}`;
	return `clio-coder run: verify ${result.id} ${verdict} (${exit}, ${(result.durationMs / 1000).toFixed(1)}s): ${result.command}`;
}
