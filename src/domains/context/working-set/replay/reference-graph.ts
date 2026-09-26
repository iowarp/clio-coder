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
	/**
	 * `file_reread_after_rewrite` is a re-read that follows a successful
	 * mutation of the same path: the earlier body could not have served it,
	 * so it is a diagnostic edge, never a critical reference.
	 */
	kind: "file_reread" | "file_reread_after_rewrite" | "file_discovery" | "file_rewrite";
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
/**
 * Ops whose observation is the call, not the path: two greps over `src/`
 * with different patterns are two observations, so only the identical call
 * re-observes the earlier one. A read or a listing of the same path is the
 * same observation whatever the arguments around it.
 */
const SAME_CALL_OPS = new Set<PathObservation["op"]>(["grep", "find", "code_nav"]);

function reobserves(later: PathObservation, earlier: PathObservation): boolean {
	if (later.path !== earlier.path) return false;
	if (!SAME_CALL_OPS.has(earlier.op)) return true;
	return earlier.argsKey.length > 0 && later.argsKey === earlier.argsKey;
}

function isToolResult(entry: SessionEntry | undefined): boolean {
	return entry?.kind === "message" && entry.role === "tool_result";
}

function isReadableObservation(observation: PathObservation): boolean {
	return !observation.isError && observation.path.length > 0 && READ_CLASS_OPS.has(observation.op);
}

function edgeKey(edge: ReferenceEdge): string {
	return `${edge.from}\u0000${edge.to.entryIndex}\u0000${edge.kind}`;
}

/** A successful read of `later.path` strictly between the two observations. */
function readBetween(earlier: PathObservation, later: PathObservation, index: PathIndex): boolean {
	for (const other of index.byPath.get(later.path) ?? []) {
		if (other.entryIndex <= earlier.entryIndex || other.entryIndex >= later.entryIndex) continue;
		if (isReadableObservation(other)) return true;
	}
	return false;
}

/** A successful write or edit of the path strictly between the two observations. */
function rewrittenBetween(earlier: PathObservation, later: PathObservation, index: PathIndex): boolean {
	for (const other of index.byPath.get(earlier.path) ?? []) {
		if (other.entryIndex <= earlier.entryIndex || other.entryIndex >= later.entryIndex) continue;
		if (MUTATION_OPS.has(other.op) && !other.isError) return true;
	}
	return false;
}

/**
 * Label future path use without inspecting result prose. Rewrites are emitted
 * for diagnosis but deliberately stay out of `futureReferencesOf`: a mutation
 * makes the earlier read stale rather than critical to retain. For the same
 * reason a re-read that follows the rewrite is not a reference to the stale
 * body: the model went back for the new content, which the old bytes could
 * not have given it. Scoring it as retained-or-not would reward keeping a
 * body that no longer describes the file.
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
		if (edge.kind === "file_rewrite" || edge.kind === "file_reread_after_rewrite") return;
		const points = future.get(edge.from);
		if (points === undefined) future.set(edge.from, new Map([[edge.to.entryIndex, edge.to]]));
		else points.set(edge.to.entryIndex, edge.to);
	};

	for (const earlier of index.observations) {
		if (!isToolResult(entryById.get(earlier.ref.entry)) || !isReadableObservation(earlier)) continue;
		const surfaced = new Set(earlier.surfaced);
		for (const later of index.observations) {
			if (later.entryIndex <= earlier.entryIndex) continue;
			if (isReadableObservation(later) && reobserves(later, earlier)) {
				add({
					from: earlier.ref.entry,
					to: pointOf(later),
					kind: rewrittenBetween(earlier, later, index) ? "file_reread_after_rewrite" : "file_reread",
				});
			}
			// A listing discovers a path once: the first read of it after the
			// listing. A later read of the same path is a re-read of the file, an
			// edge the file's own earlier read carries, not a second discovery.
			if (isReadableObservation(later) && surfaced.has(later.path) && !readBetween(earlier, later, index)) {
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
