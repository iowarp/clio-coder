/**
 * Orchestrator-side worker protocol: attestation admission, lane bounds, and
 * the bounded event queue.
 *
 * The wire schema itself lives in src/worker/protocol.ts because the worker
 * process may not value-import this domain. This module owns the half only the
 * orchestrator needs: the fingerprints it computes from approved settings, the
 * comparison that admits or refuses an attested worker, the queue that bounds
 * how much bulk output may accumulate, and the typed channel failure a control
 * write reports when it cannot reach the worker.
 */

import { createHash } from "node:crypto";
import type { ToolName } from "../../core/tool-names.js";
import { attestedToolSignature } from "../../engine/worker-tools.js";
import type { ToolProfileName } from "../../tools/profiles.js";
import {
	canonicalJson,
	endpointIdentityHash,
	isReceiptBearingFrame,
	toolSignatureOf,
	WORKER_BULK_FRAME_MAX_BYTES,
	WORKER_EVENT_QUEUE_MAX_FRAMES,
	WORKER_PROTOCOL_VERSION,
	type WorkerAttestation,
} from "../../worker/protocol.js";

export type {
	AgentLedgerBody,
	AgentLedgerBodyParse,
	AgentLedgerDeltaFrame,
	AgentLedgerEntry,
	AgentLedgerPort,
	WorkerAdmitFrame,
	WorkerAttestation,
	WorkerControlFrame,
	WorkerExtensionHook,
	WorkerGrantRequestFrame,
	WorkerHookEffect,
	WorkerHookRequest,
	WorkerHookResultFrame,
	WorkerHookRun,
	WorkerModelLoad,
	WorkerResourceFacts,
	WorkerResourceValue,
} from "../../worker/protocol.js";
export {
	AGENT_LEDGER_CLAIM_MAX_CHARS,
	AGENT_LEDGER_EVIDENCE_MAX_CHARS,
	AGENT_LEDGER_INTENT_MAX_CHARS,
	AGENT_LEDGER_PATH_MAX_CHARS,
	AGENT_LEDGER_SCOPE_ENTRY_MAX_CHARS,
	AGENT_LEDGER_SCOPE_MAX_ENTRIES,
	CONTROL_FRAME_PREFIX,
	encodeControlFrame,
	endpointIdentityHash,
	isAgentLedgerEntryId,
	isControlLine,
	isReceiptBearingFrame,
	parseAgentLedgerBody,
	parseBulkFrame,
	parseControlFrame,
	parseWorkerHookRequest,
	toolSignatureOf,
	WORKER_ANNOUNCE_DEADLINE_MS,
	WORKER_BULK_FRAME_MAX_BYTES,
	WORKER_CONTROL_FRAME_MAX_BYTES,
	WORKER_EVENT_QUEUE_MAX_FRAMES,
	WORKER_HOOK_REQUEST_EVENT,
	WORKER_PROTOCOL_VERSION,
	WORKER_STDIN_FRAME_MAX_BYTES,
	WORKER_STDIN_QUEUE_MAX_BYTES,
	WORKER_STDOUT_INCOMPLETE_MARKER,
	withinFrameBudget,
	workerSpecDigest,
} from "../../worker/protocol.js";

export { computeSettingsFingerprint } from "./settings-fingerprint.js";

/** Route and node identity the orchestrator approved before the spawn. */
export interface ApprovedWorkerIdentity {
	specVersion: number;
	settingsFingerprint: string;
	specDigest: string;
	runtimeId: string;
	targetId: string;
	endpointIdentityHash: string;
	wireModelId: string;
	/** Fingerprint of the exact tool names the admitted WorkerSpec permits. */
	toolSignature: string;
}

export type AttestationVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Admit an attested worker only when every identity field equals the approved
 * plan. This is a full-field comparison rather than a spot check: a worker
 * that resolved a different endpoint, model, runtime, or tool surface than the
 * plan approved must not reach a model, whatever else it announced correctly.
 * The verdict holds because the worker waits for the `admit` frame, which
 * `worker-spawn.ts` writes only after this returns ok.
 */
