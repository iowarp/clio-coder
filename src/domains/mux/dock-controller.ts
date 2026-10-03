/**
 * Dock geometry and lifecycle: the managed tier of Clio-owned panes.
 *
 * A dock is a pane in a fixed position relative to Clio's anchor pane with a
 * target share of the anchor's axis, a minimum size in cells, and a managed
 * lifecycle. Three slots exist: `workers` to the right of the anchor, and
 * `files` and `music` below it. Ad-hoc utility panes are not docks and are never touched
 * here.
 *
 * The controller owns geometry only. Ownership stays in the pane registry,
 * error swallowing stays in the contract's `attempt` wrapper: every method
 * here that talks to the socket may throw a `MuxError`, and the contract is
 * the layer that turns that into a null/false answer.
 *
 * A dock can be hidden: `pane.move` carries the running pane into one parking
 * tab per Clio session and back, so the tool inside it (Yazi's directory,
 * cliamp's playback) survives. Hidden docks keep their slot, their remembered
 * share and their ownership; only `close` ends the process.
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

import type { MuxClient, MuxPaneMoveRequest, MuxPaneMoveResult } from "./socket-client.js";
import {
	MuxError,
	type MuxLayoutNode,
	type MuxLog,
	type MuxPane,
	type MuxPaneRef,
	type MuxRect,
	type MuxTabGeometry,
} from "./types.js";

/** The managed dock positions. */
export type DockSlot = "workers" | "files" | "music";

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
	// The workers dashboard reads at 40 columns (src/cli/fleet-board.ts sheds the
	// task, then the model, never the state or clock), which is half of an
	// 80-column terminal.
	workers: { slot: "workers", direction: "right", defaultShare: 0.34, minCells: 40 },
	files: { slot: "files", direction: "down", defaultShare: 0.3, minCells: 12 },
	// cliamp draws its spectrum only from 16 inner rows up (40x10 drops it), and
	// herdr's border takes two more. The tiny default share means the floor
	// always wins, so the pane is exactly as tall as the bars need.
	music: { slot: "music", direction: "down", defaultShare: 0.05, minCells: 18 },
};

/** Label of the tab hidden docks wait in, so the operator can tell whose panes they are. */
export const PARKING_TAB_LABEL = "clio parked";

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
	/** True while the pane waits in the parking tab: still running, out of the layout. */
	hidden: boolean;
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
): { path: ReadonlyArray<boolean>; dockIsSecond: boolean; direction: "right" | "down" } | null {
	const contains = (node: MuxLayoutNode, paneId: string): boolean => {
		if (node.type === "pane") return node.paneId === paneId;
		return contains(node.first, paneId) || contains(node.second, paneId);
	};
	const walk = (
		node: MuxLayoutNode,
		path: boolean[],
	): { path: boolean[]; dockIsSecond: boolean; direction: "right" | "down" } | null => {
		if (node.type !== "split") return null;
		const dockFirst = contains(node.first, dockPaneId);
		const dockSecond = contains(node.second, dockPaneId);
		const anchorFirst = contains(node.first, anchorPaneId);
		const anchorSecond = contains(node.second, anchorPaneId);
		if (dockFirst && anchorSecond) return { path, dockIsSecond: false, direction: node.direction };
		if (dockSecond && anchorFirst) return { path, dockIsSecond: true, direction: node.direction };
		if (dockFirst && anchorFirst) return walk(node.first, [...path, false]);
		if (dockSecond && anchorSecond) return walk(node.second, [...path, true]);
		return null;
	};
	return walk(root, []);
}

/** Whether `outer` contains `inner`, cell-inclusive. */
function containsRect(outer: MuxRect, inner: MuxRect): boolean {
	return (
		outer.x <= inner.x &&
		outer.y <= inner.y &&
		outer.x + outer.width >= inner.x + inner.width &&
		outer.y + outer.height >= inner.y + inner.height
	);
}

