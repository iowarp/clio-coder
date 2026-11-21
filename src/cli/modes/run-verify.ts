import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { runBashCommand } from "../../core/bash-exec.js";
import { internalGitArgv, withoutRepositoryEnv } from "../../core/internal-git.js";
import type { RunHostVerification, RunHostVerificationCheck } from "../../domains/dispatch/types.js";
import type { SessionVerifier } from "../../domains/safety/finish-contract.js";
import type { RunJsonVerifyResult } from "./run-json-schema.js";
import { verifyNotImplicated } from "./run-json-schema-v2.js";

/** `run --verify`: the run's acceptance checks, the limit for each, and which the agent's own run was credited for. */
export interface HeadlessVerifyOptions {
	checks: ReadonlyArray<SessionVerifier>;
	timeoutMs: number;
	/** Check ids the last finish decision credited to the agent's own run after its last edit. */
	credited: () => ReadonlySet<string>;
	/**
	 * CLI-4: the checkout and the commit HEAD named when the run started, the base a failing check is replayed on;
	 * null outside a git checkout with a commit. Absent means not captured, and no check is compared.
	 */
	base?: VerifyBase | null;
}

/**
 * Where `run --verify` replays a failing check: the repository top level, and the commit HEAD named when the run
 * started. The base is that commit alone: changes uncommitted at run start are not part of it.
 */
export interface VerifyBase {
	root: string;
	commit: string;
}

/** Output a failing check keeps on its sealed record, as dispatch keeps a check's receipt tail. */
const VERIFY_OUTPUT_TAIL_BYTES = 2_048;

/** The base of a run in `cwd` (CLI-4): its repository top level and HEAD; null outside git or before a first commit. */
export function verifyBaseOf(cwd: string): VerifyBase | null {
	const git = (args: string[]) =>
		execFileSync("git", internalGitArgv(["-C", cwd, ...args]), {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 30_000,
			env: withoutRepositoryEnv(),
		}).trim();
	try {
		return { root: git(["rev-parse", "--show-toplevel"]), commit: git(["rev-parse", "--verify", "-q", "HEAD^{commit}"]) };
	} catch {
		return null;
	}
}

/** The argv a `--verify` check runs under: runBashCommand adds pipefail, so the seal and the base replay name it too. */
function acceptanceArgv(command: string): string[] {
	return ["bash", "-o", "pipefail", "-c", command];
}

function tailBytes(text: string, max: number): string {
	const buffer = Buffer.from(text, "utf8");
	if (buffer.byteLength <= max) return text;
	let start = buffer.byteLength - max;
	while (start < buffer.byteLength && ((buffer[start] ?? 0) & 0xc0) === 0x80) start += 1;
	return buffer.subarray(start).toString("utf8");
}

/**
 * CLI-4: replay each failing `--verify` check on the run's base through dispatch's own base comparison, which replays
 * only failures, in an isolated archive of the base. A check the base fails the same way is not the run's failure.
 * The comparison reads each check's full captured output from a scratch log, as dispatch reads a check's artifact,
 * so a new failure printed early in a long run is never cut off by a tail. `signal` stops the replay.
 */
