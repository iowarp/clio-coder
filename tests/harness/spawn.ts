import { type SpawnOptions, spawn } from "node:child_process";
import { closeSync, cpSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaleWatchdog } from "./load.js";
import { scratchClioEnvVars } from "./scratch-env.js";

export interface RunResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

export interface RunOptions {
	env?: NodeJS.ProcessEnv;
	/**
	 * Hand the child exactly `env` rather than layering it over this process's
	 * environment. A live driver uses this so ambient secrets never reach the
	 * binary under test.
	 */
	replaceEnv?: boolean;
	cwd?: string;
	/**
	 * Watchdog, not a performance budget: how long the child gets before it is
	 * killed and the run rejects. Widened by the shard load the caller runs
	 * under, so a figure chosen against an unloaded CLI (50-70ms to boot) does
	 * not fire as a false failure with 23 lanes competing for the same cores.
	 * `tests/contracts/live-spawn.test.ts` asserts on this machinery and runs in
	 * the runner's serial lane, where the scale factor is 1 and the number it
	 * passes is used verbatim.
	 */
	timeoutMs?: number;
	input?: string;
}

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const CLI_ENTRY = join(REPO_ROOT, "dist", "cli", "index.js");

/**
 * How long the process group gets to exit on SIGTERM before SIGKILL. The CLI
 * answers SIGTERM with a coordinated shutdown that signals its own detached
 * tool groups, so the graceful step is what reaches descendants the group
 * signal cannot.
 */
const TERM_GRACE_MS = 2_000;

/**
 * How long after SIGKILL the capture waits for the child's `close` and for
 * the group to drain before it reads whatever the child wrote and rejects
 * anyway. SIGKILL cannot be caught, so this only matters for a process stuck
 * in the kernel or a zombie nobody reaps.
 */
const KILL_GRACE_MS = 5_000;
const GROUP_POLL_MS = 50;

/** Process groups with a run in flight; SIGKILLed if this process exits first. */
const liveGroups = new Set<number>();

function signalGroup(pgid: number, signal: NodeJS.Signals): boolean {
	try {
		process.kill(-pgid, signal);
		return true;
	} catch {
		return false;
	}
}

