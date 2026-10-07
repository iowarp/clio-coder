import type { FlowRestrictionSet } from "../../core/flow-restrictions.js";
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
 * Stdin carries the spec and, once the announce verifies, the `admit` frame
 * the worker waits for before its first model call.
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
import { performance } from "node:perf_hooks";
import { withClioAgentEnvironment } from "../../core/agent-environment.js";
import {
	enableClioCompileCache,
	publishClioCompileCache,
	workerCompileCacheEnvironment,
} from "../../core/compile-cache.js";
import { resolvePackageRoot } from "../../core/package-root.js";
import type { ProcessGroupCleanupStatus } from "../../core/safe-exec.js";
import {
	createProcessGroupCleanup,
	SAFE_EXEC_GROUP_TEARDOWN_BOUND_MS,
	SAFE_EXEC_PIPE_DRAIN_BOUND_MS,
} from "../../core/safe-exec.js";
import type { WorkerSpec } from "../../worker/spec-contract.js";
import type { HeartbeatStamp } from "./heartbeat.js";
import {
	type AgentLedgerBody,
	type ApprovedWorkerIdentity,
	approvedIdentityForSpec,
	createBoundedEventQueue,
	isControlLine,
	parseBulkFrame,
	parseControlFrame,
	verifyWorkerAttestation,
	WORKER_ANNOUNCE_DEADLINE_MS,
	WORKER_BULK_FRAME_MAX_BYTES,
	WORKER_STDIN_FRAME_MAX_BYTES,
	WORKER_STDIN_QUEUE_MAX_BYTES,
	type WorkerAdmitFrame,
	type WorkerAttestation,
	WorkerChannelFailure,
	type WorkerGrantRequestFrame,
	type WorkerModelLoad,
} from "./worker-protocol.js";

export type { WorkerSpec } from "../../worker/spec-contract.js";
export { WorkerChannelFailure } from "./worker-protocol.js";

export interface WorkerProcessCleanup extends ProcessGroupCleanupStatus {
	pipeDrainIncomplete: boolean;
}

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
	/** Local process ownership outcome; an SSH child cannot attest remote cleanup. */
	processCleanup?: WorkerProcessCleanup;
}

export interface SpawnedWorker {
	pid: number | null;
	/** Exact spawned argv encoded as JSON; trace consumers must not shell-parse it. */
	processCommand?: string;
	promise: Promise<SpawnedWorkerResult>;
	events: AsyncIterableIterator<unknown>;
	abort(): void;
	heartbeatAt: HeartbeatStamp;
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
	onLedgerPost?: (body: AgentLedgerBody, flowRestrictions?: FlowRestrictionSet) => void;
	/**
	 * One model the worker's request loaded and pinned. The orchestrator owns the
	 * release of worker loads, so dispatch adopts each report into its own
	 * residency registries. Delivered only after the announce is accepted, so a
	 * report always belongs to an admitted identity.
	 */
	onModelLoaded?: (load: WorkerModelLoad) => void;
	/**
	 * One worker ask routed to the main agent's grant broker (Phase D).
	 * Delivered only after the announce is accepted, so a request always
	 * belongs to an admitted identity.
	 */
	onGrantRequest?: (request: WorkerGrantRequestFrame) => void;
	/**
	 * Identity the plan approved. Defaults to the identity of the spec actually
	 * written to stdin, which is what every production caller wants; a caller
	 * with a separately sealed plan identity passes it explicitly.
	 */
	approvedIdentity?: ApprovedWorkerIdentity;
	/** How long bulk output may precede the announce before the peer is refused. */
	attestationGraceMs?: number;
	/**
	 * How long after the spec is written the peer may go without an attestation
	 * verdict before it is refused. Defaults to WORKER_ANNOUNCE_DEADLINE_MS.
	 */
	announceDeadlineMs?: number;
	/**
	 * Wall clock behind the heartbeat anchor, defaulting to `Date.now`. The
	 * anchor stays a wall-clock instant because the ledger and evidence record
	 * serialize the derived heartbeat as ISO-8601 for an operator to read. This
	 * clock is read once; later heartbeat instants add a monotonic span to it.
	 */
	now?: () => number;
	/** Monotonic clock used for heartbeat spans, defaulting to `performance.now`. */
	monotonicNow?: () => number;
}

