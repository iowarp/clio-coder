/**
 * Orchestrator-side subprocess spawner for the native worker.
 *
 * Spawns a worker process with its WorkerSpec written to stdin, consumes the
 * two protocol lanes, and exposes bulk events as an async iterator so the
 * dispatch domain can drive the orchestrator-side state machine.
 *
 * Two lanes, never one queue:
 *
 *   - stdout is the bulk lane. Frames are length-checked before parsing and
 *     land in a bounded queue that drops display-only frames under pressure
 *     and never drops a receipt-bearing frame.
 *   - stderr carries the structured control lane behind a marker prefix
 *     (announce, heartbeat, and cancellation acknowledgements) plus
 *     free-form diagnostics, which are tailed. A bulk flood cannot delay a
 *     heartbeat, because the lanes are separate pipes.
 *
 * The channel machinery is transport-neutral: `spawnWorkerProcess` takes an
 * argv and works for both the local fork and an `ssh <host> -- clio-coder worker`
 * remote launch (see transport.ts). The wire protocol is identical on every
 * transport.
 *
 * A worker leads its own process group so abort escalation reaches the
 * descendants a runtime spawned, not only the immediate child.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { withClioAgentEnvironment } from "../../core/agent-environment.js";
import { enableClioCompileCache, workerCompileCacheEnvironment } from "../../core/compile-cache.js";
import { resolvePackageRoot } from "../../core/package-root.js";
import type { WorkerSpec } from "../../worker/spec-contract.js";
import {
	type AgentLedgerBody,
	type ApprovedWorkerIdentity,
	approvedIdentityForSpec,
	createBoundedEventQueue,
	isControlLine,
	parseBulkFrame,
	parseControlFrame,
	verifyWorkerAttestation,
	WORKER_BULK_FRAME_MAX_BYTES,
	WORKER_STDIN_FRAME_MAX_BYTES,
	WORKER_STDIN_QUEUE_MAX_BYTES,
	type WorkerAttestation,
	WorkerChannelFailure,
} from "./worker-protocol.js";

export type { WorkerSpec } from "../../worker/spec-contract.js";
export { WorkerChannelFailure } from "./worker-protocol.js";

export interface SpawnedWorkerResult {
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stderrTail?: string;
	malformedStdoutLines?: number;
	/** Display-only frames the bounded queue dropped under backpressure. */
	droppedDisplayFrames?: number;
	/**
	 * The control operation whose write could not reach the worker. Present only
	 * when the channel failed, so failure classification attributes it to the
	 * node rather than to the target or the model.
	 */
	channelFailure?: WorkerChannelFailure["operation"];
}

export interface SpawnedWorker {
	pid: number | null;
	/** Exact spawned argv encoded as JSON; trace consumers must not shell-parse it. */
	processCommand?: string;
	promise: Promise<SpawnedWorkerResult>;
	events: AsyncIterableIterator<unknown>;
	abort(): void;
	heartbeatAt: { current: number };
	/**
	 * Write one JSON line to the worker's open stdin (the same line protocol
	 * that carried the spec). Returns false when the worker has exited, its
	 * stdin is no longer writable, or the bounded stdin queue is full; callers
	 * treat that as "run not steerable" and read `lastChannelFailure` for the
	 * typed reason. Optional so test fakes and non-stdin run handles stay valid.
	 */
	send?(value: unknown): boolean;
	/** The most recent typed control-channel failure, if any. */
	lastChannelFailure?(): WorkerChannelFailure | null;
	/** Route and node identity the worker attested, once it has announced. */
	attestation?(): WorkerAttestation | null;
}

/**
 * What a caller may hand `spawnNativeWorker`. It extends the process options
 * rather than restating a subset of them, because a subset is how the callbacks
 * went missing: this interface once listed only cwd, env, workerEntryPath, and
 * shutdownGraceMs, `spawnNativeWorker` forwarded exactly those three, and every
 * local worker's `onLedgerPost` was dropped on the floor. The call site spreads
 * its option literal, which suppresses excess-property checking, so nothing
 * complained.
 */
export interface SpawnOptions extends WorkerProcessOptions {
	workerEntryPath?: string;
}