function groupAlive(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/**
 * SIGKILL every process group with a run still in flight. Synchronous so a
 * signal handler or exit hook can call it; it does not wait for the groups
 * to drain. Returns how many groups were signalled.
 */
export function killLiveProcessGroups(): number {
	let signalled = 0;
	for (const pgid of liveGroups) if (signalGroup(pgid, "SIGKILL")) signalled += 1;
	liveGroups.clear();
	return signalled;
}

// A normal exit, an uncaught exception, or process.exit() from a signal
// handler all run this. A parent killed by SIGKILL does not, and nothing
// in-process can change that; see runNodeScript's doc comment.
process.on("exit", () => {
	killLiveProcessGroups();
});

/**
 * A child that outlived its budget. Everything it wrote before it was killed
 * is on the error, so a caller can keep the partial stream (a live driver's
 * JSONL event log) instead of learning only that the run did not finish.
 */
export class RunCliTimeoutError extends Error implements RunResult {
	readonly timeoutMs: number;
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly stdout: string;
	readonly stderr: string;

	constructor(args: ReadonlyArray<string>, timeoutMs: number, partial: RunResult) {
		super(`runCli timeout after ${timeoutMs}ms: ${args.join(" ")}`);
		this.name = "RunCliTimeoutError";
		this.timeoutMs = timeoutMs;
		this.code = partial.code;
		this.signal = partial.signal;
		this.stdout = partial.stdout;
		this.stderr = partial.stderr;
	}
}

export function runCli(args: ReadonlyArray<string>, opts: RunOptions = {}): Promise<RunResult> {
	return runNodeScript(CLI_ENTRY, args, opts);
}

/**
 * Run `node <entry> ...args` with stdout and stderr captured to files. Resolves
 * on exit; rejects with RunCliTimeoutError, carrying the partial capture, when
 * the child is still running at `timeoutMs`.
 *
 * On POSIX the child leads its own process group, so a timeout reaches every
 * descendant that inherited the group, not only the pid we spawned: SIGTERM
 * to the group, TERM_GRACE_MS for a coordinated shutdown, SIGKILL to the
 * group, then a bounded wait for the group to drain. On Windows there is no
 * group; the direct child is terminated, which is the pattern the product's
 * own executors use there, and its descendants are not reached.
 *
 * What this cannot reach: a descendant that put itself in a new session
 * (the CLI's bash tool and dispatch workers do, so they can be signalled on
 * their own) is outside the group and is reached only through the CLI's own
 * SIGTERM handler inside the grace window. And if this process is SIGKILLed,
 * no hook runs and the group outlives it; only an external supervisor can
 * close that gap.
 */
export function runNodeScript(entry: string, args: ReadonlyArray<string>, opts: RunOptions = {}): Promise<RunResult> {
	const spawnOpts: SpawnOptions = {
		cwd: opts.cwd ?? REPO_ROOT,
		env: opts.replaceEnv ? { ...(opts.env ?? {}) } : { ...process.env, ...(opts.env ?? {}) },
	};
	const timeoutMs = scaleWatchdog(opts.timeoutMs ?? 15_000);
	const ownGroup = process.platform !== "win32";
	return new Promise((resolve, reject) => {
		const captureDir = mkdtempSync(join(tmpdir(), "clio-runcli-"));
		const stdoutPath = join(captureDir, "stdout.txt");
		const stderrPath = join(captureDir, "stderr.txt");
		const stdoutFd = openSync(stdoutPath, "w");
		const stderrFd = openSync(stderrPath, "w");
		const child = spawn(process.execPath, [entry, ...args], {
			...spawnOpts,
			detached: ownGroup,
			stdio: ["pipe", stdoutFd, stderrFd],
		});
		const pgid = ownGroup && child.pid ? child.pid : null;
		if (pgid !== null) liveGroups.add(pgid);

		const signalTree = (signal: NodeJS.Signals): void => {
			if (pgid !== null && signalGroup(pgid, signal)) return;
			try {
				child.kill(signal);
			} catch {
				// Already gone; the close handler settles.
			}
		};

		let closedFds = false;
		const closeFds = (): void => {
			if (closedFds) return;
			closedFds = true;
			closeSync(stdoutFd);
			closeSync(stderrFd);
		};
		const cleanup = (): void => {
			try {
				rmSync(captureDir, { recursive: true, force: true });
			} catch {
				// best-effort
			}
		};
		const readCapture = (path: string): string => {
			try {
				return readFileSync(path, "utf8");
			} catch {
				// An external tmp reaper beat us to it; report no output rather than
				// throwing out of a close handler and never settling.
				return "";
			}
		};
		let settled = false;
		let timedOut = false;
		let killTimer: NodeJS.Timeout | undefined;
		let graceTimer: NodeJS.Timeout | undefined;
		let pollTimer: NodeJS.Timeout | undefined;
		const clearTimers = (): void => {
			clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			if (graceTimer) clearTimeout(graceTimer);
			if (pollTimer) clearTimeout(pollTimer);
		};
		const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
			if (settled) return;
			settled = true;
			clearTimers();
			if (pgid !== null) liveGroups.delete(pgid);
			closeFds();
			const stdout = readCapture(stdoutPath);
			const stderr = readCapture(stderrPath);
			cleanup();
			const result: RunResult = { code, signal, stdout, stderr };
			if (timedOut) reject(new RunCliTimeoutError(args, timeoutMs, result));
			else resolve(result);
		};
		/**
		 * After a timed-out child closes, the rest of its group may still be
		 * running (a grandchild that ignored SIGTERM while its parent did not).
		 * Kill the group and wait, bounded, for it to be empty.
		 */
		const drainGroupThenSettle = (code: number | null, signal: NodeJS.Signals | null): void => {
			if (pgid === null) {
				settle(code, signal);
				return;
			}
			signalGroup(pgid, "SIGKILL");
			const deadline = Date.now() + KILL_GRACE_MS;
			const poll = (): void => {
				if (settled) return;
				if (!groupAlive(pgid) || Date.now() >= deadline) {
					settle(code, signal);
					return;
				}
				pollTimer = setTimeout(poll, GROUP_POLL_MS);
			};
			poll();
		};
		const timer = setTimeout(() => {
			timedOut = true;
			signalTree("SIGTERM");
			killTimer = setTimeout(() => {
				signalTree("SIGKILL");
				graceTimer = setTimeout(() => settle(child.exitCode, child.signalCode), KILL_GRACE_MS);
			}, TERM_GRACE_MS);
		}, timeoutMs);
		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimers();
			if (pgid !== null) liveGroups.delete(pgid);
			closeFds();
			cleanup();
			reject(err);
		});
		child.on("close", (code, signal) => {
			if (timedOut) drainGroupThenSettle(code, signal);
			else settle(code, signal);
		});
		if (opts.input !== undefined) {
			child.stdin?.end(opts.input);
		} else {
			child.stdin?.end();
		}
	});
}

// The scratch-home helper lives in scratch-env.ts (the one Clio-state isolation
// module); re-exported here so existing `../harness/spawn.js` importers are unchanged.
export { makeScratchHome } from "./scratch-env.js";

/**
 * `doctor --fix` writes the same config/data/state/cache tree into any empty
 * scratch home; the tree does not name the home it was written into, so one
 * home's output is valid for any other. A test that spawns it only to have a
 * bootstrapped home to test something else against does not need its own
 * process and its own module-graph load, only a copy of that tree.
 *
 * The real binary still runs, once per test file: the first caller pays for
 * it and every later caller in the same process replays the result with a
 * filesystem copy. A test asserting on `doctor --fix` itself calls runCli
 * directly instead, the same as before.
 */
let doctorFixTemplate: Promise<string> | undefined;

function buildDoctorFixTemplate(): Promise<string> {
	const template = mkdtempSync(join(tmpdir(), "clio-doctor-template-"));
	const env = scratchClioEnvVars(template, { requireHomePrefix: true });
	return runCli(["doctor", "--fix"], { cwd: template, env }).then((result) => {
		if (result.code !== 0) {
			throw new Error(`doctor --fix failed while building the shared scratch template: ${result.stderr}`);
		}
		return template;
	});
}

export async function seedDoctorFix(dir: string): Promise<void> {
	doctorFixTemplate ??= buildDoctorFixTemplate();
	let template: string;
	try {
		template = await doctorFixTemplate;
	} catch (error) {
		// A rejected promise stays rejected. Cached, one timed-out `doctor --fix`
		// under load fails every later caller in the file too, instantly and with
		// the first caller's error, which reads as four broken tests instead of
		// one slow spawn. Drop the memo so the next caller gets its own attempt;
		// a genuinely broken `doctor --fix` still fails, once per caller.
		doctorFixTemplate = undefined;
		throw error;
	}
	cpSync(template, dir, { recursive: true });
}
