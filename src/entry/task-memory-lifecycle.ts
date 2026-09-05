import { BusChannels } from "../core/bus-events.js";
import type { SafeEventBus } from "../core/event-bus.js";
import type { TaskMemoryStepUsage } from "../domains/memory/task-memory-policy.js";
import type { MemoryInterventionRegistration } from "../domains/middleware/memory-intervention.js";
import {
	type RecordBackgroundMemoryStepInput,
	recordBackgroundMemoryStep,
} from "../domains/observability/background-memory-usage.js";

/** Explicit navigation owns memory lifetime; ordinary leaf advances and tree reads do not. */
export function bindTaskMemoryLifecycle(
	bus: SafeEventBus,
	memory: Pick<MemoryInterventionRegistration, "reset" | "dispose">,
): () => void {
	const unsubscribe = [
		bus.on(BusChannels.SessionParked, () => memory.reset()),
		bus.on(BusChannels.SessionResumed, () => memory.reset()),
		bus.on(BusChannels.SessionTurnSwitched, () => memory.reset()),
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