export function verifyWorkerAttestation(
	attestation: WorkerAttestation,
	approved: ApprovedWorkerIdentity,
): AttestationVerdict {
	if (attestation.protocolVersion !== WORKER_PROTOCOL_VERSION) {
		return {
			ok: false,
			reason: `worker protocol mismatch: approved ${WORKER_PROTOCOL_VERSION}, worker announced ${attestation.protocolVersion}`,
		};
	}
	const fields: Array<[string, unknown, unknown]> = [
		["WorkerSpec version", approved.specVersion, attestation.specVersion],
		["settings fingerprint", approved.settingsFingerprint, attestation.settingsFingerprint],
		["WorkerSpec digest", approved.specDigest, attestation.specDigest],
		["runtime", approved.runtimeId, attestation.runtimeId],
		["target", approved.targetId, attestation.targetId],
		["endpoint identity", approved.endpointIdentityHash, attestation.endpointIdentityHash],
		["wire model", approved.wireModelId, attestation.wireModelId],
		["tool surface", approved.toolSignature, attestation.toolSignature],
	];
	for (const [label, expected, announced] of fields) {
		if (!Object.is(expected, announced)) {
			return {
				ok: false,
				reason: `${label} drift: dispatched ${String(expected)}, worker announced ${String(announced)}`,
			};
		}
	}
	return { ok: true };
}

/** Approved identity derived from the document actually written to the worker. */
export function approvedIdentityForSpec(spec: {
	specVersion: number;
	settingsFingerprint: string;
	runtimeId: string;
	wireModelId: string;
	target: { id: string; url?: string };
	allowedTools: ReadonlyArray<string>;
	helperResult?: true;
	toolProfile?: ToolProfileName;
	agentId?: string;
	task?: string;
	runtimeResolution?: { capabilities: { tools: boolean | null } };
}): ApprovedWorkerIdentity {
	return {
		specVersion: spec.specVersion,
		settingsFingerprint: spec.settingsFingerprint,
		specDigest: workerSpecDigestOf(spec),
		runtimeId: spec.runtimeId,
		targetId: spec.target.id,
		endpointIdentityHash: endpointIdentityHash(spec.target.url),
		wireModelId: spec.wireModelId,
		// The spec carries the final runtime-narrowed admission surface. The
		// worker fingerprints its independently resolved registry intersection,
		// so a missing, added, or differently filtered tool fails admission.
		toolSignature:
			spec.helperResult === true
				? attestedToolSignature({
						allowedTools: spec.allowedTools as ReadonlyArray<ToolName>,
						toolsSupported: spec.runtimeResolution?.capabilities.tools === true,
						helperResult: true,
						...(spec.toolProfile !== undefined ? { toolProfile: spec.toolProfile } : {}),
						...(spec.agentId !== undefined ? { agentId: spec.agentId } : {}),
						...(spec.task !== undefined ? { task: spec.task } : {}),
					})
				: toolSignatureOf(spec.allowedTools),
	};
}

function workerSpecDigestOf(spec: unknown): string {
	return createHash("sha256")
		.update(`clio-coder.workerSpec:${canonicalJson(spec)}`, "utf8")
		.digest("hex");
}

/**
 * A control write that could not reach the worker. Reported as a typed channel
 * failure so failure classification routes it to the node dimension instead of
 * blaming the target or the model.
 */
/** The stdin write that failed. A lost `hook_result` is answered by the worker's own hook policy, not by the node. */
export type WorkerChannelOperation =
	| "steer"
	| "permission_decision"
	| "spec"
	| "ledger_delta"
	| "admit"
	| "hook_result";

export class WorkerChannelFailure extends Error {
	readonly failureClass = "node-channel" as const;
	readonly operation: WorkerChannelOperation;
	constructor(operation: WorkerChannelOperation, detail: string) {
		super(`worker control channel failure during ${operation}: ${detail}`);
		this.name = "WorkerChannelFailure";
		this.operation = operation;
	}
}

