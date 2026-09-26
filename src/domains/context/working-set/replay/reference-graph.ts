import type { SessionEntry } from "../../../session/entries.js";
import { checkpointPositions } from "../checkpoint.js";
import type { PathIndex, PathObservation } from "../path-index.js";
import type { Trace } from "./trace.js";

/**
 * Where a later observation sits, in the two coordinates the metrics use.
 * `position` is the pressure-checkpoint count at or before the entry
 * (`checkpointPositions` in checkpoint.ts): an eviction fired at checkpoint
 * `k` precedes every entry whose position is at least `k`, so retention is
 * decided by comparing positions. `turnIndex` is the operator-turn count, kept
 * for the `@10` distance window, which is a turn distance by definition.
 */
export interface ReferencePoint {
	position: number;
	turnIndex: number;
	entryIndex: number;
}

export interface ReferenceEdge {
	/** Ref key of the earlier tool_result. */
	from: string;
	to: ReferencePoint;
	kind: "file_reread" | "file_discovery" | "file_rewrite";
}

export interface ReferenceGraph {
	edges: ReadonlyArray<ReferenceEdge>;
	/** Critical future references only: file_reread and file_discovery, ascending by position. */
	futureReferencesOf: ReadonlyMap<string, ReadonlyArray<ReferencePoint>>;
	/** Checkpoint position of every trace entry, keyed by turnId. */
	positionOf: ReadonlyMap<string, number>;
}

const READ_CLASS_OPS = new Set<PathObservation["op"]>(["read", "grep", "find", "ls", "code_nav"]);
const MUTATION_OPS = new Set<PathObservation["op"]>(["write", "edit"]);

function isToolResult(entry: SessionEntry | undefined): boolean {
	return entry?.kind === "message" && entry.role === "tool_result";
}

function isReadableObservation(observation: PathObservation): boolean {
	return !observation.isError && observation.path.length > 0 && READ_CLASS_OPS.has(observation.op);
}

function edgeKey(edge: ReferenceEdge): string {
	return `${edge.from}\u0000${edge.to.entryIndex}\u0000${edge.kind}`;
}

/**
 * Label future path use without inspecting result prose. Rewrites are emitted
 * for diagnosis but deliberately stay out of `futureReferencesOf`: a mutation
 * makes the earlier read stale rather than critical to retain.
 */
export function buildReferenceGraph(trace: Trace, index: PathIndex): ReferenceGraph {
	const entryById = new Map(trace.entries.map((entry) => [entry.turnId, entry]));
	const positions = checkpointPositions(trace.entries);
	const positionOf = new Map<string, number>();
	for (let i = 0; i < trace.entries.length; i += 1) {
		const entry = trace.entries[i];
		if (entry !== undefined) positionOf.set(entry.turnId, positions[i] ?? 0);
	}
	const edges: ReferenceEdge[] = [];
	const seenEdges = new Set<string>();
	const future = new Map<string, Map<number, ReferencePoint>>();

	const pointOf = (observation: PathObservation): ReferencePoint => ({
		position: positions[observation.entryIndex] ?? 0,
		turnIndex: observation.turnIndex,
		entryIndex: observation.entryIndex,
	});

	const add = (edge: ReferenceEdge): void => {
		const key = edgeKey(edge);
		if (seenEdges.has(key)) return;
		seenEdges.add(key);
		edges.push(edge);
		if (edge.kind === "file_rewrite") return;
		const points = future.get(edge.from);
		if (points === undefined) future.set(edge.from, new Map([[edge.to.entryIndex, edge.to]]));
		else points.set(edge.to.entryIndex, edge.to);
	};

	for (const earlier of index.observations) {
		if (!isToolResult(entryById.get(earlier.ref.entry)) || !isReadableObservation(earlier)) continue;
		const surfaced = new Set(earlier.surfaced);
		for (const later of index.observations) {
			if (later.entryIndex <= earlier.entryIndex) continue;
			if (isReadableObservation(later) && later.path === earlier.path) {
				add({ from: earlier.ref.entry, to: pointOf(later), kind: "file_reread" });
			}
			if (isReadableObservation(later) && surfaced.has(later.path)) {
				add({ from: earlier.ref.entry, to: pointOf(later), kind: "file_discovery" });
			}
			if (later.path === earlier.path && MUTATION_OPS.has(later.op)) {
				add({ from: earlier.ref.entry, to: pointOf(later), kind: "file_rewrite" });
			}
		}
	}

	const futureReferencesOf = new Map<string, ReadonlyArray<ReferencePoint>>();
	for (const [ref, points] of future) {
		futureReferencesOf.set(
			ref,
			[...points.values()].sort((a, b) => a.position - b.position || a.entryIndex - b.entryIndex),
		);
	}
	return { edges, futureReferencesOf, positionOf };
}
