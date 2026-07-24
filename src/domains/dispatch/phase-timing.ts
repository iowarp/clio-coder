import type { RunEnvelope, RunPhaseDurations, RunPhaseMarks } from "./types.js";

function duration(start: string | undefined, end: string | null | undefined): number | null {
	if (start === undefined || end == null) return null;
	const startMs = Date.parse(start);
	const endMs = Date.parse(end);
	return Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null;
}

/** Derive non-overlapping routing-system phases plus execution and total wall time. */
export function deriveRunPhaseDurations(
	marks: RunPhaseMarks | undefined,
	executionStartedAt: string,
	endedAt: string | null,
): RunPhaseDurations {
	const end = marks?.endedAt ?? endedAt;
	return {
		requestToDecisionMs: duration(marks?.requestedAt, marks?.decisionCompletedAt),
		decisionMs: duration(marks?.decisionStartedAt, marks?.decisionCompletedAt),
		admissionWaitMs: duration(marks?.decisionCompletedAt, marks?.queuedAt),
		queueWaitMs: duration(marks?.queuedAt, marks?.admittedAt),
		spawnSetupMs: duration(marks?.admittedAt, marks?.workerSpawnedAt),
		timeToFirstModelTokenMs: duration(marks?.requestedAt, marks?.firstModelTokenAt),
		timeToFirstToolMs: duration(marks?.requestedAt, marks?.firstToolAt),
		executionMs: duration(executionStartedAt, end),
		totalEndToEndMs: duration(marks?.requestedAt, end),
	};
}

export function deriveEnvelopePhaseDurations(envelope: RunEnvelope, endedAt = envelope.endedAt): RunPhaseDurations {
	return deriveRunPhaseDurations(envelope.timing, envelope.startedAt, endedAt);
}

/** Timing is observability metadata: a failed timing write must never fail run finalization. */
export function recordRunTimingBestEffort(update: () => void, onError?: (error: unknown) => void): boolean {
	try {
		update();
		return true;
	} catch (error) {
		onError?.(error);
		return false;
	}
}
