import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { TaskMemoryStepUsage } from "../domains/memory/task-memory-policy.js";
import type { MemoryInterventionRegistration } from "../domains/middleware/memory-intervention.js";
import {
	type RecordBackgroundMemoryStepInput,
	recordBackgroundMemoryStep,
} from "../domains/observability/background-memory-usage.js";

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
	bus: SafeEventBus,
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
		bus.on(BusChannels.SessionParked, (payload) => {
			guarded(() => persistence?.save(payload.sessionId));
			memory.reset();
		}),
		bus.on(BusChannels.SessionResumed, (payload) => {
			memory.reset();
			// A branch switch reopens the same session at another point of its tree,
			// where the parked bank describes work that branch never did.
			if (payload.via === "resume") guarded(() => persistence?.restore(payload.sessionId));
			else guarded(() => persistence?.discard(payload.sessionId));
		}),
		bus.on(BusChannels.SessionTurnSwitched, (payload) => {
			memory.reset();
			guarded(() => persistence?.discard(payload.sessionId));
		}),
		bus.on(BusChannels.SessionEnd, () => memory.dispose()),
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
	const { observability, ...origin } = input;
	return (usage, isCurrent) => {
		recordBackgroundMemoryStep({ ...origin, usage, observability: isCurrent ? observability : undefined });
	};
}
