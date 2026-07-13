/**
 * Orchestrator-side subprocess spawner for the native worker.
 *
 * Spawns a worker process with its WorkerSpec written to stdin, consumes
 * NDJSON events line-by-line from stdout, and exposes them as an async
 * iterator so the dispatch domain can drive the orchestrator-side state
 * machine.
 *
 * The channel machinery (spec write, NDJSON demux, stderr tail, heartbeat
 * bump, abort escalation) is transport-neutral: `spawnWorkerProcess` takes an
 * argv and works for both the local `node dist/worker/entry.js` fork and an
 * `ssh <host> -- clio worker` remote launch (see transport.ts). The wire
 * protocol is identical on every transport.
 *
 * Post-W5 WorkerSpec carries a resolved TargetDescriptor + runtime id +
 * wireModelId instead of providerId/modelId. The worker subprocess re-hydrates
 * the runtime descriptor from its own provider registry.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { resolvePackageRoot } from "../../core/package-root.js";
import type { WorkerSpec } from "../../worker/spec-contract.js";

export type { WorkerSpec } from "../../worker/spec-contract.js";

export interface SpawnedWorkerResult {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stderrTail?: string;
	malformedStdoutLines?: number;
}

export interface SpawnedWorker {
	pid: number | null;
	promise: Promise<SpawnedWorkerResult>;
	events: AsyncIterableIterator<unknown>;
	abort(): void;
	heartbeatAt: { current: number };
	/**
	 * Write one JSON line to the worker's open stdin (the same line protocol
	 * that carried the spec). Returns false when the worker has exited or its
	 * stdin is no longer writable; callers treat that as "run not steerable".
	 * Optional so test fakes and non-stdin run handles stay valid.
	 */
	send?(value: unknown): boolean;
}

export interface SpawnOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	workerEntryPath?: string;
	shutdownGraceMs?: number;
}

/** First stdout event a worker emits under CLIO_WORKER_ANNOUNCE=1. */
export interface WorkerAnnounce {
	pid: number | null;
	host: string | null;
	specVersion: WorkerSpec["specVersion"];
}

export interface WorkerProcessOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	shutdownGraceMs?: number;
	/**
	 * Capture-and-consume `worker_announce` events. Remote transports use the
	 * announced remote pid for a kill fallback when the channel-close signal is
	 * not honored. When set, announce events are delivered here and never
	 * yielded on the event stream. Both local and remote native transports set
	 * this callback so ordinary events are accepted only after the worker entry
	 * parsed the spec and announced the dispatched wire version.
	 */
	onAnnounce?: (announce: WorkerAnnounce) => void;
	/**
	 * Invoked when abort escalates from SIGTERM to SIGKILL after the grace
	 * window. Remote transports hook their remote kill fallback here.
	 */
	onForcedKill?: () => void;
}

/**
 * SIGTERM→SIGKILL window on worker abort. Kept tight so TUI exit with an
 * in-flight worker still returns the shell prompt in well under a second.
 * A cooperative child exits on SIGTERM within this window; a stuck one
 * gets SIGKILL. Callers that need a longer graceful window (e.g. user-
 * initiated cancel with output flush) pass `shutdownGraceMs` explicitly.
 */
const DEFAULT_SHUTDOWN_GRACE_MS = 500;
const STDERR_TAIL_BYTES = 4096;

/**
 * Force the native worker's wire-initialization announcement on top of a
 * caller-provided environment. The final property is deliberate: callers may
 * add environment values, but cannot disable the protocol boundary.
 */
export function announceEnabledWorkerEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return { ...env, CLIO_WORKER_ANNOUNCE: "1" };
}

function isWorkerAnnounce(
	value: unknown,
): value is { type: "worker_announce"; pid?: unknown; host?: unknown; specVersion?: unknown } {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		(value as { type?: unknown }).type === "worker_announce"
	);
}