/**
 * Retained bulk bytes at which display frames start to drop and, once evidence
 * alone reaches it, the bulk lane pauses. Two maximal frames, so one large tool
 * result never pauses the lane by itself.
 */
export const WORKER_EVENT_QUEUE_SOFT_BYTES = 2 * WORKER_BULK_FRAME_MAX_BYTES;
/**
 * Hard retention bound. The lane pauses at the soft level and parses nothing
 * while paused, so retention past it is at most the one frame that crossed
 * it; reaching the hard bound means pressure could not hold, and the run fails
 * as incomplete evidence instead of growing or dropping a fact silently.
 */
export const WORKER_EVENT_QUEUE_HARD_FRAMES = 2 * WORKER_EVENT_QUEUE_MAX_FRAMES;
export const WORKER_EVENT_QUEUE_HARD_BYTES = 4 * WORKER_BULK_FRAME_MAX_BYTES;
/**
 * Bulk output held before the attestation verdict. A protocol 2 worker emits
 * no bulk frame before its admit, so this only covers pipe reordering from a
 * nonconforming peer; one maximal frame and its newline fit, and a flood past
 * that is refused.
 */
export const WORKER_QUARANTINE_MAX_FRAMES = 256;
export const WORKER_QUARANTINE_MAX_BYTES = WORKER_BULK_FRAME_MAX_BYTES + 1;

export interface BoundedEventQueueLimits {
	/** Retained frames above which display frames drop and evidence applies pressure. */
	softFrames: number;
	/** Retained bytes above which display frames drop and evidence applies pressure. */
	softBytes: number;
	/** Retention a frame may never push the queue past. */
	hardFrames: number;
	hardBytes: number;
}

export interface BoundedEventQueueStats {
	/** Display-only frames dropped because the queue was at its ceiling. */
	droppedDisplayFrames: number;
	/** Highest observed queue depth, for capacity diagnostics. */
	peakDepth: number;
	/** Highest observed retained frame bytes, as measured on the wire. */
	peakBytes: number;
	/** Frames refused because admitting them would pass the hard bound. */
	overflowFrames: number;
}

/** `overflow` means the frame was not retained and the caller must fail the run. */
export type BoundedEventQueuePush = "queued" | "dropped" | "overflow";

export interface BoundedEventQueue {
	/** Enqueue one bulk frame of `bytes` wire bytes. */
	push(value: unknown, bytes?: number): BoundedEventQueuePush;
	shift(): unknown;
	/** Dequeue with the byte charge it was admitted under, for moving frames between queues. */
	take(): { value: unknown; bytes: number } | undefined;
	clear(): void;
	readonly size: number;
	readonly bytes: number;
	/** Evidence alone has reached the soft bound; the producer should stop. */
	readonly pressured: boolean;
	/** Retention has fallen to half the soft bound; a paused producer may resume. */
	readonly relieved: boolean;
	stats(): BoundedEventQueueStats;
}

interface QueuedFrame {
	value: unknown;
	bytes: number;
	evidence: boolean;
}

/**
 * Bounded orchestrator queue for the bulk lane. Above the soft bound the queue
 * drops the oldest display-only frame to admit a new one, and refuses a new
 * display frame when only evidence remains. A receipt-bearing frame is never
 * dropped: it is retained up to the hard bound, `pressured` tells the producer
 * to pause well before that, and a frame the hard bound refuses comes back as
 * `overflow` for the caller to fail the run. Frames live in a sequence-indexed
 * map, with a second index of display frames, so push, drop and dequeue never
 * move or scan the backlog.
 */
