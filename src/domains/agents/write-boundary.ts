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
export const WRITE_BOUNDARY_MAX_ENTRIES = 32;

/** A normalized allowlist. Empty means "changes nothing", which is `readonly`. */
export type WriteBoundary = ReadonlyArray<string>;

const GLOB_CHARACTERS = /[*?[\]{}]/u;

/** Normalize one declared entry, or throw explaining exactly what is wrong. */
export function normalizeWriteBoundaryEntry(entry: string): string {
	const raw = entry.trim();
	if (raw.length === 0) throw new Error("write boundary: entry must be a non-empty path");
	if (raw.includes("\\")) {
		throw new Error(`write boundary: entry '${entry}' must use '/' separators`);
	}
	if (GLOB_CHARACTERS.test(raw)) {
		throw new Error(`write boundary: entry '${entry}' looks like a glob, which v1 does not support`);
	}
	if (raw.startsWith("/") || /^[A-Za-z]:/u.test(raw)) {
		throw new Error(`write boundary: entry '${entry}' must be repository-relative, not absolute`);
	}
	const subtree = raw.endsWith("/");
	const segments = raw.split("/").filter((segment) => segment.length > 0);
	if (segments.length === 0) {
		throw new Error(`write boundary: entry '${entry}' must name a path inside the repository`);
	}
	for (const segment of segments) {
		if (segment === "..") throw new Error(`write boundary: entry '${entry}' must not contain '..'`);
		if (segment === ".") throw new Error(`write boundary: entry '${entry}' must not contain '.' segments`);
	}
	const joined = segments.join("/");
	return subtree ? `${joined}/` : joined;
}

/**
 * Normalize a declaration. Duplicates collapse and the result is sorted, so two
 * spellings of the same boundary produce one canonical value that a plan hash
 * and a sealed verdict can both carry.
 */
export function normalizeWriteBoundary(entries: ReadonlyArray<string>): string[] {
	if (entries.length > WRITE_BOUNDARY_MAX_ENTRIES) {
		throw new Error(`write boundary: at most ${WRITE_BOUNDARY_MAX_ENTRIES} entries may be declared`);
	}
	const normalized = new Set(entries.map(normalizeWriteBoundaryEntry));
	// A file entry covered by a declared subtree is redundant, not an error: the
	// operator said the directory, and saying one of its files again changes
	// nothing about what is allowed.
	return [...normalized].sort();
}

/** Repo-relative path with the separators this grammar speaks. */
function toRepoRelativePosix(path: string): string {
	return path.split("\\").join("/");
}

/** Whether the boundary permits a change to one repo-relative path. */
export function writeBoundaryCovers(boundary: WriteBoundary, path: string): boolean {
	const candidate = toRepoRelativePosix(path);
	return boundary.some((entry) => (entry.endsWith("/") ? candidate.startsWith(entry) : candidate === entry));
}

/** Whether two declared entries can describe the same path. */
function entriesOverlap(left: string, right: string): boolean {
	if (left === right) return true;
	if (left.endsWith("/") && right.startsWith(left)) return true;
	if (right.endsWith("/") && left.startsWith(right)) return true;
	return false;
}

/** Whether two boundaries share any path. Empty boundaries never overlap. */
export function writeBoundariesOverlap(left: WriteBoundary, right: WriteBoundary): boolean {
	return left.some((entry) => right.some((other) => entriesOverlap(entry, other)));
}

/** Operator-facing rendering, used verbatim in violation messages. */
export function describeWriteBoundary(boundary: WriteBoundary): string {
	return boundary.length === 0 ? "(nothing: readonly)" : boundary.join(", ");
}