async function compareFailuresWithBase(
	results: RunJsonVerifyResult[],
	outputs: ReadonlyMap<string, string>,
	base: VerifyBase | null,
	cwd: string,
	timeoutMs: number,
	signal: AbortSignal,
): Promise<void> {
	const failed = results.filter((result) => !result.passed);
	if (failed.length === 0) return;
	if (base === null) {
		for (const result of failed)
			result.base = { status: "not_compared", reason: "the run did not start in a git checkout with a commit" };
		return;
	}
	const scratch = mkdtempSync(join(tmpdir(), "clio-verify-output-"));
	try {
		const checks: RunHostVerificationCheck[] = failed
			.filter((result) => !result.timedOut)
			.map((result, index) => {
				const output = outputs.get(result.id) ?? "";
				// The code-step log shape the comparison reads: a header, a blank line, then the captured output.
				const artifactPath = join(scratch, `check-${index}.log`);
				writeFileSync(artifactPath, `${result.id}: ${result.command}\n\n${output}`, { mode: 0o600 });
				return {
					check: result.id,
					argv: acceptanceArgv(result.command),
					cwd,
					exitCode: result.exitCode !== null && result.exitCode !== 0 ? result.exitCode : 1,
					durationMs: result.durationMs,
					memo: false,
					outputTail: tailBytes(output, VERIFY_OUTPUT_TAIL_BYTES),
					artifactPath,
				};
			});
		if (checks.length > 0) {
			const { compareHostVerificationBase } = await import("../../domains/dispatch/host-verification.js");
			await compareHostVerificationBase({
				verification: { status: "rejected", checks },
				request: {
					resolvedVerification: checks.map((check) => ({ check: check.check, argv: check.argv, cwd, timeoutMs })),
					candidateWorktree: { root: base.root, path: base.root, base: base.commit },
				},
				signal,
			});
		}
		for (const result of failed) {
			const comparison = checks.find((check) => check.check === result.id)?.baseComparison;
			result.base = result.timedOut
				? { status: "not_compared", base: base.commit, reason: "the check timed out on the run" }
				: (comparison ?? { status: "not_compared", base: base.commit, reason: "base comparison unavailable" });
		}
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
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
	const outputs = new Map<string, string>();
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
			outputs.set(check.id, `${run.stdout}\n${run.stderr}`);
			results.push({
				id: check.id,
				command: check.command,
				exitCode: run.exitCode,
				passed: run.exitCode === 0 && run.error === null && !run.timedOut && !run.outputCapped,
				durationMs: Math.round(performance.now() - started),
				timedOut: run.timedOut,
				ranAfterLastEdit: credited.has(check.id),
			});
		}
		// A shutdown stopped the checks; what finished seals as it ran, without a base replay. A shutdown during the
		// replay kills it, and the finished checks seal without base (CLI-P8).
		if (!controller.signal.aborted && options.base !== undefined) {
			const comparing = compareFailuresWithBase(
				results,
				outputs,
				options.base,
				process.cwd(),
				options.timeoutMs,
				controller.signal,
			).catch(() => {});
			activeRun = comparing;
			await comparing;
			activeRun = null;
			if (controller.signal.aborted) for (const result of results) delete result.base;
		}
	} finally {
		offForceExit?.();
		process.removeListener("exit", killActive);
	}
	return results;
}

export function formatHeadlessVerifyResult(result: RunJsonVerifyResult): string {
	const verdict = result.passed
		? "passed"
		: result.timedOut
			? "timed out"
			: verifyNotImplicated(result)
				? `failed, not implicated: base ${result.base?.base ?? ""} (HEAD at run start; changes uncommitted then are not part of it) fails the same way`
				: "failed";
	const exit = result.exitCode === null ? "no exit code" : `exit ${result.exitCode}`;
	return `clio-coder run: verify ${result.id} ${verdict} (${exit}, ${(result.durationMs / 1000).toFixed(1)}s): ${result.command}`;
}

/**
 * The acceptance checks as the run's host verdict, sealed the way dispatch seals its declared checks, so the receipt
 * and `evidence inspect` judge the run by the same checks its output reported (x1-4). Null when no check ran.
 * `stopped` are the checks a shutdown cut off: they seal as not run, so the run is never `verified` without them and
 * never `rejected` for them alone.
 */
export function acceptanceHostVerification(
	results: ReadonlyArray<RunJsonVerifyResult>,
	cwd: string,
	stopped: ReadonlyArray<{ id: string; command: string }> = [],
): RunHostVerification | null {
	if (results.length === 0 && stopped.length === 0) return null;
	const argv = acceptanceArgv;
	const failed = results.some((result) => !result.passed);
	// CLI-4: every failure also present on the base reads not_implicated, as dispatch seals a task's checks.
	const notImplicated = failed && results.every((result) => result.passed || verifyNotImplicated(result));
	return {
		status: notImplicated ? "not_implicated" : failed ? "rejected" : stopped.length > 0 ? "skipped" : "verified",
		...(notImplicated
			? { reason: "failures_present_on_base" }
			: !failed && stopped.length > 0
				? { reason: "shutdown" }
				: {}),
		checks: [
			...results.map((result) => ({
				check: result.id,
				argv: argv(result.command),
				cwd,
				// A check that did not pass never seals exit 0, whether it timed out, was capped or ended by a signal.
				exitCode: result.passed ? 0 : result.exitCode !== null && result.exitCode !== 0 ? result.exitCode : 1,
				durationMs: result.durationMs,
				memo: false,
				outputTail: "",
				...(result.base !== undefined ? { baseComparison: { ...result.base } } : {}),
			})),
			...stopped.map((check) => ({
				check: check.id,
				argv: argv(check.command),
				cwd,
				exitCode: 1,
				durationMs: 0,
				memo: false,
				notRun: "shutdown" as const,
				outputTail: "",
			})),
		],
	};
}
