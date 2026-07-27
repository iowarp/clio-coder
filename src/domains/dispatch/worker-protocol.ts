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
import {
	canonicalJson,
	endpointIdentityHash,
	isReceiptBearingFrame,
	WORKER_EVENT_QUEUE_MAX_FRAMES,
	WORKER_PROTOCOL_VERSION,
	type WorkerAttestation,
	type WorkerResourceValue,
} from "../../worker/protocol.js";
import type { RunReceiptAttestation } from "./types.js";

export type {
	WorkerAttestation,
	WorkerControlFrame,
	WorkerResourceFacts,
	WorkerResourceValue,
} from "../../worker/protocol.js";
export {
	CONTROL_FRAME_PREFIX,
	encodeControlFrame,
	endpointIdentityHash,
	isControlLine,
	isReceiptBearingFrame,
	parseBulkFrame,
	parseControlFrame,
	toolSignatureOf,
	WORKER_BULK_FRAME_MAX_BYTES,
	WORKER_CONTROL_FRAME_MAX_BYTES,
	WORKER_EVENT_QUEUE_MAX_FRAMES,
	WORKER_PROTOCOL_VERSION,
	WORKER_STDIN_FRAME_MAX_BYTES,
	WORKER_STDIN_QUEUE_MAX_BYTES,
	withinFrameBudget,
	workerSpecDigest,
} from "../../worker/protocol.js";

/**
 * Fingerprint of the immutable settings snapshot a dispatch was admitted
 * under. The whole document enters the digest: any setting that can change a
 * route, an authority, or a tool surface must invalidate an in-flight worker,
 * and enumerating a subset would silently exempt whatever was forgotten.
 */
export function computeSettingsFingerprint(settings: unknown): string {
	return createHash("sha256")
		.update(`clio.settings:${canonicalJson(settings)}`, "utf8")
		.digest("hex");
}

/** Route and node identity the orchestrator approved before the spawn. */
export interface ApprovedWorkerIdentity {
	specVersion: number;
	settingsFingerprint: string;
	specDigest: string;
	runtimeId: string;
	targetId: string;
	endpointIdentityHash: string;
	wireModelId: string;
}

export type AttestationVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Admit an attested worker only when every identity field equals the approved
 * plan. This is a full-field comparison rather than a spot check: a worker
 * that resolved a different endpoint, model, runtime, or tool surface than the
 * plan approved must not reach a model, whatever else it announced correctly.
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
}): ApprovedWorkerIdentity {
	return {
		specVersion: spec.specVersion,
		settingsFingerprint: spec.settingsFingerprint,
		specDigest: workerSpecDigestOf(spec),
		runtimeId: spec.runtimeId,
		targetId: spec.target.id,
		endpointIdentityHash: endpointIdentityHash(spec.target.url),
		wireModelId: spec.wireModelId,
	};
}

function workerSpecDigestOf(spec: unknown): string {
	return createHash("sha256")
		.update(`clio.workerSpec:${canonicalJson(spec)}`, "utf8")
		.digest("hex");
}

function resourceOrNull(value: WorkerResourceValue<number>): number | null {
	return value.known ? value.value : null;
}

/**
 * Project an attestation into the bounded shape a receipt seals. Returns an
 * empty object when nothing was attested, so a caller can spread it into a
 * receipt draft without branching.
 */
export function receiptAttestationFields(
	attestation: WorkerAttestation | null,
): { attestation: RunReceiptAttestation } | Record<string, never> {
	if (attestation === null) return {};
	return {
		attestation: {
			protocolVersion: attestation.protocolVersion,
			host: attestation.host,
			pid: attestation.pid,
			processGroupId: attestation.processGroupId,
			settingsFingerprint: attestation.settingsFingerprint,
			specDigest: attestation.specDigest,
			targetId: attestation.targetId,
			endpointIdentityHash: attestation.endpointIdentityHash,
			wireModelId: attestation.wireModelId,
			runtimeId: attestation.runtimeId,
			toolSignature: attestation.toolSignature,
			resources: {
				labels: [...attestation.resources.labels],
				cpuCount: resourceOrNull(attestation.resources.cpuCount),
				totalMemoryBytes: resourceOrNull(attestation.resources.totalMemoryBytes),
				gpuCount: resourceOrNull(attestation.resources.gpuCount),
				vramBytes: resourceOrNull(attestation.resources.vramBytes),
			},
		},
	};
}

/**
 * A control write that could not reach the worker. Reported as a typed channel
 * failure so failure classification routes it to the node dimension instead of
 * blaming the target or the model.
 */
export class WorkerChannelFailure extends Error {
	readonly failureClass = "node-channel" as const;
	readonly operation: "steer" | "permission_decision" | "spec";
	constructor(operation: "steer" | "permission_decision" | "spec", detail: string) {
		super(`worker control channel failure during ${operation}: ${detail}`);
		this.name = "WorkerChannelFailure";
		this.operation = operation;
	}
}

export interface BoundedEventQueueStats {
	/** Display-only frames dropped because the queue was at its ceiling. */
	droppedDisplayFrames: number;
	/** Highest observed queue depth, for capacity diagnostics. */
	peakDepth: number;
}

export interface BoundedEventQueue {
	/** Enqueue one bulk frame. Returns false when a display frame was dropped. */
	push(value: unknown): boolean;
	shift(): unknown;
	readonly size: number;
	stats(): BoundedEventQueueStats;
}

/**
 * Bounded orchestrator queue for the bulk lane. At the ceiling the queue drops
 * the oldest display-only frame to admit the new one; a receipt-bearing frame
 * is never dropped, and when the queue holds nothing but evidence it grows no
 * further and refuses the new display frame instead. Memory is bounded either
 * way, and no protocol fact a receipt must seal is ever lost to backpressure.
 */
export function createBoundedEventQueue(maxFrames: number = WORKER_EVENT_QUEUE_MAX_FRAMES): BoundedEventQueue {
	const items: unknown[] = [];
	let droppedDisplayFrames = 0;
	let peakDepth = 0;

	function dropOneDisplayFrame(): boolean {
		for (let index = 0; index < items.length; index += 1) {
			if (!isReceiptBearingFrame(items[index])) {
				items.splice(index, 1);
				droppedDisplayFrames += 1;
				return true;
			}
		}
		return false;
	}

	return {
		push(value: unknown): boolean {
			if (items.length >= maxFrames && !dropOneDisplayFrame()) {
				if (isReceiptBearingFrame(value)) {
					// Evidence outranks the ceiling: an all-evidence queue accepts the
					// frame rather than losing a fact the receipt must carry.
					items.push(value);
					peakDepth = Math.max(peakDepth, items.length);
					return true;
				}
				droppedDisplayFrames += 1;
				return false;
			}
			items.push(value);
			peakDepth = Math.max(peakDepth, items.length);
			return true;
		},
		shift(): unknown {
			return items.shift();
		},
		get size(): number {
			return items.length;
		},
		stats(): BoundedEventQueueStats {
			return { droppedDisplayFrames, peakDepth };
		},
	};
}
