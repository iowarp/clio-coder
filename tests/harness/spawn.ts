import { type SpawnOptions, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
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
		stdio: ["pipe", "pipe", "pipe"],
	};
	const timeoutMs = opts.timeoutMs ?? 15_000;
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [CLI_ENTRY, ...args], spawnOpts);
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`runCli timeout after ${timeoutMs}ms: ${args.join(" ")}`));
		}, timeoutMs);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
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
