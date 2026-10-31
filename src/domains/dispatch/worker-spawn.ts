import type { FlowRestrictionSet } from "../../core/flow-restrictions.js";
import type { Payload } from "../../core/telemetry/schemas.js";
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
 *     and never drops a receipt-bearing frame. When evidence alone fills the
 *     queue's soft bound the lane pauses, so the backlog waits in the pipe
 *     and the worker instead of in this process.
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
	isReceiptBearingFrame,
	parseBulkFrame,
	parseControlFrame,
	parseWorkerHookRequest,
	verifyWorkerAttestation,
	WORKER_ANNOUNCE_DEADLINE_MS,
	WORKER_BULK_FRAME_MAX_BYTES,
	WORKER_EVENT_QUEUE_HARD_BYTES,
	WORKER_EVENT_QUEUE_HARD_FRAMES,
	WORKER_HOOK_REQUEST_EVENT,
	WORKER_QUARANTINE_MAX_BYTES,
	WORKER_QUARANTINE_MAX_FRAMES,
	WORKER_STDIN_FRAME_MAX_BYTES,
	WORKER_STDIN_QUEUE_MAX_BYTES,
	WORKER_STDOUT_FAILURE_MARKER,
	WORKER_STDOUT_INCOMPLETE_MARKER,
	type WorkerAdmitFrame,
	type WorkerAttestation,
	WorkerChannelFailure,
	type WorkerGrantRequestFrame,
	type WorkerHookRequest,
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
	 * Why the bulk lane could not deliver every frame the worker wrote: a
	 * retention bound was reached, a frame could not be classified, the final
	 * frame was truncated, the worker reported its own output gap or died by
	 * signal before finishing it, or the consumer detached. Present only then;
	 * a clean exit code is reported as 1.
	 */
	evidenceIncomplete?: string;
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
	/** Current and peak bulk-lane retention, for capacity diagnostics. */
	bulkLaneStats?(): WorkerBulkLaneStats;
}

