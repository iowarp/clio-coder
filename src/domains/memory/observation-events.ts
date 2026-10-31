import { asSideAgent, telemetryContext } from "../../core/telemetry/context.js";
import { telemetryHub } from "../../core/telemetry/hub.js";
import { recordResearchTrace, researchTraceAdmits } from "../../core/telemetry/research-trace.js";
import type { MemoryObservationRecorded } from "../../core/telemetry/schemas.js";

export type MemoryObservationEvent = MemoryObservationRecorded["event"];

/** Structural observation decisions share the session or process journal (#434). */
export function observationEvent(
	event: MemoryObservationEvent,
	facts: Record<string, unknown>,
	sessionId?: string | null,
): void {
	const active = telemetryContext();
	const context =
		sessionId && active?.sessionId !== sessionId
			? { sessionId, agent: { role: "memory" as const, id: sessionId } }
			: active && asSideAgent(active, "memory");
	telemetryHub().emit("memory.observation_recorded", { event, facts }, context);
}

/** Ask before building content that consented research capture refuses (#434). */
export function observationTracing(): boolean {
	return researchTraceAdmits("memory.observed");
}

/** Raw observation content belongs only to consented research objects (#434). */
export function traceObservation(event: string, facts: Record<string, unknown>): void {
	if (researchTraceAdmits("memory.observed")) recordResearchTrace("memory.observed", { event }, { event, facts });
}
