/**
 * Dock geometry and lifecycle: the managed tier of Clio-owned panes.
 *
 * A dock is a pane in a fixed position relative to Clio's anchor pane with a
 * target share of the anchor's axis, a minimum size in cells, and a managed
 * lifecycle. Two slots exist: `workers` to the right of the anchor and
 * `files` below it. Ad-hoc utility panes are not docks and are never touched
 * here.
 *
 * The controller owns geometry only. Ownership stays in the pane registry,
 * error swallowing stays in the contract's `attempt` wrapper: every method
 * here that talks to the socket may throw a `MuxError`, and the contract is
 * the layer that turns that into a null/false answer.
 *
 * Three rules run through the reconciliation logic:
 *
 *   1. A user action is a decision. A resize observed via `layout.updated`
 *      that does not match what Clio last applied becomes the new target; a
 *      closed dock stays closed; a moved dock is followed to its new id.
 *   2. Clio's own corrections must not read as user actions. Every applied
 *      share is remembered and an observation matching it (or the target)
 *      within {@link SHARE_EPSILON} is a no-op.
 *   3. Opening never steals focus. Focus and zoom live on the contract and
 *      only ever run on explicit request.
 */

import type { MuxClient } from "./socket-client.js";
import type { MuxLayoutNode, MuxLog, MuxPaneRef, MuxTabGeometry } from "./types.js";

/** The two managed dock positions. */
export type DockSlot = "workers" | "files";

export interface DockSpec {
	slot: DockSlot;
	direction: "right" | "down";
	/** Default share of the anchor's axis the dock takes when none is configured. */
	defaultShare: number;
	/** Floor in cells (columns for `right`, rows for `down`) below which a dock is useless. */
	minCells: number;
}

/**
 * Fixed per slot rather than heuristic: the workers viewer wants columns, the
 * file pane wants rows, and a dock that wanders per terminal width would make
 * the layout feel like weather.
 */
export const DOCK_SPECS: Readonly<Record<DockSlot, DockSpec>> = {
	workers: { slot: "workers", direction: "right", defaultShare: 0.34, minCells: 48 },
	files: { slot: "files", direction: "down", defaultShare: 0.3, minCells: 12 },
};

/** A dock may never take more than half the axis, whatever the share asks. */
export const DOCK_MAX_SHARE = 0.5;
/** Observed-vs-applied share differences below this are rounding, not a user drag. */
export const SHARE_EPSILON = 0.02;

export interface DockState {
	slot: DockSlot;
	paneId: string;
	tabId: string;
	/** Share of the axis the dock should hold; user resizes overwrite it. */
	targetShare: number;
	/** What Clio last set, so its own correction is not adopted as a user drag. */
	lastAppliedShare: number;
}

/** Wire ratio for a split where the dock is the `second` child: the anchor keeps the rest. */
export function ratioForDockShare(share: number): number {
	return 1 - share;
}

/** Clamps a requested share into (0, DOCK_MAX_SHARE]. */
export function clampDockShare(share: number): number {
	if (!Number.isFinite(share) || share <= 0) return DOCK_SPECS.workers.defaultShare;
	return Math.min(DOCK_MAX_SHARE, share);
}

/** The axis length in cells a spec's direction measures on a rect. */
function axisCells(rect: { width: number; height: number }, spec: DockSpec): number {
	return spec.direction === "right" ? rect.width : rect.height;
}

/**
 * Boolean path from the root to the split separating `anchorPaneId` from
 * `dockPaneId`, plus which side the dock sits on. Null when the tree does not
 * hold such a split, which is how a stale path is detected after user moves.
 */
export function deriveSplitPath(
	root: MuxLayoutNode,
	anchorPaneId: string,
	dockPaneId: string,
): { path: ReadonlyArray<boolean>; dockIsSecond: boolean } | null {
	const contains = (node: MuxLayoutNode, paneId: string): boolean => {
		if (node.type === "pane") return node.paneId === paneId;
		return contains(node.first, paneId) || contains(node.second, paneId);
	};
	const walk = (node: MuxLayoutNode, path: boolean[]): { path: boolean[]; dockIsSecond: boolean } | null => {
		if (node.type !== "split") return null;
		const dockFirst = contains(node.first, dockPaneId);
		const dockSecond = contains(node.second, dockPaneId);
		const anchorFirst = contains(node.first, anchorPaneId);
		const anchorSecond = contains(node.second, anchorPaneId);
		if (dockFirst && anchorSecond) return { path, dockIsSecond: false };
		if (dockSecond && anchorFirst) return { path, dockIsSecond: true };
		if (dockFirst && anchorFirst) return walk(node.first, [...path, false]);
		if (dockSecond && anchorSecond) return walk(node.second, [...path, true]);
		return null;
	};
	return walk(root, []);
}

