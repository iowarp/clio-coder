/**
 * Orchestrator-side subprocess spawner for the native worker.
 *
 * Spawns `dist/worker/entry.js` with its WorkerSpec written to stdin, consumes
 * NDJSON events line-by-line from stdout, and exposes them as an async iterator
 * so the dispatch domain can drive the orchestrator-side state machine.
 *
 * Post-W5 WorkerSpec carries a resolved EndpointDescriptor + runtime id +
 * wireModelId instead of providerId/modelId. The worker subprocess re-hydrates
 * the runtime descriptor from its own provider registry.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { resolvePackageRoot } from "../../core/package-root.js";
import type { SelfDevMode } from "../../core/self-dev.js";
import type { MiddlewareSnapshot } from "../middleware/index.js";
import type { CapabilityFlags, EndpointDescriptor, ThinkingLevel } from "../providers/index.js";

export interface WorkerSpec {
	systemPrompt: string;
	task: string;
	endpoint: EndpointDescriptor;
	runtimeId: string;
	wireModelId: string;
	modelCapabilities?: Partial<CapabilityFlags>;
	sessionId?: string;
	apiKey?: string;
	thinkingLevel?: ThinkingLevel;
	allowedTools?: ReadonlyArray<string>;
	mode?: string;
	middlewareSnapshot?: MiddlewareSnapshot;
	selfDev?: SelfDevMode;
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

/**
 * SIGTERM→SIGKILL window on worker abort. Kept tight so TUI exit with an
 * in-flight worker still returns the shell prompt in well under a second.
 * A cooperative child exits on SIGTERM within this window; a stuck one
 * gets SIGKILL. Callers that need a longer graceful window (e.g. user-
 * initiated cancel with output flush) pass `shutdownGraceMs` explicitly.
 */
const DEFAULT_SHUTDOWN_GRACE_MS = 500;

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
				// process may not exist yet
			}
		}
	});

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
				// malformed line; stderr carries diagnostics
			}
		});
	}

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
			// exited between isAlive() and kill(); ignore
		}
		const killTimer = setTimeout(() => {
			if (isAlive()) {
				try {
					child.kill("SIGKILL");
				} catch {
					// swallow; close handler still resolves the promise
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
