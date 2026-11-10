import { isAbsolute, relative, resolve, sep } from "node:path";
import { canonicalizeExistingPath } from "../../core/path-canonical.js";
import { isStorePath, storeGrantBoundaries } from "../../core/store-paths.js";
import type { AgentSpec } from "../agents/spec.js";
import type { DispatchRequest } from "./contract.js";
import { withDispatchIntentWriteRoots } from "./intent.js";

/** A request's declared write roots, canonical and resolved against its cwd; empty when it declared none. */
export function canonicalWriteRoots(request: Pick<DispatchRequest, "cwd" | "writeRoots" | "intent">): string[] {
	return (request.writeRoots ?? request.intent?.writeRoots ?? []).map((root) =>
		canonicalizeExistingPath(resolve(request.cwd ?? process.cwd(), root)),
	);
}

/**
 * True when a root on one side contains, or is contained by, a root on the other.
 * Store directories never overlap: a put is atomic and its record write-once,
 * so two writers granted one tag both land (M-31, D-MCP 4.6).
 */
export function writeRootsOverlap(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
	left = left.filter((root) => !isStorePath(root));
	right = right.filter((root) => !isStorePath(root));
	const contains = (parent: string, child: string) => {
		const rel = relative(parent, child);
		return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
	};
	return left.some((a) => right.some((b) => contains(a, b) || contains(b, a)));
}

function isWriter(request: DispatchRequest, classes: ReadonlyMap<string, AgentSpec["capabilityClass"]>): boolean {
	return request.worktree !== true && request.readOnly !== true && classes.get(request.agentId) !== "read-only";
}

/**
 * Admit a parallel batch that `parallelWriterConflict` refuses only because
 * writers holding a store grant declared no write roots. Store writes are not
 * workspace writes, so each such writer is confined to its granted store
 * directories, which never overlap. Requests are rewritten in place only when
 * that clears the conflict; otherwise nothing changes and the original refusal
 * stands. Returns true when the batch was confined.
 */
export function confineGrantOnlyWriters(requests: DispatchRequest[], specs: ReadonlyArray<AgentSpec>): boolean {
	const classes = new Map(specs.map((spec) => [spec.id, spec.capabilityClass]));
	const confined = requests.map((request): DispatchRequest => {
		const tags = request.storeTags ?? [];
		if (!isWriter(request, classes) || tags.length === 0 || canonicalWriteRoots(request).length > 0) return request;
		const roots = storeGrantBoundaries(request.cwd ?? process.cwd(), tags);
		return request.intent !== undefined
			? { ...request, intent: withDispatchIntentWriteRoots(request.intent, roots) }
			: { ...request, writeRoots: roots };
	});
	if (confined.every((request, index) => request === requests[index])) return false;
	if (parallelWriterConflict(confined, specs) !== null) return false;
	for (const [index, request] of confined.entries()) requests[index] = request;
	return true;
}

/** Ad-hoc roots are enforced by worker admission, independently of fleet diff windows. */
export function parallelWriterConflict(
	requests: ReadonlyArray<DispatchRequest>,
	specs: ReadonlyArray<AgentSpec>,
): string | null {
	const classes = new Map(specs.map((spec) => [spec.id, spec.capabilityClass]));
	const readOnlyIds = specs
		.filter((spec) => spec.capabilityClass === "read-only" && spec.audience !== "internal")
		.map((spec) => spec.id);
	const inspection =
		readOnlyIds.length > 0
			? `For inspection or review, dispatch read-only recipes instead: ${readOnlyIds.join(", ")}.`
			: "For inspection, choose read-only recipes from dispatch(list: true).";
	const writers = requests.filter((request) => isWriter(request, classes));
	const roots = writers.map(canonicalWriteRoots);
	for (let i = 0; i < writers.length; i++)
		for (let j = i + 1; j < writers.length; j++) {
			const left = roots[i] ?? [],
				right = roots[j] ?? [];
			if (!left.length || !right.length || writeRootsOverlap(left, right)) {
				return `parallel_writer_conflict: ${writers[i]?.agentId} and ${writers[j]?.agentId} have overlapping or undeclared write roots. ${inspection} For authorized writes, use worktree: true, declare disjoint intent.write_roots, or serialize writers with writers: 1.`;
			}
		}
	return null;
}
