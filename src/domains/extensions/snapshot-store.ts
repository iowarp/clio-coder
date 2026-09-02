import type { ExtensionSnapshot } from "./types.js";

export interface ExtensionSnapshotStore {
	current(): ExtensionSnapshot | null;
	/** Refuses a generation at or below the committed generation. */
	commit(snapshot: ExtensionSnapshot): boolean;
	/** Reserve and return the next process-local generation. Reservations are never reused. */
	nextGeneration(): number;
}

export function createExtensionSnapshotStore(): ExtensionSnapshotStore {
	let committed: ExtensionSnapshot | null = null;
	let reservedGeneration = 0;
	return {
		current: () => committed,
		commit(snapshot) {
			if (snapshot.generation <= (committed?.generation ?? 0)) return false;
			committed = snapshot;
			reservedGeneration = Math.max(reservedGeneration, snapshot.generation);
			return true;
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
