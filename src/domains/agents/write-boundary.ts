import {
	normalizePathBoundary,
	normalizePathBoundaryEntry,
	PATH_BOUNDARY_MAX_ENTRIES,
	type PathBoundary,
	pathBoundariesOverlap,
	pathBoundaryCovers,
} from "../../core/path-boundary.js";

/**
 * Declared write boundaries: the repo paths a fleet step is allowed to change.
 *
 * A tool permission level is a capability list. This is a boundary, and they
 * are not the same thing: a step that may run a command may write anywhere that
 * command can reach, so "this step changes nothing outside `docs/`" is a claim
 * about the repository, not about the tool surface. Clio settles the claim in
 * code, after the step, by diffing the workspace.
 *
 * This module owns only the grammar: what a declared entry may look like, what
 * it covers, and when two declarations overlap. The enforcement half lives in
 * `src/domains/dispatch/write-boundary.ts`, because deciding what a step was
 * allowed to write is contract policy and observing what it did write is a
 * property of the checkout.
 *
 * Grammar, deliberately small (v1 has no globs):
 *
 *   src/domains/dispatch/route-facts.ts   exactly that file
 *   docs/                                 that directory and everything under it
 *
 * Entries are repo-relative and POSIX-separated. An absolute path, a `..`
 * segment, a backslash, or a glob character is refused at parse time rather
 * than interpreted, because an allowlist that quietly means something other
 * than it says is worse than no allowlist.
 */

/**
 * Upper bound on one step's declared allowlist. A boundary is a statement an
 * operator has to be able to read; thirty-two prefixes is already generous, and
 * a step that needs more of the tree than that should say `workspace` and mean
 * it in a contract that does not claim a boundary.
 */
export const WRITE_BOUNDARY_MAX_ENTRIES = PATH_BOUNDARY_MAX_ENTRIES;

/** A normalized allowlist. Empty means "changes nothing", which is `readonly`. */
export type WriteBoundary = PathBoundary;

/** Normalize one declared entry, or throw explaining exactly what is wrong. */
export function normalizeWriteBoundaryEntry(entry: string): string {
	return normalizePathBoundaryEntry(entry);
}

/**
 * Normalize a declaration. Duplicates collapse and the result is sorted, so two
 * spellings of the same boundary produce one canonical value that a plan hash
 * and a sealed verdict can both carry.
 */
export function normalizeWriteBoundary(entries: ReadonlyArray<string>): string[] {
	return normalizePathBoundary(entries);
}

/** Whether the boundary permits a change to one repo-relative path. */
export function writeBoundaryCovers(boundary: WriteBoundary, path: string): boolean {
	return pathBoundaryCovers(boundary, path);
}

/** Whether two boundaries share any path. Empty boundaries never overlap. */
export function writeBoundariesOverlap(left: WriteBoundary, right: WriteBoundary): boolean {
	return pathBoundariesOverlap(left, right);
}

/** Operator-facing rendering, used verbatim in violation messages. */
export function describeWriteBoundary(boundary: WriteBoundary): string {
	return boundary.length === 0 ? "(nothing: readonly)" : boundary.join(", ");
}
