import type { TelemetryHub } from "../core/telemetry/hub.js";
import type { TaskMemoryStepUsage } from "../domains/memory/task-memory-policy.js";
import type { MemoryInterventionRegistration } from "../domains/middleware/memory-intervention.js";
import {
	type RecordBackgroundMemoryStepInput,
	recordBackgroundMemoryStep,
} from "../domains/telemetry/background-memory-usage.js";

/** Saves the bank of a session being parked and hands it back when that session is resumed. */
export interface TaskMemoryBankPersistence {
	save(sessionId: string): void;
	/** Hands the snapshot back once and retires it, so only the next park can write a newer one. */
	restore(sessionId: string): void;
	/** The session moved to a point the snapshot does not describe. */
	discard(sessionId: string): void;
}

/** Explicit navigation owns memory lifetime; ordinary leaf advances and tree reads do not. */
export function bindTaskMemoryLifecycle(
	bus: TelemetryHub,
	memory: Pick<MemoryInterventionRegistration, "reset" | "dispose">,
	persistence?: TaskMemoryBankPersistence,
): () => void {
	const guarded = (action: () => void): void => {
		try {
			action();
		} catch {
			// A snapshot that cannot be written or read costs continuity, never the navigation.
		}
	};
	const unsubscribe = [
		bus.subscribe("session.parked", (payload) => {
			guarded(() => persistence?.save(payload.sessionId));
			memory.reset();
		}),
		bus.subscribe("session.reattached", (payload) => {
			memory.reset();
			// A branch switch reopens the same session at another point of its tree,
			// where the parked bank describes work that branch never did.
			if (payload.via === "resume") guarded(() => persistence?.restore(payload.sessionId));
			else guarded(() => persistence?.discard(payload.sessionId));
		}),
		bus.subscribe("session.turn_switched", (payload) => {
			memory.reset();
			guarded(() => persistence?.discard(payload.sessionId));
		}),
		bus.subscribe("session.ended", () => memory.dispose()),
	];
	return () => {
		memory.dispose();
		for (const off of unsubscribe) off();
	};
}

/** The durable row keeps launch identity even when the live cost tracker has moved on. */
export function captureTaskMemoryUsage(
	input: Omit<RecordBackgroundMemoryStepInput, "usage">,
): (usage: TaskMemoryStepUsage, isCurrent: boolean) => void {
	const { telemetry, ...origin } = input;
	return (usage, isCurrent) => {
		if (usage.callId) return;
		recordBackgroundMemoryStep({ ...origin, usage, telemetry: isCurrent ? telemetry : undefined });
	};
}
