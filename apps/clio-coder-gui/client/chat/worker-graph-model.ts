import type { FleetItem } from "../../contracts/fleet-events.js";
import { type FleetRun, foldFleetRuns, isLiveRun } from "./fleet-facts.js";

export interface WorkerNode {
	run: FleetRun;
	parentRunId: string | null;
	depth: number;
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
		let depth = 0;
		const visited = new Set([run.runId]);
		while (cursor && known.has(cursor) && !visited.has(cursor)) {
			visited.add(cursor);
			depth++;
			cursor = parents.get(cursor);
		}
		// A malformed cyclic origin must not create an infinitely nested graph.
		const cyclic = cursor !== undefined && visited.has(cursor);
		return {
			run,
			parentRunId: cyclic ? null : parent,
			depth: cyclic ? 0 : depth,
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