export function spawnWorkerProcess(
	command: string,
	args: ReadonlyArray<string>,
	spec: WorkerSpec,
	opts?: WorkerProcessOptions,
): SpawnedWorker {
	const shutdownGraceMs = opts?.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;

	const child: ChildProcess = spawn(command, [...args], {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: opts?.cwd,
		env: opts?.env ?? process.env,
	});
	const pid = child.pid ?? null;

	const heartbeatAt = { current: Date.now() };

	const pending: unknown[] = [];
	const waiters: Array<(r: IteratorResult<unknown>) => void> = [];
	let finished = false;
	let malformedStdoutLines = 0;
	let stderrTail = Buffer.alloc(0);

	function appendStderr(chunk: Buffer | string): void {
		const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		if (next.length === 0) return;
		const combined = Buffer.concat([stderrTail, next]);
		stderrTail = combined.length > STDERR_TAIL_BYTES ? combined.subarray(combined.length - STDERR_TAIL_BYTES) : combined;
	}

	function diagnostics(): Pick<SpawnedWorkerResult, "stderrTail" | "malformedStdoutLines"> {
		const stderrText = stderrTail.toString("utf8").trim();
		return {
			...(stderrText.length > 0 ? { stderrTail: stderrText } : {}),
			...(malformedStdoutLines > 0 ? { malformedStdoutLines } : {}),
		};
	}

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
	let announceAccepted = false;
	let announceFailed = false;

	function failAnnounceHandshake(message: string): void {
		if (announceFailed) return;
		announceFailed = true;
		appendStderr(`[worker] ${message}\n`);
		// A peer that did not prove the dispatched wire contract must not execute.
		// Terminate authoritatively instead of offering a catchable grace signal.
		if (!child.killed) {
			try {
				child.kill("SIGKILL");
			} catch {
				// The close handler still converts a clean pre-announce exit to failure.
			}
		}
	}
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
	}

	if (child.stdout) {
		const rl = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
		rl.on("line", (line) => {
			const trimmed = line.trim();
			if (trimmed.length === 0) return;
			try {
				const value = JSON.parse(trimmed) as unknown;
				if (opts?.onAnnounce) {
					if (announceFailed) return;
					if (!announceAccepted && !isWorkerAnnounce(value)) {
						failAnnounceHandshake(
							`Missing worker_announce handshake: first protocol event was ${
								typeof value === "object" && value !== null && "type" in value
									? String((value as { type?: unknown }).type)
									: typeof value
							}; expected specVersion ${spec.specVersion}`,
						);
						return;
					}
					if (isWorkerAnnounce(value)) {
						heartbeatAt.current = Date.now();
						if (value.specVersion !== spec.specVersion) {
							failAnnounceHandshake(
								`WorkerSpec version mismatch: dispatched ${spec.specVersion}, worker announced ${String(value.specVersion)}`,
							);
							return;
						}
						announceAccepted = true;
						opts.onAnnounce({
							pid: typeof value.pid === "number" && Number.isFinite(value.pid) ? value.pid : null,
							host: typeof value.host === "string" && value.host.length > 0 ? value.host : null,
							specVersion: spec.specVersion,
						});
						return;
					}
				}
				push(value);
			} catch {
				malformedStdoutLines += 1;
				if (opts?.onAnnounce && !announceAccepted && !announceFailed) {
					failAnnounceHandshake(
						`Missing worker_announce handshake: first protocol event was malformed JSON; expected specVersion ${spec.specVersion}`,
					);
				}
			}
		});
	}

	child.stderr?.on("data", (chunk: Buffer | string) => appendStderr(chunk));

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

	const promise = new Promise<SpawnedWorkerResult>((resolve) => {
		child.on("close", (code, signal) => {
			try {
				child.stdin?.end();
			} catch {
				// stdin may already be closed.
			}
			end();
			if (sawSpawnError) {
				resolve({ exitCode: null, signal: null, ...diagnostics() });
				return;
			}
			if (opts?.onAnnounce && !announceAccepted && !announceFailed) {
				announceFailed = true;
				appendStderr(
					`[worker] Missing worker_announce handshake: peer exited before announcing specVersion ${spec.specVersion}\n`,
				);
			}
			if (announceFailed) {
				resolve({ exitCode: code !== null && code !== 0 ? code : 1, signal: signal ?? null, ...diagnostics() });
				return;
			}
			resolve({ exitCode: code ?? 0, signal: signal ?? null, ...diagnostics() });
		});
	});

	function isAlive(): boolean {
		return child.exitCode === null && child.signalCode === null;
	}

	const send = (value: unknown): boolean => {
		if (!isAlive()) return false;
		const stdin = child.stdin;
		if (!stdin || stdin.destroyed || !stdin.writable) return false;
		try {
			stdin.write(`${JSON.stringify(value)}\n`);
			return true;
		} catch {
			return false;
		}
	};

	const abort = (): void => {
		if (!isAlive()) return;
		try {
			child.stdin?.end();
		} catch {
			// process may already be closing
		}
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
				try {
					opts?.onForcedKill?.();
				} catch {
					// fallback is best-effort; the local channel is already dead
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
		send,
	};
}

export function spawnNativeWorker(spec: WorkerSpec, opts?: SpawnOptions): SpawnedWorker {
	const workerEntry = opts?.workerEntryPath ?? join(resolvePackageRoot(), "dist/worker/entry.js");
	return spawnWorkerProcess(process.execPath, [workerEntry], spec, {
		...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
		env: announceEnabledWorkerEnvironment(opts?.env),
		...(opts?.shutdownGraceMs !== undefined ? { shutdownGraceMs: opts.shutdownGraceMs } : {}),
		// Validation and consumption happen inside spawnWorkerProcess. The local
		// child pid is already known, so no post-validation metadata is needed.
		onAnnounce: () => {},
	});
}
