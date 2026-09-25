import { rawDurationMs } from "../../core/timers.js";
import type { RunEnvelope, RunPhaseDurations, RunPhaseMarks } from "./types.js";

function duration(start: string | undefined, end: string | null | undefined): number | null {
	if (start === undefined || end == null) return null;
	const startMs = Date.parse(start);
	const endMs = Date.parse(end);
	// The clamp is the presentation contract (no negative phase renders), but
	// the subtraction goes through rawDurationMs so a backwards mark is counted
	// instead of silently reading as an unusually fast phase.
	return Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, rawDurationMs(startMs, endMs)) : null;
}

/** Derive the queue wait and the user-observed end-to-end time from a run's phase marks. */
function deriveRunPhaseDurations(marks: RunPhaseMarks | undefined, endedAt: string | null): RunPhaseDurations {
	return {
		queueWaitMs: duration(marks?.queuedAt, marks?.admittedAt),
		totalEndToEndMs: duration(marks?.requestedAt, marks?.endedAt ?? endedAt),
	};
}

export function deriveEnvelopePhaseDurations(envelope: RunEnvelope, endedAt = envelope.endedAt): RunPhaseDurations {
	return deriveRunPhaseDurations(envelope.timing, endedAt);
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