/**
 * SIGTERM→SIGKILL window on worker abort. Kept tight so TUI exit with an
 * in-flight worker still returns the shell prompt in well under a second.
 * A cooperative child exits on SIGTERM within this window; a stuck one
 * gets SIGKILL. Callers that need a longer graceful window (e.g. user-
 * initiated cancel with output flush) pass `shutdownGraceMs` explicitly.
 */
const DEFAULT_SHUTDOWN_GRACE_MS = 500;
/** Existing escalation and pipe bounds, conservatively allowed in sequence. */
export const WORKER_PROCESS_CLEANUP_BOUND_MS =
	DEFAULT_SHUTDOWN_GRACE_MS + SAFE_EXEC_GROUP_TEARDOWN_BOUND_MS + SAFE_EXEC_PIPE_DRAIN_BOUND_MS;
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

/** Start the worker process itself. The spec, and with it the approved identity, comes later. */
function launchWorkerChild(
	command: string,
	args: ReadonlyArray<string>,
	opts?: Pick<WorkerProcessOptions, "cwd" | "env">,
): ChildProcess {
	return spawn(command, [...args], {
		stdio: ["pipe", "pipe", "pipe"],
		cwd: opts?.cwd,
		env: withClioAgentEnvironment(opts?.env ?? process.env),
		// The worker leads its own process group so abort escalation covers the
		// descendants a runtime spawned, not only the immediate child.
		detached: true,
	});
}

export function spawnWorkerProcess(
	command: string,
	args: ReadonlyArray<string>,
	spec: WorkerSpec,
	opts?: WorkerProcessOptions,
): SpawnedWorker {
	return attachWorkerChannel(launchWorkerChild(command, args, opts), command, args, spec, opts);
}

/**
 * Write the spec to a running worker child and wire both protocol lanes. The
 * approved identity is derived from this spec here, so a child that was
 * started before its spec existed is held to exactly the identity a cold
 * spawn of the same spec would be.
 */
