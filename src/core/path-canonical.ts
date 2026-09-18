import { readlinkSync, realpathSync } from "node:fs";
import path from "node:path";

/** Linux MAXSYMLINKS. The kernel refuses a lookup that follows more links. */
const MAX_SYMLINK_HOPS = 40;

/** Windows accepts either separator in a raw path; POSIX allows `\` in a name. */
const RAW_SEPARATORS = path.sep === "\\" ? /[\\/]/u : /\//u;

/**
 * The realpath and readlink answers of one admission, so several walks that
 * share ancestors inside it inspect each component once. Create one per call
 * and drop it when the call is decided: an operator may replace a link between
 * calls, and a memo that outlives the call would judge the next one against
 * the old link.
 */
export interface PathWalkMemo {
	/** Absolute path to its realpath, or null when realpath threw. */
	readonly realpath: Map<string, string | null>;
	/** Absolute path to its link target, or the error code readlink threw. */
	readonly readlink: Map<string, { target: string } | { code: string | undefined }>;
}

export function createPathWalkMemo(): PathWalkMemo {
	return { realpath: new Map(), readlink: new Map() };
}

/**
 * Resolve an absolute path to where a read or write through it would land.
 * Existing targets return their real path. Otherwise the walk starts at the
 * deepest ancestor realpath resolves and takes the rest one component at a
 * time: a symlink at any component, dangling or not, is read and resolution
 * continues against the link's directory, and the first missing component
 * ends the walk with the rest appended unresolved.
 *
 * The input is resolved lexically first, so `link/..` collapses before the
 * link is read. A path a tool call supplies goes through canonicalizeRawPath.
 *
 * Returns null when the path cannot be canonicalized: a link loop, more than
 * MAX_SYMLINK_HOPS links, or a component that cannot be inspected. A
 * containment check must treat null as outside every root.
 */
export function canonicalizePath(absPath: string, memo?: PathWalkMemo): string | null {
	return walkFrom(path.resolve(absPath), [], memo);
}

/**
 * canonicalizePath for a raw path as a tool call or a shell command names it,
 * relative to base unless absolute, resolved the way the kernel resolves it.
 * path.resolve collapses `data/link/..` to `data` before the link is read; the
 * kernel reads the link and steps up from its target, so a redirect to
 * `data/link/../x` lands beside the target. Every component, `..` included,
 * goes through the canonicalizePath walk. Same null contract.
 */
export function canonicalizeRawPath(rawPath: string, base: string, memo?: PathWalkMemo): string | null {
	const absBase = path.isAbsolute(base) ? base : `${process.cwd()}${path.sep}${base}`;
	const joined = path.isAbsolute(rawPath) ? rawPath : `${absBase}${path.sep}${rawPath}`;
	const { root } = path.parse(joined);
	const parts = joined
		.slice(root.length)
		.split(RAW_SEPARATORS)
		.filter((part) => part !== "" && part !== ".");
	const up = parts.indexOf("..");
	// Up to the first `..` the lexical and the physical reading agree.
	if (up === -1) return canonicalizePath(path.join(root, ...parts), memo);
	return walkFrom(path.join(root, ...parts.slice(0, up)), parts.slice(up), memo);
}

function realpathOf(target: string, memo: PathWalkMemo | undefined): string | null {
	if (memo?.realpath.has(target)) return memo.realpath.get(target) as string | null;
	let resolved: string | null = null;
	try {
		resolved = path.resolve(realpathSync(target));
	} catch {
		// Missing, or a link that does not resolve.
	}
	memo?.realpath.set(target, resolved);
	return resolved;
}

function readlinkOf(target: string, memo: PathWalkMemo | undefined): { target: string } | { code: string | undefined } {
	const known = memo?.readlink.get(target);
	if (known !== undefined) return known;
	let answer: { target: string } | { code: string | undefined };
	try {
		answer = { target: readlinkSync(target) };
	} catch (error) {
		answer = { code: (error as NodeJS.ErrnoException).code };
	}
	memo?.readlink.set(target, answer);
	return answer;
}

/** Resolve prefix, which holds no `..`, then walk the rest one component at a time. */
function walkFrom(prefix: string, rest: ReadonlyArray<string>, memo: PathWalkMemo | undefined): string | null {
	const pending = [...rest];
	let cursor = prefix;
	let current = realpathOf(cursor, memo);
	while (current === null) {
		// Fall back toward the filesystem root for missing targets and for
		// paths whose links do not resolve.
		const parent = path.dirname(cursor);
		if (parent === cursor) return null;
		pending.unshift(path.basename(cursor));
		cursor = parent;
		current = realpathOf(cursor, memo);
	}

	// Only non-link components are appended, so current never holds a link
	// and `..` steps up from the real directory the way the kernel does.
	let hops = 0;
	while (pending.length > 0) {
		const part = pending.shift() as string;
		if (part === ".") continue;
		if (part === "..") {
			current = path.dirname(current);
			continue;
		}
		const next = path.join(current, part);
		// One readlink answers missing, plain, and link in a single call, which
		// keeps a plain missing path at one call more than realpath alone.
		const link = readlinkOf(next, memo);
		if ("code" in link) {
			const { code } = link;
			if (code === "EINVAL") {
				current = next;
				continue;
			}
			if (code === "ENOENT" || code === "ENOTDIR") {
				// Nothing below a missing entry is a link, so the rest appends as
				// is. A `..` in the rest climbs back to entries that can be links,
				// and a command that creates the missing directory first passes
				// through it as a plain one, so the walk goes on that way.
				if (!pending.includes("..")) return path.resolve(next, ...pending);
				current = next;
				continue;
			}
			return null;
		}
		const { target } = link;
		hops += 1;
		if (hops > MAX_SYMLINK_HOPS) return null;
		if (path.isAbsolute(target)) current = path.parse(target).root;
		pending.unshift(...target.split(path.sep).filter(Boolean));
	}
	return current;
}

/**
 * canonicalizePath for callers that key or display a path rather than decide
 * containment. A path that cannot be canonicalized comes back lexically
 * resolved, so the syscall that follows reports the loop itself.
 */
export function canonicalizeExistingPath(absPath: string, memo?: PathWalkMemo): string {
	return canonicalizePath(absPath, memo) ?? path.resolve(absPath);
}