export interface WorkerBulkLaneStats {
	retainedFrames: number;
	retainedBytes: number;
	peakFrames: number;
	peakBytes: number;
	/** Bytes already read from the pipe but not yet split into frames. */
	heldBytes: number;
	/** Unattested frames held before the announce verdict. */
	quarantinedFrames: number;
	quarantinedBytes: number;
	/** Times the lane paused for a full evidence backlog. */
	pauses: number;
	paused: boolean;
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

const FRAME_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
const ERRNO = /^E[A-Z0-9]{1,31}$/;

export interface WorkerProcessOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	shutdownGraceMs?: number;
	/**
	 * Every channel failure, the ones after exit that no longer change the outcome included, with the frame type
	 * actually being written and its error code, for the run's worker.channel records (#425).
	 */
	onChannelFailure?: (fact: Payload<"worker.channel">) => void;
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
	 * One extension hook request from the worker's tool loop. It is taken off
	 * the event stream here, so its arguments reach only the session's hook
	 * runner, never a display or a journal. Delivered only after the announce
	 * is accepted, so a request always belongs to an admitted identity.
	 */
	onHookRequest?: (request: WorkerHookRequest) => void;
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
/** Evidence-incomplete reason wording that failure classification reads (#425). */
export const ORCHESTRATOR_STDOUT_UNREAD_REASON = "orchestrator did not read worker stdout within";
export const WORKER_REPORTED_EVIDENCE_PREFIX = "the worker reported ";

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

/**
 * Bytes the bulk reader may hold unsplit: one partial frame at the lane
 * ceiling plus the rest of the chunk that arrived as the lane paused. Only a
 * source that keeps delivering after the pause can pass it.
 */
const BULK_HELD_MAX_BYTES = 2 * WORKER_BULK_FRAME_MAX_BYTES;

interface LineReader {
	write(chunk: Buffer): void;
	/** Split bytes kept while held; stops again if `hold` turns true. */
	resume(): void;
	/** Bytes read from the pipe and not yet delivered as a line. */
	heldBytes(): number;
	/** An unterminated line is pending, which a closed pipe leaves truncated. */
	truncated(): boolean;
}

/**
 * Bounded line reader. readline would buffer an unterminated line without
 * limit, so lines are split here and anything past the lane ceiling is
 * discarded before it can be parsed or retained. Lines are cut on raw bytes
 * and decoded whole, so a multibyte character split across two pipe chunks
 * arrives intact. While `hold` answers true the rest of the current chunk
 * stays unsplit: pausing the pipe cannot take back bytes it already delivered,
 * so they wait here as bytes rather than as parsed frames.
 */
function createLineReader(
	maxBytes: number,
	onLine: (line: string, bytes: number) => void,
	onOversize: () => void,
	hold: () => boolean = () => false,
): LineReader {
	let pieces: Buffer[] = [];
	let pieceBytes = 0;
	let discarding = false;
	// Chunks kept unsplit while held, oldest first. Node resumes a paused
	// child stdout itself once the child exits, so more can arrive here.
	let held: Buffer[] = [];
	let heldLength = 0;

	function split(chunk: Buffer): void {
		let start = 0;
		while (start < chunk.length) {
			if (hold()) {
				held.push(chunk.subarray(start));
				heldLength += chunk.length - start;
				return;
			}
			const newline = chunk.indexOf(0x0a, start);
			if (newline < 0) {
				const rest = chunk.length - start;
				if (discarding) return;
				if (pieceBytes + rest > maxBytes) {
					pieces = [];
					pieceBytes = 0;
					discarding = true;
					return;
				}
				pieces.push(chunk.subarray(start));
				pieceBytes += rest;
				return;
			}
			const bytes = pieceBytes + newline - start;
			if (discarding) {
				discarding = false;
				onOversize();
			} else if (bytes > maxBytes) {
				onOversize();
			} else {
				const last = chunk.subarray(start, newline);
				const line = pieces.length === 0 ? last.toString("utf8") : Buffer.concat([...pieces, last]).toString("utf8");
				pieces = [];
				pieceBytes = 0;
				start = newline + 1;
				onLine(line, bytes + 1);
				continue;
			}
			pieces = [];
			pieceBytes = 0;
			start = newline + 1;
		}
	}

	return {
		write(chunk: Buffer): void {
			if (held.length === 0) {
				split(chunk);
				return;
			}
			held.push(chunk);
			heldLength += chunk.length;
		},
		resume(): void {
			const chunks = held;
			held = [];
			heldLength = 0;
			// A chunk that holds again leaves the rest queued behind it, in order.
			for (const chunk of chunks) {
				if (held.length === 0) {
					split(chunk);
					continue;
				}
				held.push(chunk);
				heldLength += chunk.length;
			}
		},
		heldBytes: () => heldLength + pieceBytes,
		truncated: () => pieceBytes > 0 || discarding,
	};
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
		// #425: control-pipe diagnostics must never displace the worker's own stderr.
		const stderrText = stderrTail.toString("utf8").trim() || channelFailure?.message || "";
		const dropped = queue.stats().droppedDisplayFrames + preAnnounce.stats().droppedDisplayFrames;
		return {
			...(stderrText.length > 0 ? { stderrTail: stderrText } : {}),
			...(malformedStdoutLines > 0 ? { malformedStdoutLines } : {}),
			...(dropped > 0 ? { droppedDisplayFrames: dropped } : {}),
			...(evidenceIncomplete !== null ? { evidenceIncomplete } : {}),
			...(channelFailure !== null ? { channelFailure: channelFailure.operation } : {}),
		};
	}

	// Bulk-lane pressure. `bulkHeld` pauses stdout and holds the line reader;
	// `bulkDiscarding` drains the pipe without retaining anything once the
	// trail can no longer be complete or nobody reads it.
	let bulkHeld = false;
	let bulkPauses = 0;
	let bulkReleaseScheduled = false;
	let bulkDiscarding = false;
	let bulkOverflowed = false;
	let finishing = false;
	let evidenceIncomplete: string | null = null;

	function markEvidenceIncomplete(reason: string): void {
		if (evidenceIncomplete !== null) return;
		evidenceIncomplete = reason;
		appendStderr(`[worker] bulk evidence incomplete: ${reason}\n`);
	}

	function holdBulkLane(): void {
		if (bulkHeld || finishing || bulkDiscarding) return;
		bulkHeld = true;
		bulkPauses += 1;
		child.stdout?.pause();
	}

	function releaseBulkLane(): void {
		if (!bulkHeld) return;
		bulkHeld = false;
		// Held bytes precede anything still in the pipe, so they are split
		// first, and a backlog they rebuild keeps the pipe paused.
		stdoutReader.resume();
		if (!bulkHeld) child.stdout?.resume();
	}

	/** Resume off the consumer's own `next()` call, so no frame handler runs inside it. */
	function scheduleBulkRelease(): void {
		if (!bulkHeld || bulkReleaseScheduled || !queue.relieved) return;
		bulkReleaseScheduled = true;
		queueMicrotask(() => {
			bulkReleaseScheduled = false;
			if (queue.relieved) releaseBulkLane();
		});
	}

