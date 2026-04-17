/**
 * Orchestrator-side subprocess spawner for the native worker (Phase 6 slice 3).
 *
 * Spawns `dist/worker/entry.js` with its WorkerSpec written to stdin, consumes
 * NDJSON events line-by-line from stdout, and exposes them as an async iterator
 * so the dispatch domain (P6S5) and the clio run CLI (P6S6) can drive the
 * orchestrator-side state machine. Every event bumps `heartbeatAt.current` so
 * the heartbeat watchdog stays in sync with the live event stream.
 *
 * Imports nothing from pi-mono and nothing from other domains; sits cleanly
 * behind the domain boundary.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { resolvePackageRoot } from "../../core/package-root.js";

export interface WorkerSpec {
	systemPrompt: string;
	task: string;
	providerId: string;
	modelId: string;
	sessionId?: string;
	apiKey?: string;
	runtime?: "native";
	/** Tool ids the worker Agent is permitted to call. */
	allowedTools?: ReadonlyArray<string>;
	/** Mode matrix the worker runs under (default, advise, super). */
	mode?: string;
}

export interface SpawnedWorker {
	pid: number | null;
	promise: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
	events: AsyncIterableIterator<unknown>;
	abort(): void;
	heartbeatAt: { current: number };
}

export interface SpawnOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	workerEntryPath?: string;
	shutdownGraceMs?: number;
}

const DEFAULT_SHUTDOWN_GRACE_MS = 3000;

export function spawnNativeWorker(spec: WorkerSpec, opts?: SpawnOptions): SpawnedWorker {
	const workerEntry = opts?.workerEntryPath ?? join(resolvePackageRoot(), "dist/worker/entry.js");
	const shutdownGraceMs = opts?.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;

	const child: ChildProcess = spawn(process.execPath, [workerEntry], {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: opts?.cwd,
		env: opts?.env ?? process.env,
	});
	const pid = child.pid ?? null;

	const heartbeatAt = { current: Date.now() };

	// Async iterator plumbing. Stdout lines are queued; consumers either get a
	// resolved value immediately (pending queue) or park in `waiters` until a
	// new line arrives. `end()` flushes remaining waiters with done=true.
	const pending: unknown[] = [];
	const waiters: Array<(r: IteratorResult<unknown>) => void> = [];
	let finished = false;

	function push(value: unknown): void {
		heartbeatAt.current = Date.now();
		const w = waiters.shift();
		if (w) {
			w({ value, done: false });
			return;
		}
		pending.push(value);
	}

	function end(): void {
		if (finished) return;
		finished = true;
		while (waiters.length > 0) {
			const w = waiters.shift();
			if (w) w({ value: undefined, done: true });
		}
	}

	let sawSpawnError = false;
	child.once("error", (err) => {
		sawSpawnError = true;
		push({
			type: "spawn_error",
			error: err instanceof Error ? err.message : String(err),
		});
		if (!child.killed) {
			try {
				child.kill("SIGKILL");
			} catch {
				// Some spawn errors occur before a process exists. The close handler
				// still resolves the promise and finishes the event iterator.
			}
		}
	});

	// Feed the spec to the worker once, then close its stdin so readSpecFromStdin resolves.
	if (pid !== null && child.stdin) {
		child.stdin.write(`${JSON.stringify(spec)}\n`);
		child.stdin.end();
	}

	if (child.stdout) {
		const rl = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
		rl.on("line", (line) => {
			const trimmed = line.trim();
			if (trimmed.length === 0) return;
			try {
				push(JSON.parse(trimmed));
			} catch {
				// malformed line — drop silently; stderr carries operator diagnostics.
			}
		});
	}

	// Drain stderr so the subprocess never blocks on a full pipe. Content is not
	// surfaced here; worker diagnostics land in the parent's stderr via process inheritance
	// patterns in later slices.
	child.stderr?.on("data", () => {});

	const events: AsyncIterableIterator<unknown> = {
		next(): Promise<IteratorResult<unknown>> {
			if (pending.length > 0) {
				const value = pending.shift();
				return Promise.resolve({ value, done: false });
			}
			if (finished) return Promise.resolve({ value: undefined, done: true });
			return new Promise<IteratorResult<unknown>>((resolve) => {
				waiters.push(resolve);
			});
		},
		return(): Promise<IteratorResult<unknown>> {
			end();
			return Promise.resolve({ value: undefined, done: true });
		},
		[Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
			return this;
		},
	};

	const promise = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.on("close", (code, signal) => {
			end();
			if (sawSpawnError) {
				resolve({ exitCode: null, signal: null });
				return;
			}
			resolve({ exitCode: code ?? 0, signal: signal ?? null });
		});
	});

	function isAlive(): boolean {
		return child.exitCode === null && child.signalCode === null;
	}

	const abort = (): void => {
		if (!isAlive()) return;
		try {
			child.kill("SIGTERM");
		} catch {
			// process may have exited between isAlive() and kill(); safe to ignore.
		}
		const killTimer = setTimeout(() => {
			if (isAlive()) {
				try {
					child.kill("SIGKILL");
				} catch {
					// swallow; close handler still resolves the promise.
				}
			}
		}, shutdownGraceMs);
		killTimer.unref?.();
	};

	return {
		pid,
		promise,
		events,
		abort,
		heartbeatAt,
	};
}
