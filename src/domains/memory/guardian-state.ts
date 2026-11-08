import type { TelemetryHub } from "../../core/telemetry/hub.js";
import type { MemoryContract } from "./contract.js";
import type { TaskMemoryGuardianState } from "./task-memory-status.js";

export interface GuardianStatePublisher {
	/**
	 * The one guardian state every surface projects: a boundary step the
	 * middleware launched counts as reviewing even though the guardian did not
	 * start it.
	 */
	current(): TaskMemoryGuardianState;
	/** Emit `memory.guardian_changed` when the projected state moved since the last emit. */
	publish(): void;
}

export function createGuardianStatePublisher(
	contract: Pick<MemoryContract, "guardianState" | "interventionStatus">,
	bus: Pick<TelemetryHub, "emit">,
	currentSessionId: () => string | null,
): GuardianStatePublisher {
	let publishedGuardianState: TaskMemoryGuardianState | null = null;
	const current = (): TaskMemoryGuardianState => {
		const state = contract.guardianState();
		return state !== "off" && contract.interventionStatus().stepInFlight ? "reviewing" : state;
	};
	return {
		current,
		publish: () => {
			const state = current();
			if (state === publishedGuardianState) return;
			publishedGuardianState = state;
			const sessionId = currentSessionId();
			bus.emit(
				"memory.guardian_changed",
				{ sessionId, state },
				sessionId ? { sessionId, agent: { role: "memory", id: sessionId } } : undefined,
			);
		},
	};
}