	/**
	 * Pressure could not hold the bulk lane inside its hard bound, so a frame
	 * the receipt needs was refused. Nothing after that gap can seal as a
	 * complete trail: the worker is stopped through its process owner and the
	 * rest of the pipe drains unretained so its close still arrives.
	 */
	function overflowBulkLane(reason: string): void {
		markEvidenceIncomplete(reason);
		if (bulkOverflowed) return;
		bulkOverflowed = true;
		bulkDiscarding = true;
		forceOwnedKill();
		releaseBulkLane();
	}

	/** The consumer stopped reading. Unread frames are released and the pipe drains unretained. */
	function detachConsumer(live: boolean): void {
		if (bulkDiscarding) return;
		bulkDiscarding = true;
		const unread = queue.size > 0;
		queue.clear();
		if ((unread || live) && !settled) markEvidenceIncomplete("the event consumer detached before the bulk lane ended");
		releaseBulkLane();
	}

	function push(value: unknown, bytes = 0): void {
		stampHeartbeat();
		if (bulkDiscarding) return;
		const w = waiters.shift();
		if (w) {
			w({ value, done: false });
			return;
		}
		if (queue.push(value, bytes) === "overflow") {
			overflowBulkLane(
				`the bulk lane reached its ${WORKER_EVENT_QUEUE_HARD_FRAMES} frame / ${WORKER_EVENT_QUEUE_HARD_BYTES} byte retention bound`,
			);
			return;
		}
		if (queue.pressured) holdBulkLane();
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
		// Held unattested frames are never released, so nothing keeps them.
		preAnnounce.clear();
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
		child.stdin.on("error", () => {
			// #425: each write callback owns its frame type; the stream event has no frame identity.
		});
		child.stdin.write(`${JSON.stringify(spec)}\n`, (error) => {
			if (error) failChannel("spec", error.message, "write-failed", error);
		});
		startAnnounceDeadline();
	}

	/**
	 * Bulk frames that arrived before the announce verdict. stdout and stderr are
	 * separate pipes with no ordering guarantee between them, so an early bulk
	 * frame is not evidence of a missing attestation. Frames are held in a
	 * quarantine that drops nothing and released only once the attestation
	 * verifies; a peer that floods past its bound, fails or never attests is
	 * stopped and its held frames discarded, so no unattested output ever
	 * reaches a consumer.
	 */
	const preAnnounce = createBoundedEventQueue(WORKER_QUARANTINE_MAX_FRAMES, {
		softFrames: Number.POSITIVE_INFINITY,
		softBytes: Number.POSITIVE_INFINITY,
		hardFrames: WORKER_QUARANTINE_MAX_FRAMES,
		hardBytes: WORKER_QUARANTINE_MAX_BYTES,
	});
	let attestationGraceTimer: ReturnType<typeof setTimeout> | null = null;

