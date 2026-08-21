import type { SessionEntry } from "../../../session/entries.js";
import type { PathIndex, PathObservation } from "../path-index.js";
import type { Trace } from "./trace.js";

export interface ReferenceEdge {
	/** Ref key of the earlier tool_result. */
	from: string;
	toTurnIndex: number;
	kind: "file_reread" | "file_discovery" | "file_rewrite";
}

export interface ReferenceGraph {
	edges: ReadonlyArray<ReferenceEdge>;
	/** Critical future references only: file_reread and file_discovery. */
	futureTurnsOf: ReadonlyMap<string, ReadonlyArray<number>>;
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
	return `${edge.from}\u0000${edge.toTurnIndex}\u0000${edge.kind}`;
}

/**
 * Label future path use without inspecting result prose. Rewrites are emitted
 * for diagnosis but deliberately stay out of `futureTurnsOf`: a mutation makes
 * the earlier read stale rather than critical to retain.
 */
export function buildReferenceGraph(trace: Trace, index: PathIndex): ReferenceGraph {
	const entryById = new Map(trace.entries.map((entry) => [entry.turnId, entry]));
	const edges: ReferenceEdge[] = [];
	const seenEdges = new Set<string>();
	const future = new Map<string, Set<number>>();

	const add = (edge: ReferenceEdge): void => {
		const key = edgeKey(edge);
		if (seenEdges.has(key)) return;
		seenEdges.add(key);
		edges.push(edge);
		if (edge.kind === "file_rewrite") return;
		const turns = future.get(edge.from);
		if (turns === undefined) future.set(edge.from, new Set([edge.toTurnIndex]));
		else turns.add(edge.toTurnIndex);
	};

	for (const earlier of index.observations) {
		if (!isToolResult(entryById.get(earlier.ref.entry)) || !isReadableObservation(earlier)) continue;
		const surfaced = new Set(earlier.surfaced);
		for (const later of index.observations) {
			if (later.entryIndex <= earlier.entryIndex) continue;
			if (isReadableObservation(later) && later.path === earlier.path) {
				add({ from: earlier.ref.entry, toTurnIndex: later.turnIndex, kind: "file_reread" });
			}
			if (isReadableObservation(later) && surfaced.has(later.path)) {
				add({ from: earlier.ref.entry, toTurnIndex: later.turnIndex, kind: "file_discovery" });
			}
			if (later.path === earlier.path && MUTATION_OPS.has(later.op)) {
				add({ from: earlier.ref.entry, toTurnIndex: later.turnIndex, kind: "file_rewrite" });
			}
		}
	}

	const futureTurnsOf = new Map<string, ReadonlyArray<number>>();
	for (const [ref, turns] of future)
		futureTurnsOf.set(
			ref,
			[...turns].sort((a, b) => a - b),
		);
	return { edges, futureTurnsOf };
}
