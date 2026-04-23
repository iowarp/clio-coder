import { type SpawnOptions, spawn } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

export function makeScratchHome(): { dir: string; env: NodeJS.ProcessEnv; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "clio-e2e-"));
	return {
		dir,
		env: {
			CLIO_HOME: dir,
			CLIO_DATA_DIR: join(dir, "data"),
			CLIO_CONFIG_DIR: join(dir, "config"),
			CLIO_CACHE_DIR: join(dir, "cache"),
		},
		cleanup() {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// best-effort
			}
		},
	};
}