function attachWorkerChannel(
	child: ChildProcess,
	command: string,
	args: ReadonlyArray<string>,
	spec: WorkerSpec,
	opts?: WorkerProcessOptions,
): SpawnedWorker {
	const shutdownGraceMs = opts?.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
	const attestationGraceMs = opts?.attestationGraceMs ?? DEFAULT_ATTESTATION_GRACE_MS;
	const announceDeadlineMs = opts?.announceDeadlineMs ?? WORKER_ANNOUNCE_DEADLINE_MS;
	const now = opts?.now ?? Date.now;
	const monotonicNow = opts?.monotonicNow ?? (() => performance.now());
	const approved = opts?.approvedIdentity ?? approvedIdentityForSpec(spec);
	const pid = child.pid ?? null;

	// One wall anchor plus a monotonic span keeps the persisted/display instant
	// readable without ever asking a later wall-clock read how much time passed.
	const heartbeatWallAnchor = now();
	const heartbeatMonotonicAnchor = monotonicNow();
	const heartbeatAt: HeartbeatStamp = {
		current: heartbeatWallAnchor,
		monotonic: heartbeatMonotonicAnchor,
	};
	const stampHeartbeat = (): void => {
		const stamp = monotonicNow();
		heartbeatAt.monotonic = stamp;
		heartbeatAt.current = heartbeatWallAnchor + (stamp - heartbeatMonotonicAnchor);
	};

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
		stampHeartbeat();
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
	let announceDeadlineTimer: ReturnType<typeof setTimeout> | null = null;

	function clearAnnounceDeadline(): void {
		if (announceDeadlineTimer === null) return;
		clearTimeout(announceDeadlineTimer);
		announceDeadlineTimer = null;
	}

	/**
	 * A protocol 2 worker produces no bulk output until it is admitted, so the
	 * bulk-triggered grace below never starts for one that heartbeats but never
	 * announces. This bound starts with the spec write, which for a held worker
	 * is adoption rather than spawn.
	 */
	function startAnnounceDeadline(): void {
		if (announceDeadlineTimer !== null || announceAccepted || announceFailed) return;
		announceDeadlineTimer = setTimeout(() => {
			announceDeadlineTimer = null;
			if (announceAccepted || announceFailed) return;
			failAttestation(
				`Missing worker attestation: the peer did not announce its route identity within ${announceDeadlineMs} ms of receiving its spec`,
			);
		}, announceDeadlineMs);
		announceDeadlineTimer.unref?.();
	}

	function failAttestation(message: string): void {
		if (announceFailed) return;
		announceFailed = true;
		clearAnnounceDeadline();
		appendStderr(`[worker] ${message}\n`);
		// A peer that did not prove the approved route identity must not execute.
		// Terminate the whole group authoritatively rather than offering a
		// catchable grace signal.
		forceOwnedKill();
	}

	child.once("error", (err) => {
		sawSpawnError = true;
		const message = err instanceof Error ? err.message : String(err);
		// The receipt's diagnostics read the stderr tail, and the spawn_error
		// frame alone reached only the `run --json` stream, so the one fact that
		// says why the worker never started was missing from the sealed receipt.
		appendStderr(`[worker] spawn error: ${message}\n`);
		push({ type: "spawn_error", error: message });
		forceOwnedKill();
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
		startAnnounceDeadline();
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
		stampHeartbeat();
		if (frame.value.kind === "announce") {
			if (announceAccepted || announceFailed) return;
			const verdict = verifyWorkerAttestation(frame.value.attestation, approved);
			if (!verdict.ok) {
				failAttestation(`Worker attestation rejected: ${verdict.reason}`);
				return;
			}
			announceAccepted = true;
			clearAnnounceDeadline();
			attestation = frame.value.attestation;
			opts?.onAnnounce?.(frame.value.attestation);
			// The worker holds its model run until this frame names the digest it
			// attested. A worker the admit cannot reach would only wait out its own
			// bound, so it is stopped here instead of holding its slot.
			if (!send({ type: "admit", specDigest: approved.specDigest } satisfies WorkerAdmitFrame)) {
				forceOwnedKill();
				return;
			}
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
			opts?.onLedgerPost?.(frame.value.body, frame.value.flowRestrictions);
			return;
		}
		if (frame.value.kind === "model_loaded") {
			if (!announceAccepted) {
				appendStderr("[worker] dropped a model load report that arrived before attestation was accepted\n");
				return;
			}
			opts?.onModelLoaded?.(frame.value.load);
			return;
		}
		if (frame.value.kind === "grant_request") {
			if (!announceAccepted) {
				appendStderr("[worker] dropped a grant request that arrived before attestation was accepted\n");
				return;
			}
			opts?.onGrantRequest?.(frame.value.request);
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

	let settled = false;
	let abortStarted = false;
	let closed = false;
	let leaderExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
	let cleanupStatus: ProcessGroupCleanupStatus | null = null;
	let pipeDrainIncomplete = false;
	let pipeDrainFinished = false;
	let drainTimer: ReturnType<typeof setTimeout> | null = null;
	let resolveResult!: (result: SpawnedWorkerResult) => void;
	const promise = new Promise<SpawnedWorkerResult>((resolve) => {
		resolveResult = resolve;
	});

	function isAlive(): boolean {
		return child.exitCode === null && child.signalCode === null;
	}

	function hasOwnedProcesses(): boolean {
		if (pid === null) return false;
		if (process.platform === "win32") return isAlive();
		try {
			process.kill(-pid, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code !== "ESRCH";
		}
	}

	function signalOwnedProcesses(signal: NodeJS.Signals): boolean {
		let delivered: boolean;
		if (pid !== null && process.platform !== "win32") {
			try {
				process.kill(-pid, signal);
				delivered = true;
			} catch (error) {
				return (error as NodeJS.ErrnoException).code !== "ESRCH";
			}
		} else {
			delivered = isAlive() && child.kill(signal);
		}
		if (delivered && signal === "SIGKILL" && abortStarted) {
			try {
				opts?.onForcedKill?.();
			} catch {
				// Remote fallback remains best-effort; local cleanup proves nothing remote.
			}
		}
		return delivered;
	}

	function finish(): void {
		if (settled || cleanupStatus === null || (!closed && !pipeDrainFinished)) return;
		settled = true;
		if (drainTimer !== null) clearTimeout(drainTimer);
		if (attestationGraceTimer !== null) clearTimeout(attestationGraceTimer);
		drainTimer = attestationGraceTimer = null;
		clearAnnounceDeadline();
		try {
			child.stdin?.end();
		} catch {
			// stdin may already be closed.
		}
		child.stdout?.destroy();
		child.stderr?.destroy();
		child.unref();
		end();
		if (!sawSpawnError && !announceAccepted && !announceFailed) {
			announceFailed = true;
			appendStderr("[worker] Missing worker attestation: peer exited before announcing its route identity\n");
		}
		const code = leaderExit?.code ?? child.exitCode;
		const signal = leaderExit?.signal ?? child.signalCode;
		let exitCode: number | null = code ?? 0;
		if (sawSpawnError || (cleanupStatus.incomplete && leaderExit === null)) exitCode = null;
		else if (announceFailed) exitCode = code !== null && code !== 0 ? code : 1;
		resolveResult({
			exitCode,
			signal: sawSpawnError ? null : signal,
			...diagnostics(),
			processCleanup: { ...cleanupStatus, pipeDrainIncomplete },
		});
	}

	function boundPipeDrain(): void {
		if (closed || drainTimer !== null) return;
		drainTimer = setTimeout(() => {
			drainTimer = null;
			pipeDrainFinished = true;
			pipeDrainIncomplete = Boolean(
				(child.stdout && !child.stdout.readableEnded) || (child.stderr && !child.stderr.readableEnded),
			);
			child.stdout?.destroy();
			child.stderr?.destroy();
			finish();
		}, SAFE_EXEC_PIPE_DRAIN_BOUND_MS);
	}

	const processOwner = createProcessGroupCleanup({
		graceMs: shutdownGraceMs,
		probe: hasOwnedProcesses,
		signal: signalOwnedProcesses,
		onDone(status) {
			cleanupStatus = status;
			boundPipeDrain();
			finish();
		},
	});
	child.once("exit", (code, signal) => {
		leaderExit = { code, signal };
		boundPipeDrain();
		processOwner.leaderExited();
		finish();
	});
	child.once("close", (code, signal) => {
		closed = true;
		leaderExit ??= { code, signal };
		if (pid === null) {
			processOwner.dispose();
			cleanupStatus = { descendantsCleaned: false, incomplete: false };
		} else {
			processOwner.leaderExited();
		}
		finish();
	});

	function forceOwnedKill(): void {
		if (processOwner.done) return;
		if (hasOwnedProcesses()) signalOwnedProcesses("SIGKILL");
		processOwner.kill();
	}

	/**
	 * Bounded stdin queue. `stream.write` returning false means the kernel
	 * buffer is full, and Node keeps buffering in user space without limit, so
	 * the pending bytes are counted here and a write past the ceiling is a
	 * typed channel failure rather than unbounded growth.
	 */
	let queuedStdinBytes = 0;

	function failChannel(operation: "steer" | "permission_decision" | "ledger_delta" | "admit", detail: string): false {
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
					: frameType === "admit"
						? "admit"
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
		if (settled || abortStarted || processOwner.done) return;
		abortStarted = true;
		try {
			child.stdin?.end();
		} catch {
			// The control lane may already be closing.
		}
		processOwner.kill();
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

/**
 * A worker process started before its spec exists, for speculative dispatch.
 *
 * The child boots, loads the worker's module graph and blocks reading stdin,
 * which is the whole of what a prewarm buys. Nothing about the run is decided
 * here: `adopt` writes the spec and derives the approved identity from it at
 * that moment, so attestation is exactly as strong as a cold spawn's, and a
 * child that announces anything before its spec arrives fails attestation.
 *
 * While held, the child and its pipes do not keep this process alive, and a
 * held child whose parent dies reads end-of-file on stdin and exits, so a
 * crash cannot leave one behind.
 */
export interface HeldWorkerProcess {
	readonly pid: number | null;
	/** True while the child is running and still waiting for its spec. */
	alive(): boolean;
	/** Write the spec and hand back the worker, or null when the held child is gone. */
	adopt(spec: WorkerSpec, opts?: WorkerProcessOptions): SpawnedWorker | null;
	/** Kill the held child's process group. A no-op once adopted or discarded. */
	discard(): void;
}

function setChildReferenced(child: ChildProcess, referenced: boolean): void {
	const streams = [child.stdin, child.stdout, child.stderr] as Array<{ ref?: () => void; unref?: () => void } | null>;
	for (const stream of streams) {
		if (referenced) stream?.ref?.();
		else stream?.unref?.();
	}
	if (referenced) child.ref();
	else child.unref();
}

export function spawnHeldWorkerProcess(
	command: string,
	args: ReadonlyArray<string>,
	opts?: Pick<WorkerProcessOptions, "cwd" | "env">,
): HeldWorkerProcess {
	const child = launchWorkerChild(command, args, opts);
	let state: "held" | "adopted" | "discarded" = "held";
	let gone = false;
	child.once("exit", () => {
		gone = true;
	});
	child.once("error", () => {
		gone = true;
	});
	// The pipe raises EPIPE asynchronously when a held child dies; without a
	// listener that is an unhandled stream error in the orchestrator.
	child.stdin?.on("error", () => {
		gone = true;
	});
	setChildReferenced(child, false);
	const alive = (): boolean =>
		state === "held" && !gone && child.pid !== undefined && child.exitCode === null && child.signalCode === null;
	return {
		pid: child.pid ?? null,
		alive,
		adopt(spec, adoptOptions) {
			if (!alive()) return null;
			state = "adopted";
			setChildReferenced(child, true);
			return attachWorkerChannel(child, command, args, spec, adoptOptions);
		},
		discard() {
			if (state !== "held") return;
			state = "discarded";
			try {
				child.stdin?.end();
			} catch {
				// Already closed.
			}
			signalProcessGroup(child, "SIGKILL");
		},
	};
}

/** The native worker entry, held for its spec. Same argv and environment as `spawnNativeWorker`. */
export function spawnHeldNativeWorker(opts?: Pick<SpawnOptions, "cwd" | "env" | "workerEntryPath">): HeldWorkerProcess {
	const workerEntry = opts?.workerEntryPath ?? join(resolvePackageRoot(), "dist/worker/entry.js");
	return spawnHeldWorkerProcess(process.execPath, ["--disable-warning=ExperimentalWarning", workerEntry], {
		...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
		env: withCompileCacheEnvironment(opts?.env ?? process.env),
	});
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
let publishedCompileCache = false;
function withCompileCacheEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const directory = enableClioCompileCache();
	if (!publishedCompileCache && directory !== null) {
		publishClioCompileCache();
		publishedCompileCache = true;
	}
	return workerCompileCacheEnvironment(env, directory);
}