/** The dock's observed share of the anchor+dock pair on the spec's axis, from live geometry. */
export function observedDockShare(
	geometry: MuxTabGeometry,
	spec: DockSpec,
	anchorPaneId: string,
	dockPaneId: string,
): number | null {
	const anchor = geometry.panes.find((pane) => pane.paneId === anchorPaneId);
	const dock = geometry.panes.find((pane) => pane.paneId === dockPaneId);
	if (!anchor || !dock) return null;
	const total = axisCells(anchor.rect, spec) + axisCells(dock.rect, spec);
	if (total <= 0) return null;
	return axisCells(dock.rect, spec) / total;
}

export interface DockOpenPlan {
	direction: "right" | "down";
	/** Wire ratio for `pane.split`: the share the anchor keeps. */
	ratio: number;
	share: number;
}

/**
 * Decides whether a dock fits beside the anchor and with what split ratio,
 * from the anchor's current rect. Refusal happens here, before any split
 * reaches the wire, so a too-small terminal never flashes a sliver pane.
 */
export function planDockOpen(
	anchorRect: { width: number; height: number },
	spec: DockSpec,
	requestedShare?: number,
): DockOpenPlan | { refused: string } {
	const axis = axisCells(anchorRect, spec);
	if (axis * DOCK_MAX_SHARE < spec.minCells) {
		return {
			refused: `the ${spec.slot} dock needs ${spec.minCells} cells and at most half of ${axis} is available`,
		};
	}
	const share = Math.max(clampDockShare(requestedShare ?? spec.defaultShare), spec.minCells / axis);
	return { direction: spec.direction, ratio: ratioForDockShare(share), share };
}

export interface DockControllerOptions {
	client: MuxClient;
	anchorPaneId: string;
	log?: MuxLog;
}

export interface DockController {
	/** Live dock states, for status output. */
	states(): ReadonlyArray<DockState>;
	stateFor(slot: DockSlot): DockState | null;
	/**
	 * Splits the anchor for a dock and converges it to its cell floor. Returns
	 * the new pane, or null when the anchor is too small. Throws MuxError on
	 * wire failure; the contract's attempt wrapper owns that.
	 */
	open(
		slot: DockSlot,
		options?: { share?: number; cwd?: string; env?: Readonly<Record<string, string>> },
	): Promise<MuxPaneRef | null>;
	/** Record an adopted pane (crash recovery) as this slot's dock. */
	adopt(slot: DockSlot, ref: MuxPaneRef): void;
	/** Set a dock's share explicitly, as `/panes` resize does. */
	resize(slot: DockSlot, share: number): Promise<boolean>;
	/** Feed a `layout.updated` push; user resizes become the new target. */
	noteLayoutUpdated(geometry: MuxTabGeometry): void;
	/** Feed a pane departure; a closed dock is a decision, not a fault. */
	notePaneGone(paneId: string): void;
	/** Feed a `pane.moved` id rewrite; the dock is followed to its new id. */
	notePaneMoved(previousPaneId: string, paneId: string, tabId: string): void;
	/** Pane ids of every live dock, for the contract's clean-exit sweep. */
	paneIds(): ReadonlyArray<string>;
	clear(): void;
}

