import { createSafeEventBus, type SafeEventBus } from "./event-bus.js";

let sharedBus: SafeEventBus | null = null;

export function getSharedBus(): SafeEventBus {
	if (!sharedBus) sharedBus = createSafeEventBus();
	return sharedBus;
}

export function resetSharedBus(): void {
	sharedBus?.clear();
	sharedBus = null;
}