	function releaseHeldFrames(): void {
		if (attestationGraceTimer !== null) {
			clearTimeout(attestationGraceTimer);
			attestationGraceTimer = null;
		}
		for (let held = preAnnounce.take(); held !== undefined; held = preAnnounce.take()) push(held.value, held.bytes);
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

	function handleBulkLine(line: string, bytes: number): void {
		const trimmed = line.trim();
		if (trimmed.length === 0) return;
		const frame = parseBulkFrame(trimmed);
		if (!frame.ok) {
			malformedStdoutLines += 1;
			// isReceiptBearingFrame treats an unclassifiable frame as evidence.
			markEvidenceIncomplete(`a bulk frame could not be parsed: ${frame.reason}`);
			return;
		}
		if (announceFailed) return;
		const bulk = frame.value as { type?: unknown; payload?: unknown } | null;
		if (typeof bulk === "object" && bulk !== null && bulk.type === WORKER_HOOK_REQUEST_EVENT) {
			const request = announceAccepted ? parseWorkerHookRequest(bulk.payload) : null;
			if (request === null) appendStderr("[worker] dropped a hook request from an unadmitted or malformed frame\n");
			else opts?.onHookRequest?.(request);
			return;
		}
		if (bulkDiscarding) {
			// An overflow already failed the run; a detached consumer loses what it never read.
			if (!bulkOverflowed && isReceiptBearingFrame(frame.value)) {
				markEvidenceIncomplete("the event consumer detached before the bulk lane ended");
			}
			return;
		}
		if (!announceAccepted) {
			if (preAnnounce.push(frame.value, bytes) === "overflow") {
				failAttestation(
					`Unattested worker output exceeded the ${WORKER_QUARANTINE_MAX_FRAMES} frame / ${WORKER_QUARANTINE_MAX_BYTES} byte quarantine before announcing its route identity`,
				);
				return;
			}
			startAttestationGrace();
			return;
		}
		push(frame.value, bytes);
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

	const stdoutReader = createLineReader(
		WORKER_BULK_FRAME_MAX_BYTES,
		handleBulkLine,
		() => {
			malformedStdoutLines += 1;
			markEvidenceIncomplete(`a bulk frame over the ${WORKER_BULK_FRAME_MAX_BYTES} byte lane limit was dropped`);
		},
		() => bulkHeld,
	);
	if (child.stdout) {
		child.stdout.on("data", (chunk: Buffer) => {
			stdoutReader.write(chunk);
			if (stdoutReader.heldBytes() > BULK_HELD_MAX_BYTES) {
				overflowBulkLane(`the bulk lane kept delivering past its ${BULK_HELD_MAX_BYTES} byte pause bound`);
			}
		});
	}

	if (child.stderr) {
		const stderrReader = createLineReader(
			WORKER_BULK_FRAME_MAX_BYTES,
			(line) => {
				if (isControlLine(line)) {
					handleControlLine(line);
					return;
				}
				if (line.startsWith(WORKER_STDOUT_FAILURE_MARKER)) {
					reportStdoutFailure(line.slice(WORKER_STDOUT_FAILURE_MARKER.length));
					return;
				}
				appendStderr(`${line}\n`);
				if (line.startsWith(WORKER_STDOUT_INCOMPLETE_MARKER)) {
					markEvidenceIncomplete(`${WORKER_REPORTED_EVIDENCE_PREFIX}${line.slice(WORKER_STDOUT_INCOMPLETE_MARKER.length)}`);
				}
			},
			() => appendStderr("[worker] dropped an oversized stderr line\n"),
		);
		child.stderr.on("data", (chunk: Buffer) => stderrReader.write(chunk));
	}

	const events: AsyncIterableIterator<unknown> = {
		next(): Promise<IteratorResult<unknown>> {
			if (queue.size > 0) {
				const value = queue.shift();
				scheduleBulkRelease();
				return Promise.resolve({ value, done: false });
			}
			if (finished) return Promise.resolve({ value: undefined, done: true });
			return new Promise<IteratorResult<unknown>>((resolve) => {
				waiters.push(resolve);
			});
		},
		return(): Promise<IteratorResult<unknown>> {
			// A consumer leaving a live stream would orphan the worker's provider
			// and tool work, so the run stops through the process owner.
			const live = !finished;
			end();
			detachConsumer(live);
			if (live) abort();
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
		finishing = true;
		if (bulkHeld) {
			// Bytes already read are split into the queue under its hard bound
			// before the pipes close. Node resumes a paused child stdout itself
			// once the child exits, so the pause withholds nothing past that point.
			bulkHeld = false;
			stdoutReader.resume();
		}
		if (stdoutReader.truncated()) {
			malformedStdoutLines += 1;
			markEvidenceIncomplete("the final bulk frame was truncated");
		}
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
		// A worker killed by a signal never ran its own drain, so even a trail
		// that ends on a frame boundary cannot be known to be whole.
		if (code === null && signal !== null && !sawSpawnError) {
			markEvidenceIncomplete(`the worker was terminated by ${signal} before it finished its output`);
		}
		// The signal itself stays in `signal`; receipts admit only exit codes 0-2,
		// so a signal death reads as the generic failure code, never as 0.
		let exitCode: number | null = code ?? (signal !== null ? 1 : 0);
		if (sawSpawnError || (cleanupStatus.incomplete && leaderExit === null)) exitCode = null;
		else if (announceFailed) exitCode = code !== null && code !== 0 ? code : 1;
		else if (evidenceIncomplete !== null && exitCode === 0) exitCode = 1;
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
			// #425: the worker drained before its clean exit, so frames still unread
			// here are lost on this side and the trail cannot seal as whole.
			if (leaderExit?.code === 0 && child.stdout && !child.stdout.readableEnded) {
				markEvidenceIncomplete(`${ORCHESTRATOR_STDOUT_UNREAD_REASON} ${SAFE_EXEC_PIPE_DRAIN_BOUND_MS} ms after exit`);
			}
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

	function reportChannel(fact: Payload<"worker.channel">): void {
		try {
			opts?.onChannelFailure?.(fact);
		} catch {
			// A record of the failure never changes how the run ends (#425).
		}
	}

	/** The worker's own typed twin of its incomplete-output line; anything unreadable is an invalid frame. */
	function reportStdoutFailure(json: string): void {
		const known = ["write-failed", "oversize-frame", "unserializable-frame", "backlog-full", "undrained"] as const;
		let value: { failure?: unknown; errno?: unknown; frameType?: unknown } = {};
		try {
			value = JSON.parse(json) as typeof value;
		} catch {
			// Reported below as an invalid frame.
		}
		const failure = known.find((kind) => kind === value.failure) ?? "invalid-frame";
		reportChannel({
			lane: "stdout",
			frameType: typeof value.frameType === "string" && FRAME_TYPE.test(value.frameType) ? value.frameType : null,
			errno: typeof value.errno === "string" && ERRNO.test(value.errno) ? value.errno : null,
			afterExit: false,
			failure,
		});
	}

	function failChannel(
		operation: WorkerChannelFailure["operation"],
		detail: string,
		kind: Payload<"worker.channel">["failure"],
		error?: unknown,
		frameType: string = operation,
	): false {
		const code = (error as { code?: unknown } | undefined)?.code;
		reportChannel({
			lane: "stdin",
			frameType: FRAME_TYPE.test(frameType) ? frameType : operation,
			errno: typeof code === "string" && ERRNO.test(code) ? code : null,
			afterExit: leaderExit !== null || closed,
			failure: kind,
		});
		if (!isAlive() || settled || abortStarted) return false;
		const failure = new WorkerChannelFailure(operation, detail);
		// A lost hook answer never hides the failure of a frame the run depends on.
		if (operation !== "hook_result" || channelFailure === null) channelFailure = failure;
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
						: frameType === "hook_result"
							? "hook_result"
							: "steer";
		// #425: receipt finalization can outlive process exit; late board updates are harmless no-ops.
		if (!isAlive() || settled || abortStarted || leaderExit !== null) return false;
		const stdin = child.stdin;
		const written = typeof frameType === "string" ? frameType : operation;
		if (!stdin || stdin.destroyed || !stdin.writable)
			return failChannel(operation, "worker stdin is not writable", "write-failed", undefined, written);
		const line = `${JSON.stringify(value)}\n`;
		const bytes = Buffer.byteLength(line, "utf8");
		if (bytes > WORKER_STDIN_FRAME_MAX_BYTES) {
			return failChannel(
				operation,
				`frame of ${bytes} bytes exceeds the ${WORKER_STDIN_FRAME_MAX_BYTES} byte limit`,
				"oversize-frame",
				undefined,
				written,
			);
		}
		if (queuedStdinBytes + bytes > WORKER_STDIN_QUEUE_MAX_BYTES) {
			return failChannel(
				operation,
				`stdin queue is full (${queuedStdinBytes} of ${WORKER_STDIN_QUEUE_MAX_BYTES} bytes pending)`,
				"backlog-full",
				undefined,
				written,
			);
		}
		try {
			queuedStdinBytes += bytes;
			stdin.write(line, (error) => {
				queuedStdinBytes -= bytes;
				if (error) failChannel(operation, error.message, "write-failed", error, written);
			});
			return true;
		} catch (error) {
			queuedStdinBytes -= bytes;
			return failChannel(
				operation,
				error instanceof Error ? error.message : String(error),
				"write-failed",
				error,
				written,
			);
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
		bulkLaneStats: () => {
			const stats = queue.stats();
			return {
				retainedFrames: queue.size,
				retainedBytes: queue.bytes,
				peakFrames: stats.peakDepth,
				peakBytes: stats.peakBytes,
				heldBytes: stdoutReader.heldBytes(),
				quarantinedFrames: preAnnounce.size,
				quarantinedBytes: preAnnounce.bytes,
				pauses: bulkPauses,
				paused: bulkHeld,
			};
		},
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
	return spawnHeldWorkerProcess(process.execPath, [workerEntry], {
		...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
		env: withCompileCacheEnvironment(opts?.env ?? process.env),
	});
}

export function spawnNativeWorker(spec: WorkerSpec, opts?: SpawnOptions): SpawnedWorker {
	const workerEntry = opts?.workerEntryPath ?? join(resolvePackageRoot(), "dist/worker/entry.js");
	// Forward the whole option set. Enumerating it here is what silently dropped
	// every callback a caller passed, so the only field this function decides is
	// the entry path it consumed and the env default.
	const { workerEntryPath: _entryPath, ...processOptions } = opts ?? {};
	return spawnWorkerProcess(process.execPath, [workerEntry], spec, {
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