export interface WorkerProcessOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	shutdownGraceMs?: number;
	/**
	 * Consume the worker's attestation. Remote transports use the announced
	 * remote pid and process-group id for their kill fallback. Attestation is
	 * unconditional on the wire; this callback only observes it.
	 */
	onAnnounce?: (attestation: WorkerAttestation) => void;
	/**
	 * Invoked when abort escalates from SIGTERM to SIGKILL after the grace
	 * window. Remote transports hook their remote kill fallback here.
	 */
	onForcedKill?: () => void;
	/**
	 * Control-lane frames other than the announce. Heartbeats and cancellation
	 * acknowledgements remain observable even when the bulk lane is saturated.
	 */
	onControl?: (frame: { kind: "heartbeat" | "cancel_ack" }) => void;
	/**
	 * One agent-ledger post from the worker. The worker supplies the body and
	 * nothing else; the orchestrator stamps every attribution field from its own
	 * admission record, so this callback only ever receives a validated body.
	 */
	onLedgerPost?: (body: AgentLedgerBody) => void;
	/**
	 * Identity the plan approved. Defaults to the identity of the spec actually
	 * written to stdin, which is what every production caller wants; a caller
	 * with a separately sealed plan identity passes it explicitly.
	 */
	approvedIdentity?: ApprovedWorkerIdentity;
	/** How long bulk output may precede the announce before the peer is refused. */
	attestationGraceMs?: number;
	/**
	 * Clock behind the heartbeat stamp, defaulting to `Date.now`. The stamp stays
	 * a wall-clock instant in production because the ledger, the receipt, and the
	 * evidence record all serialize it as ISO-8601 for an operator to read. That
	 * leaves a test with no honest way to assert the stamp advanced: comparing
	 * two wall-clock reads taken either side of an interval orders them backward
	 * on any host that resyncs its clock in between. A test injects the steppable
	 * clock from tests/harness/clock.ts here and asserts on that instead.
	 */
	now?: () => number;
}

/**
 * SIGTERM→SIGKILL window on worker abort. Kept tight so TUI exit with an
 * in-flight worker still returns the shell prompt in well under a second.
 * A cooperative child exits on SIGTERM within this window; a stuck one
 * gets SIGKILL. Callers that need a longer graceful window (e.g. user-
 * initiated cancel with output flush) pass `shutdownGraceMs` explicitly.
 */
const DEFAULT_SHUTDOWN_GRACE_MS = 500;
/**
 * How long bulk output may precede the announce. The two lanes are separate
 * pipes with no ordering guarantee, so a frame arriving first proves nothing;
 * this bounds how long that benefit of the doubt lasts.
 */
const DEFAULT_ATTESTATION_GRACE_MS = 2000;
const STDERR_TAIL_BYTES = 4096;

/**
 * Signal a whole process group when the platform has one, so a runtime that
 * spawned its own children cannot strand them. Falls back to the single child
 * where no group exists or the group has already gone.
 */
function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
	const pid = child.pid;
	if (pid !== undefined && pid !== null) {
		try {
			process.kill(-pid, signal);
			return;
		} catch {
			// No group (or already reaped); fall through to the direct signal.
		}
	}
	try {
		child.kill(signal);
	} catch {
		// Exited between the liveness check and the signal.
	}
}