/**
 * The dock side's observed share at the split separating it from the anchor,
 * from live geometry. The separating split is the smallest split rect holding
 * both panes: split rects nest, so that is their lowest common ancestor. Its
 * live ratio is read directly rather than summing pane cells, because the
 * anchor's rect stops standing for its whole side the moment the user splits
 * it for something else, and a cell sum then misreads an untouched dock as a
 * resize. A separating split on the wrong axis measures nothing.
 */
export function observedDockShare(
	geometry: MuxTabGeometry,
	spec: DockSpec,
	anchorPaneId: string,
	dockPaneId: string,
): number | null {
	const anchor = geometry.panes.find((pane) => pane.paneId === anchorPaneId);
	const dock = geometry.panes.find((pane) => pane.paneId === dockPaneId);
	if (!anchor || !dock) return null;
	let separating: MuxTabGeometry["splits"][number] | null = null;
	for (const split of geometry.splits) {
		if (!containsRect(split.rect, anchor.rect) || !containsRect(split.rect, dock.rect)) continue;
		if (!separating || split.rect.width * split.rect.height < separating.rect.width * separating.rect.height) {
			separating = split;
		}
	}
	if (!separating || separating.direction !== spec.direction) return null;
	// On opposite sides of the divider, the second child always starts past the
	// first, so a coordinate compare says which side the dock holds.
	const dockIsSecond = spec.direction === "right" ? dock.rect.x > anchor.rect.x : dock.rect.y > anchor.rect.y;
	return dockIsSecond ? 1 - separating.ratio : separating.ratio;
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
	/**
	 * Leaves zoom on the anchor's tab. herdr refuses to move a pane into or out
	 * of a zoomed tab, and `pane.zoom off` focuses the pane it addresses, so it
	 * runs only after a move was refused for that reason, never ahead of one.
	 */
	leaveZoom?: () => Promise<void>;
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
		options?: {
			share?: number;
			cwd?: string;
			env?: Readonly<Record<string, string>>;
			/** Start the pane in the parking tab instead of beside the anchor, so boot never reshapes the layout. */
			hidden?: boolean;
			onRefused?: (reason: string) => void;
		},
	): Promise<MuxPaneRef | null>;
	/**
	 * Move a visible dock into the parking tab. The process keeps running. True
	 * when the dock is hidden afterwards (including when it already was); false
	 * when there is no such dock or the host declined.
	 */
	hide(slot: DockSlot): Promise<boolean>;
	/**
	 * Move a hidden dock back beside the anchor at its remembered share, without
	 * focusing it. Null when no such dock exists or the anchor is too small.
	 */
	show(slot: DockSlot, options?: { onRefused?: (reason: string) => void }): Promise<MuxPaneRef | null>;
	/** Record an adopted pane (crash recovery) as this slot's dock. */
	adopt(slot: DockSlot, ref: MuxPaneRef, options?: { hidden?: boolean }): void;
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
		// After a user move the separating split can run the other axis, and the
		// share would then set a height where minCells measures columns. Wrong-axis
		// geometry is declined, not silently applied.
		if (derived.direction !== DOCK_SPECS[state.slot].direction) {
			log("debug", `mux ${state.slot} dock split runs ${derived.direction}; declining the wrong-axis resize`);
			return false;
		}
		const ratio = derived.dockIsSecond ? ratioForDockShare(share) : share;
		await client.layoutSetSplitRatio({ tabId: state.tabId, path: derived.path, ratio });
		state.targetShare = share;
		state.lastAppliedShare = share;
		return true;
	};

	/**
	 * Everything that can create the parking tab runs in turn. Two docks born or
	 * hidden at once would each find no parking tab and make their own, and the
	 * operator would see one "clio parked" tab per dock.
	 */
	let parkingQueue: Promise<unknown> = Promise.resolve();
	const withParkingTab = <T>(task: () => Promise<T>): Promise<T> => {
		const run = parkingQueue.then(task, task);
		parkingQueue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	};

	/** One `pane.move`, retried once after leaving zoom when herdr refuses a zoomed tab. */
	const move = async (request: MuxPaneMoveRequest): Promise<MuxPaneMoveResult> => {
		const first = await client.paneMove(request);
		if (first.changed || first.reason !== "zoomed_tab" || !options.leaveZoom) return first;
		await options.leaveZoom();
		return client.paneMove(request);
	};

	/** Any hidden dock marks the parking tab; the tab itself disappears when its last pane leaves. */
	const parkingState = (): DockState | null => {
		for (const state of bySlot.values()) {
			if (state.hidden) return state;
		}
		return null;
	};

	/**
	 * A fresh dock born hidden: its pane is created in the parking tab, so the
	 * anchor is never split and Clio's own pane never resizes at boot.
	 */
	const openParked = (
		slot: DockSlot,
		spec: DockSpec,
		workspaceId: string,
		openOptions: { share?: number; cwd?: string; env?: Readonly<Record<string, string>> },
	): Promise<MuxPaneRef | null> =>
		withParkingTab(async () => {
			const spawn = {
				...(openOptions.cwd !== undefined ? { cwd: openOptions.cwd } : {}),
				...(openOptions.env ? { env: openOptions.env } : {}),
			};
			const createParkingTab = async (): Promise<MuxPane> =>
				(await client.tabCreate({ workspaceId, label: PARKING_TAB_LABEL, focus: false, ...spawn })).rootPane;
			const parking = parkingState();
			let pane: MuxPane;
			if (parking) {
				try {
					pane = await client.paneSplit({ direction: "down", targetPaneId: parking.paneId, focus: false, ...spawn });
				} catch (error) {
					if (!(error instanceof MuxError && error.kind === "not_found")) throw error;
					pane = await createParkingTab();
				}
			} else {
				pane = await createParkingTab();
			}
			const share = clampDockShare(openOptions.share ?? spec.defaultShare);
			bySlot.set(slot, {
				slot,
				paneId: pane.paneId,
				tabId: pane.tabId,
				targetShare: share,
				lastAppliedShare: share,
				hidden: true,
			});
			return { paneId: pane.paneId, tabId: pane.tabId, workspaceId: pane.workspaceId };
		});

	/**
	 * Ratio-at-split lands on the anchor's old rect; prior splits or a resize
	 * since the read can leave the dock under its floor. One converge pass fixes
	 * it; failure to converge is not failure to place.
	 */
	const converge = async (state: DockState, spec: DockSpec): Promise<void> => {
		try {
			const after = await client.paneLayout(anchorPaneId);
			const dockRect = after.panes.find((entry) => entry.paneId === state.paneId)?.rect;
			if (dockRect && axisCells(dockRect, spec) < spec.minCells) {
				const anchorAfter = after.panes.find((entry) => entry.paneId === anchorPaneId)?.rect;
				const total = anchorAfter ? axisCells(anchorAfter, spec) + axisCells(dockRect, spec) : 0;
				if (total > 0) await applyShare(state, Math.min(DOCK_MAX_SHARE, spec.minCells / total));
			}
		} catch (error) {
			log("debug", `mux ${state.slot} dock converge skipped: ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	const hideNow = async (slot: DockSlot): Promise<boolean> => {
		const state = bySlot.get(slot);
		if (!state) return false;
		if (state.hidden) return true;
		const parking = parkingState();
		let moved: MuxPaneMoveResult | null = null;
		if (parking) {
			try {
				moved = await move({
					paneId: state.paneId,
					destination: { type: "tab", tabId: parking.tabId, split: "down" },
				});
			} catch (error) {
				// The parking tab is gone (the operator closed it, taking its panes
				// with it); fall through to a fresh one.
				if (!(error instanceof MuxError && error.kind === "not_found")) throw error;
			}
		}
		moved ??= await move({
			paneId: state.paneId,
			destination: { type: "new_tab", label: PARKING_TAB_LABEL },
		});
		if (!moved.changed) {
			log("debug", `mux ${slot} dock was not hidden: ${moved.reason ?? "the pane host declined the move"}`);
			return false;
		}
		state.paneId = moved.pane.paneId;
		state.tabId = moved.pane.tabId;
		state.hidden = true;
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
			if (openOptions.hidden) return openParked(slot, spec, geometry.workspaceId, openOptions);
			const anchorRect = geometry.panes.find((pane) => pane.paneId === anchorPaneId)?.rect;
			if (!anchorRect) {
				openOptions.onRefused?.(`no anchor geometry for ${anchorPaneId}; check the pane host layout before trying again`);
				log("debug", `mux ${slot} dock open found no anchor rect for ${anchorPaneId}`);
				return null;
			}
			const plan = planDockOpen(anchorRect, spec, openOptions.share);
			if ("refused" in plan) {
				openOptions.onRefused?.(`${plan.refused}; enlarge the anchor pane before trying again`);
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
				hidden: false,
			};
			bySlot.set(slot, state);
			await converge(state, spec);
			return { paneId: pane.paneId, tabId: pane.tabId, workspaceId: pane.workspaceId };
		},

		hide(slot): Promise<boolean> {
			return withParkingTab(() => hideNow(slot));
		},

		async show(slot, showOptions = {}): Promise<MuxPaneRef | null> {
			const state = bySlot.get(slot);
			if (!state) return null;
			if (!state.hidden) return { paneId: state.paneId, tabId: state.tabId, workspaceId: "" };
			const spec = DOCK_SPECS[slot];
			const geometry = await client.paneLayout(anchorPaneId);
			const anchorRect = geometry.panes.find((pane) => pane.paneId === anchorPaneId)?.rect;
			if (!anchorRect) {
				showOptions.onRefused?.(`no anchor geometry for ${anchorPaneId}; check the pane host layout before trying again`);
				return null;
			}
			// The remembered share, not the default: a drag made before the dock was
			// hidden is the operator's decision and survives the round trip.
			const plan = planDockOpen(anchorRect, spec, state.targetShare);
			if ("refused" in plan) {
				showOptions.onRefused?.(`${plan.refused}; enlarge the anchor pane before trying again`);
				log("info", `mux ${slot} dock stays hidden: ${plan.refused}`);
				return null;
			}
			const moved = await move({
				paneId: state.paneId,
				destination: {
					type: "tab",
					tabId: geometry.tabId,
					split: plan.direction,
					targetPaneId: anchorPaneId,
					ratio: plan.ratio,
				},
			});
			if (!moved.changed && moved.reason !== "same_tab") {
				showOptions.onRefused?.(`the pane host did not move the ${slot} dock: ${moved.reason ?? "no reason given"}`);
				return null;
			}
			state.paneId = moved.pane.paneId;
			state.tabId = moved.pane.tabId;
			state.hidden = false;
			state.lastAppliedShare = plan.share;
			await converge(state, spec);
			return { paneId: moved.pane.paneId, tabId: moved.pane.tabId, workspaceId: moved.pane.workspaceId };
		},

		adopt(slot: DockSlot, ref: MuxPaneRef, adoptOptions = {}): void {
			const spec = DOCK_SPECS[slot];
			bySlot.set(slot, {
				slot,
				paneId: ref.paneId,
				tabId: ref.tabId,
				// The surviving pane's actual share is adopted lazily by the next
				// layout observation; until then the default is the best guess.
				targetShare: spec.defaultShare,
				lastAppliedShare: spec.defaultShare,
				hidden: adoptOptions.hidden === true,
			});
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
				// A hidden dock that lands anywhere but its parking tab was put back by
				// the operator; our own show/hide already wrote the tab it moved to.
				if (state.hidden && tabId !== state.tabId) state.hidden = false;
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
