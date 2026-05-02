import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as pty from "node-pty";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const CLI_ENTRY = join(REPO_ROOT, "dist", "cli", "index.js");

export interface PtyHandle {
	send(keys: string): void;
	expect(pattern: RegExp | string, timeoutMs?: number): Promise<string>;
	output(): string;
	wait(timeoutMs?: number): Promise<{ code: number | undefined; signal: number | undefined }>;
	kill(signal?: string): void;
	resize(cols: number, rows: number): void;
}

export interface PtyOptions {
	args?: ReadonlyArray<string>;
	env?: NodeJS.ProcessEnv;
	cwd?: string;
	cols?: number;
	rows?: number;
}

export function spawnClioPty(opts: PtyOptions = {}): PtyHandle {
	const child = pty.spawn(process.execPath, [CLI_ENTRY, ...(opts.args ?? [])], {
		name: "xterm-256color",
		cols: opts.cols ?? 120,
		rows: opts.rows ?? 40,
		cwd: opts.cwd ?? REPO_ROOT,
		env: { ...process.env, CLIO_INTERACTIVE: "1", TERM: "xterm-256color", ...(opts.env ?? {}) } as NodeJS.ProcessEnv,
	});

	let buffer = "";
	const waiters: Array<{
		re: RegExp;
		resolve: (match: string) => void;
		reject: (err: Error) => void;
		timer: NodeJS.Timeout;
	}> = [];

	child.onData((chunk) => {
		buffer += chunk;
		for (let i = waiters.length - 1; i >= 0; i--) {
			const w = waiters[i];
			if (!w) continue;
			const m = w.re.exec(buffer);
			if (m) {
				clearTimeout(w.timer);
				waiters.splice(i, 1);
				w.resolve(m[0]);
			}
		}
	});

	let exitInfo: { code: number | undefined; signal: number | undefined } | null = null;
	const exitPromises: Array<(info: { code: number | undefined; signal: number | undefined }) => void> = [];
	child.onExit((e) => {
		exitInfo = { code: e.exitCode, signal: e.signal };
		for (const resolve of exitPromises) resolve(exitInfo);
		exitPromises.length = 0;
		// Drain any pending waiters so they reject rather than hang
		for (const w of waiters) {
			clearTimeout(w.timer);
			w.reject(new Error(`pty exited before matching ${w.re.source}; output=${JSON.stringify(buffer.slice(-200))}`));
		}
		waiters.length = 0;
	});

	return {
		send(keys) {
			child.write(keys);
		},
		expect(pattern, timeoutMs = 10_000) {
			const re = typeof pattern === "string" ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) : pattern;
			const existing = re.exec(buffer);
			if (existing) return Promise.resolve(existing[0]);
			return new Promise<string>((resolve, reject) => {
				const timer = setTimeout(() => {
					const idx = waiters.findIndex((w) => w.timer === timer);
					if (idx >= 0) waiters.splice(idx, 1);
					reject(
						new Error(
							`pty.expect timeout after ${timeoutMs}ms waiting for ${re.source}; last output=${JSON.stringify(buffer.slice(-400))}`,
						),
					);
				}, timeoutMs);
				waiters.push({ re, resolve, reject, timer });
			});
		},
		output() {
			return buffer;
		},
		wait(timeoutMs = 10_000) {
			if (exitInfo) return Promise.resolve(exitInfo);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					reject(new Error(`pty.wait timeout after ${timeoutMs}ms`));
				}, timeoutMs);
				exitPromises.push((info) => {
					clearTimeout(timer);
					resolve(info);
				});
			});
		},
		kill(signal = "SIGTERM") {
			try {
				child.kill(signal);
			} catch {
				// already gone
			}
		},
		resize(cols, rows) {
			child.resize(cols, rows);
		},
	};
}

export function makeScratchHome(): { dir: string; env: NodeJS.ProcessEnv; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "clio-pty-"));
	return {
		dir,
		env: {
			CLIO_HOME: dir,
			CLIO_DATA_DIR: join(dir, "data"),
			CLIO_CONFIG_DIR: join(dir, "config"),
			CLIO_CACHE_DIR: join(dir, "cache"),
			CLIO_REQUIRE_HOME_PREFIX: "1",
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