export function spawnWorkerProcess(
	command: string,
	args: ReadonlyArray<string>,
	spec: WorkerSpec,
	opts?: WorkerProcessOptions,
): SpawnedWorker {
	const shutdownGraceMs = opts?.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
	const attestationGraceMs = opts?.attestationGraceMs ?? DEFAULT_ATTESTATION_GRACE_MS;
	const now = opts?.now ?? Date.now;
	const approved = opts?.approvedIdentity ?? approvedIdentityForSpec(spec);

	const child: ChildProcess = spawn(command, [...args], {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: opts?.cwd,
		env: withClioAgentEnvironment(opts?.env ?? process.env),
		// The worker leads its own process group so abort escalation covers the
		// descendants a runtime spawned, not only the immediate child.
		detached: true,
	});
	const pid = child.pid ?? null;

	const heartbeatAt = { current: now() };

	const queue = createBoundedEventQueue();
	const waiters: Array<(r: IteratorResult<unknown>) => void> = [];
	let finished = false;
	let malformedStdoutLines = 0;
	let stderrTail = Buffer.alloc(0);
	let channelFailure: WorkerChannelFailure | null = null;
	let attestation: WorkerAttestation | null = null;

	function appendStderr(chunk: Buffer | string): void {
		const next = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		if (next.length === 0) return;
		const combined = Buffer.concat([stderrTail, next]);
		stderrTail = combined.length > STDERR_TAIL_BYTES ? combined.subarray(combined.length - STDERR_TAIL_BYTES) : combined;
	}

	function diagnostics(): Omit<SpawnedWorkerResult, "exitCode" | "signal"> {
		const stderrText = stderrTail.toString("utf8").trim();
		const dropped = queue.stats().droppedDisplayFrames + preAnnounce.stats().droppedDisplayFrames;
		return {
			...(stderrText.length > 0 ? { stderrTail: stderrText } : {}),
			...(malformedStdoutLines > 0 ? { malformedStdoutLines } : {}),
			...(dropped > 0 ? { droppedDisplayFrames: dropped } : {}),
			...(channelFailure !== null ? { channelFailure: channelFailure.operation } : {}),
		};
	}

	function push(value: unknown): void {
		heartbeatAt.current = now();
		const w = waiters.shift();
		if (w) {
			w({ value, done: false });
			return;
		}
		queue.push(value);
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

	function failAttestation(message: string): void {
		if (announceFailed) return;
		announceFailed = true;
		appendStderr(`[worker] ${message}\n`);
		// A peer that did not prove the approved route identity must not execute.
		// Terminate the whole group authoritatively rather than offering a
		// catchable grace signal.
		signalProcessGroup(child, "SIGKILL");
	}

	child.once("error", (err) => {
		sawSpawnError = true;
		push({
			type: "spawn_error",
			error: err instanceof Error ? err.message : String(err),
		});
		signalProcessGroup(child, "SIGKILL");
	});

	if (pid !== null && child.stdin) {
		// A worker that closes or never drains its stdin makes every subsequent
		// write raise EPIPE asynchronously. Without a listener that is an unhandled
		// stream error; with one it is what it actually is, a channel failure.
		child.stdin.on("error", (err) => {
			channelFailure = new WorkerChannelFailure("spec", err instanceof Error ? err.message : String(err));
			appendStderr(`[worker] ${channelFailure.message}\n`);
		});
		child.stdin.write(`${JSON.stringify(spec)}\n`);
	}

	/**
	 * Bounded line reader. readline would buffer an unterminated line without
	 * limit, so lines are split here and anything past the lane ceiling is
	 * discarded before it can be parsed or retained.
	 */
	function createLineReader(
		maxBytes: number,
		onLine: (line: string) => void,
		onOversize: () => void,
	): (chunk: Buffer) => void {
		let buffer = "";
		let discarding = false;
		return (chunk: Buffer): void => {
			buffer += chunk.toString("utf8");
			let idx = buffer.indexOf("\n");
			while (idx >= 0) {
				const line = buffer.slice(0, idx);
				buffer = buffer.slice(idx + 1);
				if (discarding) {
					discarding = false;
					onOversize();
				} else if (Buffer.byteLength(line, "utf8") > maxBytes) {
					onOversize();
				} else {
					onLine(line);
				}
				idx = buffer.indexOf("\n");
			}
			if (Buffer.byteLength(buffer, "utf8") > maxBytes) {
				buffer = "";
				discarding = true;
			}
		};
	}

	/**
	 * Bulk frames that arrived before the announce verdict. stdout and stderr are
	 * separate pipes with no ordering guarantee between them, so an early bulk
	 * frame is not evidence of a missing attestation. Frames are held (under the
	 * same bounded queue policy) and released only once the attestation verifies;
	 * a peer that fails or never attests has its held frames discarded, so no
	 * unattested output ever reaches a consumer.
	 */
	const preAnnounce = createBoundedEventQueue();
	let attestationGraceTimer: ReturnType<typeof setTimeout> | null = null;

	function releaseHeldFrames(): void {
		if (attestationGraceTimer !== null) {
			clearTimeout(attestationGraceTimer);
			attestationGraceTimer = null;
		}
		while (preAnnounce.size > 0) push(preAnnounce.shift());
	}

	/**
	 * Bulk output means the peer is alive and past its announce point, so the
	 * announce is already in flight on the other pipe. This bounds how long the
	 * orchestrator waits for it before treating the peer as unattested.
	 */
	function startAttestationGrace(): void {
		if (attestationGraceTimer !== null || announceAccepted || announceFailed) return;
		attestationGraceTimer = setTimeout(() => {
			attestationGraceTimer = null;
			if (announceAccepted || announceFailed) return;
			failAttestation("Missing worker attestation: the peer produced output without announcing its route identity");
		}, attestationGraceMs);
		attestationGraceTimer.unref?.();
	}

	function handleBulkLine(line: string): void {
		const trimmed = line.trim();
		if (trimmed.length === 0) return;
		const frame = parseBulkFrame(trimmed);
		if (!frame.ok) {
			malformedStdoutLines += 1;
			return;
		}
		if (announceFailed) return;
		if (!announceAccepted) {
			preAnnounce.push(frame.value);
			startAttestationGrace();
			return;
		}
		push(frame.value);
	}

	function handleControlLine(line: string): void {
		const frame = parseControlFrame(line);
		if (!frame.ok) {
			appendStderr(`[worker] rejected control frame: ${frame.reason}\n`);
			if (!announceAccepted) failAttestation(`Invalid worker attestation: ${frame.reason}`);
			return;
		}
		heartbeatAt.current = now();
		if (frame.value.kind === "announce") {
			if (announceAccepted || announceFailed) return;
			const verdict = verifyWorkerAttestation(frame.value.attestation, approved);
			if (!verdict.ok) {
				failAttestation(`Worker attestation rejected: ${verdict.reason}`);
				return;
			}
			announceAccepted = true;
			attestation = frame.value.attestation;
			opts?.onAnnounce?.(frame.value.attestation);
			releaseHeldFrames();
			return;
		}
		if (frame.value.kind === "ledger_post") {
			if (!announceAccepted) {
				// Attribution requires an admitted identity, so a post that arrives
				// before the announce is accepted is dropped rather than queued.
				appendStderr("[worker] dropped a ledger post that arrived before attestation was accepted\n");
				return;
			}
			opts?.onLedgerPost?.(frame.value.body);
			return;
		}
		opts?.onControl?.({ kind: frame.value.kind });
	}

	if (child.stdout) {
		child.stdout.on(
			"data",
			createLineReader(WORKER_BULK_FRAME_MAX_BYTES, handleBulkLine, () => {
				malformedStdoutLines += 1;
				appendStderr(`[worker] dropped a bulk frame over the ${WORKER_BULK_FRAME_MAX_BYTES} byte lane limit\n`);
			}),
		);
	}

	if (child.stderr) {
		child.stderr.on(
			"data",
			createLineReader(
				WORKER_BULK_FRAME_MAX_BYTES,
				(line) => {
					if (isControlLine(line)) {
						handleControlLine(line);
						return;
					}
					appendStderr(`${line}\n`);
				},
				() => appendStderr("[worker] dropped an oversized stderr line\n"),
			),
		);
	}

	const events: AsyncIterableIterator<unknown> = {
		next(): Promise<IteratorResult<unknown>> {
			if (queue.size > 0) {
				return Promise.resolve({ value: queue.shift(), done: false });
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
			if (!announceAccepted && !announceFailed) {
				announceFailed = true;
				appendStderr("[worker] Missing worker attestation: peer exited before announcing its route identity\n");
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

	/**
	 * Bounded stdin queue. `stream.write` returning false means the kernel
	 * buffer is full, and Node keeps buffering in user space without limit, so
	 * the pending bytes are counted here and a write past the ceiling is a
	 * typed channel failure rather than unbounded growth.
	 */
	let queuedStdinBytes = 0;

	function failChannel(operation: "steer" | "permission_decision" | "ledger_delta", detail: string): false {
		channelFailure = new WorkerChannelFailure(operation, detail);
		appendStderr(`[worker] ${channelFailure.message}\n`);
		return false;
	}

	const send = (value: unknown): boolean => {
		const frameType = typeof value === "object" && value !== null ? (value as { type?: unknown }).type : undefined;
		const operation =
			frameType === "permission_decision"
				? "permission_decision"
				: frameType === "ledger_delta"
					? "ledger_delta"
					: "steer";
		if (!isAlive()) return failChannel(operation, "worker has exited");
		const stdin = child.stdin;
		if (!stdin || stdin.destroyed || !stdin.writable) return failChannel(operation, "worker stdin is not writable");
		const line = `${JSON.stringify(value)}\n`;
		const bytes = Buffer.byteLength(line, "utf8");
		if (bytes > WORKER_STDIN_FRAME_MAX_BYTES) {
			return failChannel(operation, `frame of ${bytes} bytes exceeds the ${WORKER_STDIN_FRAME_MAX_BYTES} byte limit`);
		}
		if (queuedStdinBytes + bytes > WORKER_STDIN_QUEUE_MAX_BYTES) {
			return failChannel(
				operation,
				`stdin queue is full (${queuedStdinBytes} of ${WORKER_STDIN_QUEUE_MAX_BYTES} bytes pending)`,
			);
		}
		try {
			queuedStdinBytes += bytes;
			stdin.write(line, (error) => {
				queuedStdinBytes -= bytes;
				if (error) failChannel(operation, error.message);
			});
			return true;
		} catch (error) {
			queuedStdinBytes -= bytes;
			return failChannel(operation, error instanceof Error ? error.message : String(error));
		}
	};

	const abort = (): void => {
		if (!isAlive()) return;
		try {
			child.stdin?.end();
		} catch {
			// process may already be closing
		}
		signalProcessGroup(child, "SIGTERM");
		const killTimer = setTimeout(() => {
			if (isAlive()) {
				signalProcessGroup(child, "SIGKILL");
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
		processCommand: JSON.stringify([command, ...args]),
		promise,
		events,
		abort,
		heartbeatAt,
		send,
		lastChannelFailure: () => channelFailure,
		attestation: () => attestation,
	};
}

export function spawnNativeWorker(spec: WorkerSpec, opts?: SpawnOptions): SpawnedWorker {
	const workerEntry = opts?.workerEntryPath ?? join(resolvePackageRoot(), "dist/worker/entry.js");
	// Workers intentionally use node:sqlite for the trace journal. Its generic
	// ExperimentalWarning offers operators no action and otherwise leaks into
	// every internal-agent command's stderr. Suppress only that warning class;
	// ordinary process warnings remain visible.
	// Forward the whole option set. Enumerating it here is what silently dropped
	// every callback a caller passed, so the only field this function decides is
	// the entry path it consumed and the env default.
	const { workerEntryPath: _entryPath, ...processOptions } = opts ?? {};
	return spawnWorkerProcess(process.execPath, ["--disable-warning=ExperimentalWarning", workerEntry], spec, {
		...processOptions,
		env: withCompileCacheEnvironment(opts?.env ?? process.env),
	});
}

/**
 * Hand a native worker the parent's compile-cache directory. The worker's
 * whole static graph resolves before its first application statement, so an
 * in-process enableCompileCache() call there is too late; NODE_COMPILE_CACHE
 * is the only control Node reads early enough. Spawning a worker writes state
 * by definition, so the cache is established here when no boot entrypoint did
 * it earlier (a direct `fleet run` reaches this line with the cache still
 * unsettled); the enable is settle-once, root-gated, and operator-controlled
 * like everywhere else. Operator settings win, stale markers are normalized
 * away, and the worker entry consumes the injected pair from its own
 * process.env right after Node reads it, so the cache serves Clio's own
 * entry graph and never the user's node processes.
 */
function withCompileCacheEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return workerCompileCacheEnvironment(env, enableClioCompileCache());
}
