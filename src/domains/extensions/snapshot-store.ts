import type { ExtensionSnapshot } from "./types.js";

/**
 * Holder for the committed snapshot reference plus the process-local
 * generation counter. `publish` is assignment-only: validation that a
 * snapshot is strictly newer belongs to the candidate that prepared it, on
 * the same stack, immediately before publishing.
 */
export interface ExtensionSnapshotStore {
	current(): ExtensionSnapshot | null;
	publish(snapshot: ExtensionSnapshot): void;
	/** Reserve and return the next process-local generation. Reservations are never reused. */
	nextGeneration(): number;
}

export function createExtensionSnapshotStore(): ExtensionSnapshotStore {
	let committed: ExtensionSnapshot | null = null;
	let reservedGeneration = 0;
	return {
		current: () => committed,
		publish(snapshot) {
			committed = snapshot;
		},
		nextGeneration() {
			reservedGeneration += 1;
			return reservedGeneration;
		},
	};
}

let boundStore: ExtensionSnapshotStore | null = null;

export function committedExtensionSnapshot(): ExtensionSnapshot | null {
	return boundStore?.current() ?? null;
}

export function bindExtensionSnapshotStore(store: ExtensionSnapshotStore | null): void {
	boundStore = store;
}
