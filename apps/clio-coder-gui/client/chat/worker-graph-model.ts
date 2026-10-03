import type { FleetItem } from "../../contracts/fleet-events.js";
import { formatTime } from "../api/clock.js";
import { FLEET_STATE_LABELS, type FleetRun, fleetRunDetail, foldFleetRuns, isLiveRun } from "./fleet-facts.js";

export interface WorkerNode {
	run: FleetRun;
	parentRunId: string | null;
	/** An upstream parent that has left the bounded feed remains explicitly named. */
	missingParent: string | null;
}

/** Only the runtime's worker:<runId> origin establishes a worker-to-worker edge. */
export function workerGraph(items: readonly FleetItem[]) {
	const runs = foldFleetRuns(items);
	const parents = new Map<string, string>();
	for (const item of [...items].sort((a, b) => a.sourceSequence - b.sourceSequence)) {
		if (item.fact.type !== "fleet.enqueued" && item.fact.type !== "fleet.started") continue;
		const { runId, origin } = item.fact.payload;
		if (origin?.startsWith("worker:") && origin.length > 7) parents.set(runId, origin.slice(7));
	}
	const known = new Set(runs.map((run) => run.runId));
	const nodes: WorkerNode[] = runs.map((run) => {
		const parent = parents.get(run.runId) ?? null;
		let cursor: string | undefined = parent ?? undefined;
		const visited = new Set([run.runId]);
		while (cursor && known.has(cursor) && !visited.has(cursor)) {
			visited.add(cursor);
			cursor = parents.get(cursor);
		}
		// A malformed cyclic origin must not create an infinitely nested graph.
		const cyclic = cursor !== undefined && visited.has(cursor);
		return {
			run,
			parentRunId: cyclic ? null : parent,
			missingParent: parent && !known.has(parent) ? parent : null,
		};
	});
	const ordered: WorkerNode[] = [];
	const emitted = new Set<string>();
	const emit = (node: WorkerNode) => {
		if (emitted.has(node.run.runId)) return;
		emitted.add(node.run.runId);
		ordered.push(node);
		for (const child of nodes) if (child.parentRunId === node.run.runId) emit(child);
	};
	for (const node of nodes) if (node.parentRunId === null || node.missingParent !== null) emit(node);
	for (const node of nodes) emit(node);
	return {
		nodes: ordered,
		active: runs.filter(isLiveRun).length,
		completed: runs.filter((run) => run.state === "done").length,
		failed: runs.filter((run) => run.state === "failed").length,
	};
}

/**
 * The reported fragments after the state word, for a row whose state mark already says the state.
 * Null when the run has reported nothing beyond its state.
 */
export function runFacts(run: FleetRun): string | null {
	const rest = fleetRunDetail(run).slice(FLEET_STATE_LABELS[run.state].length + " · ".length);
	return rest.length > 0 ? rest : null;
}

/** The dispatch ledger keys a run by the same id the fleet feed reports, so the record page takes it. */
export const dispatchRecordPath = (runId: string): string => `/fleet/dispatches/${encodeURIComponent(runId)}`;

/** A notice belongs to this task, so its row keeps the clock and leaves the full stamp to a tooltip. */
export function noticeClock(at: string): { short: string; full: string } {
	const full = formatTime(at);
	const short = full.split(" ")[1];
	return { short: short !== undefined && /^\d\d:\d\d/.test(short) ? short : full, full };
}

export interface TreeGuide {
	/** Shallower levels whose line passes this row on its way to a later sibling. */
	readonly through: readonly number[];
	/** The row's own level continues below it to a later sibling. */
	readonly continues: boolean;
	/** The next row is this row's child, so a line starts under it. */
	readonly opens: boolean;
}

/**
 * The guide lines of an indented tree, from the depths of its rows in display order. A level's line
 * continues past a row when the next row at that level or shallower sits at exactly that level.
 * Depths are taken as given, so a filtered list whose parent is hidden still draws a connected tree.
 */
export function treeGuides(depths: readonly number[]): TreeGuide[] {
	const continuesAt = (index: number, level: number): boolean => {
		for (let next = index + 1; next < depths.length; next++) {
			const depth = depths[next] ?? 0;
			if (depth <= level) return depth === level;
		}
		return false;
	};
	return depths.map((depth, index) => {
		const through: number[] = [];
		for (let level = 0; level < depth; level++) if (continuesAt(index, level)) through.push(level);
		return { through, continues: continuesAt(index, depth), opens: (depths[index + 1] ?? -1) > depth };
	});
}

/**
 * Depths counted through the rows actually shown, so a filtered list whose parent is hidden hangs
 * the child from the nearest shown ancestor instead of leaving it indented under nothing.
 */
export function shownDepths(nodes: readonly WorkerNode[]): number[] {
	const depthOf = new Map<string, number>();
	return nodes.map((node) => {
		const parent = node.parentRunId === null ? undefined : depthOf.get(node.parentRunId);
		const depth = parent === undefined ? 0 : parent + 1;
		depthOf.set(node.run.runId, depth);
		return depth;
	});
}