export function createDockController(options: DockControllerOptions): DockController {
	const { client, anchorPaneId } = options;
	const log = options.log ?? ((): void => undefined);
	const bySlot = new Map<DockSlot, DockState>();

	/**
	 * Re-derives the split path from a fresh export and applies a ratio for the
	 * dock's share. The path is never cached: user splits and moves invalidate
	 * it silently, and one export per resize is cheap.
	 */
	const applyShare = async (state: DockState, share: number): Promise<boolean> => {
		const tree = await client.layoutExport({ tabId: state.tabId });
		const derived = deriveSplitPath(tree.root, anchorPaneId, state.paneId);
		if (!derived) {
			log("debug", `mux ${state.slot} dock split path is gone from ${state.tabId}; leaving layout alone`);
			return false;
		}
		const ratio = derived.dockIsSecond ? ratioForDockShare(share) : share;
		await client.layoutSetSplitRatio({ tabId: state.tabId, path: derived.path, ratio });
		state.targetShare = share;
		state.lastAppliedShare = share;
		return true;
	};

	return {
		states(): ReadonlyArray<DockState> {
			return [...bySlot.values()].map((state) => ({ ...state }));
		},

		stateFor(slot: DockSlot): DockState | null {
			const state = bySlot.get(slot);
			return state ? { ...state } : null;
		},

		async open(slot, openOptions = {}): Promise<MuxPaneRef | null> {
			const existing = bySlot.get(slot);
			if (existing) {
				return { paneId: existing.paneId, tabId: existing.tabId, workspaceId: "" };
			}
			const spec = DOCK_SPECS[slot];
			const geometry = await client.paneLayout(anchorPaneId);
			const anchorRect = geometry.panes.find((pane) => pane.paneId === anchorPaneId)?.rect;
			if (!anchorRect) {
				log("debug", `mux ${slot} dock open found no anchor rect for ${anchorPaneId}`);
				return null;
			}
			const plan = planDockOpen(anchorRect, spec, openOptions.share);
			if ("refused" in plan) {
				log("info", `mux ${slot} dock refused: ${plan.refused}`);
				return null;
			}
			const pane = await client.paneSplit({
				direction: plan.direction,
				targetPaneId: anchorPaneId,
				ratio: plan.ratio,
				focus: false,
				...(openOptions.cwd !== undefined ? { cwd: openOptions.cwd } : {}),
				...(openOptions.env ? { env: openOptions.env } : {}),
			});
			const state: DockState = {
				slot,
				paneId: pane.paneId,
				tabId: pane.tabId,
				targetShare: plan.share,
				lastAppliedShare: plan.share,
			};
			bySlot.set(slot, state);
			// Ratio-at-split lands on the anchor's old rect; prior splits or a
			// resize since the read can leave the dock under its floor. One
			// converge pass fixes it; failure to converge is not failure to open.
			try {
				const after = await client.paneLayout(anchorPaneId);
				const dockRect = after.panes.find((entry) => entry.paneId === pane.paneId)?.rect;
				if (dockRect && axisCells(dockRect, spec) < spec.minCells) {
					const anchorAfter = after.panes.find((entry) => entry.paneId === anchorPaneId)?.rect;
					const total = anchorAfter ? axisCells(anchorAfter, spec) + axisCells(dockRect, spec) : 0;
					if (total > 0) await applyShare(state, Math.min(DOCK_MAX_SHARE, spec.minCells / total));
				}
			} catch (error) {
				log("debug", `mux ${slot} dock converge skipped: ${error instanceof Error ? error.message : String(error)}`);
			}
			return { paneId: pane.paneId, tabId: pane.tabId, workspaceId: pane.workspaceId };
		},

		adopt(slot: DockSlot, ref: MuxPaneRef): void {
			const spec = DOCK_SPECS[slot];
			bySlot.set(slot, {
				slot,
				paneId: ref.paneId,
				tabId: ref.tabId,
				// The surviving pane's actual share is adopted lazily by the next
				// layout observation; until then the default is the best guess.
				targetShare: spec.defaultShare,
				lastAppliedShare: spec.defaultShare,
			});
		},

		async resize(slot: DockSlot, share: number): Promise<boolean> {
			const state = bySlot.get(slot);
			if (!state) return false;
			return await applyShare(state, Math.max(clampDockShare(share), 0.01));
		},

		noteLayoutUpdated(geometry: MuxTabGeometry): void {
			for (const state of bySlot.values()) {
				if (state.tabId !== geometry.tabId) continue;
				const observed = observedDockShare(geometry, DOCK_SPECS[state.slot], anchorPaneId, state.paneId);
				if (observed === null) continue;
				if (Math.abs(observed - state.targetShare) <= SHARE_EPSILON) continue;
				if (Math.abs(observed - state.lastAppliedShare) <= SHARE_EPSILON) continue;
				// The user dragged the divider. Their ratio is the target now, and a
				// later terminal resize must not fight them back to the old one.
				log("debug", `mux ${state.slot} dock resized by the user to ${(observed * 100).toFixed(0)}%`);
				state.targetShare = observed;
				state.lastAppliedShare = observed;
			}
		},

		notePaneGone(paneId: string): void {
			for (const [slot, state] of bySlot) {
				if (state.paneId === paneId) bySlot.delete(slot);
			}
		},

		notePaneMoved(previousPaneId: string, paneId: string, tabId: string): void {
			for (const state of bySlot.values()) {
				if (state.paneId !== previousPaneId) continue;
				state.paneId = paneId;
				state.tabId = tabId;
			}
		},

		paneIds(): ReadonlyArray<string> {
			return [...bySlot.values()].map((state) => state.paneId);
		},

		clear(): void {
			bySlot.clear();
		},
	};
}
