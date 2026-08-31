/**
 * The set of panes Clio created, and the only panes Clio will ever act on.
 *
 * The ownership rule forbids closing, renaming, reporting state on, or sending
 * input to a pane Clio did not create, so every mutating path in `contract.ts`
 * asks this registry first. `pane.closed` and `pane.exited` events feed
 * `forget`, and a post-reconnect `session.snapshot` feeds `reconcile`, so a
 * pane the user closed behind Clio's back stops being in the inventory either
 * way.
 */

import type { MuxPanePurpose, MuxPaneRecord, MuxPaneRef } from "./types.js";

export interface MuxPaneRegistry {
	/** Record a pane Clio just created. Replaces any record with the same pane id. */
	record(entry: MuxPaneRecord): void;
	byPaneId(paneId: string): MuxPaneRecord | null;
	/** Newest pane of one purpose, e.g. the watch pane. */
	byPurpose(purpose: MuxPanePurpose): MuxPaneRecord | null;
	/** Whether Clio created this pane, and therefore may act on it. */
	owns(paneId: string): boolean;
	/** Drop one pane; returns the dropped record so callers can log what went. */
	forget(paneId: string): MuxPaneRecord | null;
	/**
	 * Drop every record whose pane is absent from `livePaneIds`. Returns the
	 * dropped records, oldest first.
	 */
	reconcile(livePaneIds: Iterable<string>): ReadonlyArray<MuxPaneRecord>;
	list(): ReadonlyArray<MuxPaneRecord>;
	clear(): void;
}

export function createPaneRegistry(): MuxPaneRegistry {
	// Insertion-ordered, which is what makes `list()` read oldest-pane-first.
	const byPane = new Map<string, MuxPaneRecord>();

	return {
		record(entry: MuxPaneRecord): void {
			byPane.set(entry.ref.paneId, entry);
		},
		byPaneId(paneId: string): MuxPaneRecord | null {
			return byPane.get(paneId) ?? null;
		},
		byPurpose(purpose: MuxPanePurpose): MuxPaneRecord | null {
			let newest: MuxPaneRecord | null = null;
			for (const entry of byPane.values()) {
				if (entry.purpose === purpose) newest = entry;
			}
			return newest;
		},
		owns(paneId: string): boolean {
			return byPane.has(paneId);
		},
		forget(paneId: string): MuxPaneRecord | null {
			const entry = byPane.get(paneId);
			if (!entry) return null;
			byPane.delete(paneId);
			return entry;
		},
		reconcile(livePaneIds: Iterable<string>): ReadonlyArray<MuxPaneRecord> {
			const live = new Set(livePaneIds);
			const dropped: MuxPaneRecord[] = [];
			for (const [paneId, entry] of byPane) {
				if (!live.has(paneId)) dropped.push(entry);
			}
			for (const entry of dropped) byPane.delete(entry.ref.paneId);
			return dropped;
		},
		list(): ReadonlyArray<MuxPaneRecord> {
			return [...byPane.values()];
		},
		clear(): void {
			byPane.clear();
		},
	};
}

/** Convenience for building a registry entry from a freshly created pane. */
export function paneRecord(
	ref: MuxPaneRef,
	fields: { purpose: MuxPanePurpose; label: string; openedAt: number; adopted?: boolean },
): MuxPaneRecord {
	return {
		ref,
		purpose: fields.purpose,
		label: fields.label,
		openedAt: fields.openedAt,
		...(fields.adopted === true ? { adopted: true } : {}),
	};
}