export function createBoundedEventQueue(
	maxFrames: number = WORKER_EVENT_QUEUE_MAX_FRAMES,
	limits: Partial<BoundedEventQueueLimits> = {},
): BoundedEventQueue {
	const softFrames = limits.softFrames ?? maxFrames;
	const softBytes = limits.softBytes ?? WORKER_EVENT_QUEUE_SOFT_BYTES;
	const hardFrames = limits.hardFrames ?? 2 * maxFrames;
	const hardBytes = limits.hardBytes ?? WORKER_EVENT_QUEUE_HARD_BYTES;
	const frames = new Map<number, QueuedFrame>();
	// Sequence numbers of retained display frames, oldest first. Entries whose
	// frame was already dequeued are skipped lazily when a drop looks for one.
	const displays = new Map<number, number>();
	let head = 0;
	let tail = 0;
	let displayHead = 0;
	let displayTail = 0;
	let retainedBytes = 0;
	let evidenceFrames = 0;
	let evidenceBytes = 0;
	let droppedDisplayFrames = 0;
	let peakDepth = 0;
	let peakBytes = 0;
	let overflowFrames = 0;

	function remove(seq: number): QueuedFrame | undefined {
		const frame = frames.get(seq);
		if (frame === undefined) return undefined;
		frames.delete(seq);
		retainedBytes -= frame.bytes;
		if (frame.evidence) {
			evidenceFrames -= 1;
			evidenceBytes -= frame.bytes;
		}
		return frame;
	}

	function dropOldestDisplay(): boolean {
		while (displayHead < displayTail) {
			const seq = displays.get(displayHead) as number;
			displays.delete(displayHead++);
			if (remove(seq) !== undefined) {
				droppedDisplayFrames += 1;
				return true;
			}
		}
		return false;
	}

	const overSoft = (bytes: number): boolean => frames.size >= softFrames || retainedBytes + bytes > softBytes;

	function take(): { value: unknown; bytes: number } | undefined {
		// Dropped display frames leave gaps; each gap is skipped once.
		while (head < tail) {
			const seq = head++;
			const frame = remove(seq);
			if (frame === undefined) continue;
			if (frames.size === 0) clear();
			else if (!frame.evidence) {
				// Every display older than this one is gone, so its index entries
				// go too; a backlog that never empties keeps the index bounded.
				while (displayHead < displayTail && (displays.get(displayHead) as number) <= seq) {
					displays.delete(displayHead++);
				}
			}
			return { value: frame.value, bytes: frame.bytes };
		}
		return undefined;
	}

	function clear(): void {
		frames.clear();
		displays.clear();
		head = tail = displayHead = displayTail = 0;
		retainedBytes = evidenceFrames = evidenceBytes = 0;
	}

	return {
		push(value: unknown, bytes = 0): BoundedEventQueuePush {
			const evidence = isReceiptBearingFrame(value);
			while (overSoft(bytes) && dropOldestDisplay()) {
				// Each pass removed one display frame; loop until under or none remain.
			}
			if (!evidence && overSoft(bytes)) {
				droppedDisplayFrames += 1;
				return "dropped";
			}
			if (frames.size + 1 > hardFrames || retainedBytes + bytes > hardBytes) {
				overflowFrames += 1;
				return "overflow";
			}
			const seq = tail++;
			frames.set(seq, { value, bytes, evidence });
			retainedBytes += bytes;
			if (evidence) {
				evidenceFrames += 1;
				evidenceBytes += bytes;
			} else {
				displays.set(displayTail++, seq);
			}
			peakDepth = Math.max(peakDepth, frames.size);
			peakBytes = Math.max(peakBytes, retainedBytes);
			return "queued";
		},
		shift(): unknown {
			return take()?.value;
		},
		take,
		clear,
		get size(): number {
			return frames.size;
		},
		get bytes(): number {
			return retainedBytes;
		},
		get pressured(): boolean {
			return evidenceFrames >= softFrames || evidenceBytes >= softBytes;
		},
		get relieved(): boolean {
			return frames.size <= softFrames / 2 && retainedBytes <= softBytes / 2;
		},
		stats(): BoundedEventQueueStats {
			return { droppedDisplayFrames, peakDepth, peakBytes, overflowFrames };
		},
	};
}
