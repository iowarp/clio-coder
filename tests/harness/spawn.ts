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

export function runCli(args: ReadonlyArray<string>, opts: RunOptions = {}): Promise<RunResult> {
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
		const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
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
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`runCli timeout after ${timeoutMs}ms: ${args.join(" ")}`));
		}, timeoutMs);
		child.on("error", (err) => {
			clearTimeout(timer);
			closeFds();
			cleanup();
			reject(err);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			closeFds();
			const stdout = readFileSync(stdoutPath, "utf8");
			const stderr = readFileSync(stderrPath, "utf8");
			cleanup();
			resolve({ code, signal, stdout, stderr });
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
