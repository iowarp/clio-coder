import { type SpawnOptions, spawn } from "node:child_process";
import { closeSync, cpSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scratchClioEnvVars } from "./scratch-env.js";

export interface RunResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stdout: string;
	stderr: string;
}

export interface RunOptions {
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	timeoutMs?: number;
	input?: string;
}

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const CLI_ENTRY = join(REPO_ROOT, "dist", "cli", "index.js");

/**
 * How long after SIGKILL the capture waits for the child's `close` before it
 * reads whatever the child wrote and rejects anyway. SIGKILL cannot be caught,
 * so this only matters for a process stuck in the kernel.
 */
const KILL_GRACE_MS = 5_000;

/**
 * A child that outlived its budget. Everything it wrote before SIGKILL is on
 * the error, so a caller can keep the partial stream (a live driver's JSONL
 * event log) instead of learning only that the run did not finish.
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
 */
export function runNodeScript(entry: string, args: ReadonlyArray<string>, opts: RunOptions = {}): Promise<RunResult> {
	const spawnOpts: SpawnOptions = {
		cwd: opts.cwd ?? REPO_ROOT,
		env: { ...process.env, ...(opts.env ?? {}) },
	};
	const timeoutMs = opts.timeoutMs ?? 15_000;
	return new Promise((resolve, reject) => {
		const captureDir = mkdtempSync(join(tmpdir(), "clio-runcli-"));
		const stdoutPath = join(captureDir, "stdout.txt");
		const stderrPath = join(captureDir, "stderr.txt");
		const stdoutFd = openSync(stdoutPath, "w");
		const stderrFd = openSync(stderrPath, "w");
		const child = spawn(process.execPath, [entry, ...args], {
			...spawnOpts,
			stdio: ["pipe", stdoutFd, stderrFd],
		});
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
		let settled = false;
		let timedOut = false;
		let graceTimer: NodeJS.Timeout | undefined;
		const settle = (code: number | null, signal: NodeJS.Signals | null): void => {
			if (settled) return;
			settled = true;
			if (graceTimer) clearTimeout(graceTimer);
			closeFds();
			const stdout = readFileSync(stdoutPath, "utf8");
			const stderr = readFileSync(stderrPath, "utf8");
			cleanup();
			const result: RunResult = { code, signal, stdout, stderr };
			if (timedOut) reject(new RunCliTimeoutError(args, timeoutMs, result));
			else resolve(result);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
			graceTimer = setTimeout(() => settle(child.exitCode, child.signalCode), KILL_GRACE_MS);
		}, timeoutMs);
		child.on("error", (err) => {
			clearTimeout(timer);
			if (settled) return;
			settled = true;
			if (graceTimer) clearTimeout(graceTimer);
			closeFds();
			cleanup();
			reject(err);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			settle(code, signal);
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
	const template = await doctorFixTemplate;
	cpSync(template, dir, { recursive: true });
}
