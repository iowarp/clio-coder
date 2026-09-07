import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalizeExistingPath } from "../../core/path-canonical.js";
import type { AgentSpec } from "../agents/spec.js";
import type { DispatchRequest } from "./contract.js";

/** Ad-hoc roots are enforced by worker admission, independently of fleet diff windows. */
export function parallelWriterConflict(
	requests: ReadonlyArray<DispatchRequest>,
	specs: ReadonlyArray<AgentSpec>,
): string | null {
	const classes = new Map(specs.map((spec) => [spec.id, spec.capabilityClass]));
	const writers = requests.filter(
		(request) =>
			request.worktree !== true && request.autonomy !== "read-only" && classes.get(request.agentId) !== "read-only",
	);
	const roots = writers.map((request) =>
		(request.writeRoots ?? request.intent?.writeRoots ?? []).map((root) =>
			canonicalizeExistingPath(resolve(request.cwd ?? process.cwd(), root)),
		),
	);
	const contains = (parent: string, child: string) => {
		const rel = relative(parent, child);
		return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
	};
	for (let i = 0; i < writers.length; i++)
		for (let j = i + 1; j < writers.length; j++) {
			const left = roots[i] ?? [],
				right = roots[j] ?? [];
			if (!left.length || !right.length || left.some((a) => right.some((b) => contains(a, b) || contains(b, a)))) {
				return `parallel_writer_conflict: ${writers[i]?.agentId} and ${writers[j]?.agentId} have overlapping or undeclared write roots. Use worktree: true, declare disjoint intent.write_roots, or serialize writers with writers: 1.`;
			}
		}
	return null;
}
