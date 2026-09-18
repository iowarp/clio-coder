import { readlinkSync, realpathSync } from "node:fs";
import path from "node:path";

/** Linux MAXSYMLINKS. The kernel refuses a lookup that follows more links. */
const MAX_SYMLINK_HOPS = 40;

/** Windows accepts either separator in a raw path; POSIX allows `\` in a name. */
const RAW_SEPARATORS = path.sep === "\\" ? /[\\/]/u : /\//u;

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
export function canonicalizePath(absPath: string): string | null {
	return walkFrom(path.resolve(absPath), []);
}

/**
 * canonicalizePath for a raw path as a tool call or a shell command names it,
 * relative to base unless absolute, resolved the way the kernel resolves it.
 * path.resolve collapses `data/link/..` to `data` before the link is read; the
 * kernel reads the link and steps up from its target, so a redirect to
 * `data/link/../x` lands beside the target. Every component, `..` included,
 * goes through the canonicalizePath walk. Same null contract.
 */
export function canonicalizeRawPath(rawPath: string, base: string): string | null {
	const absBase = path.isAbsolute(base) ? base : `${process.cwd()}${path.sep}${base}`;
	const joined = path.isAbsolute(rawPath) ? rawPath : `${absBase}${path.sep}${rawPath}`;
	const { root } = path.parse(joined);
	const parts = joined
		.slice(root.length)
		.split(RAW_SEPARATORS)
		.filter((part) => part !== "" && part !== ".");
	const up = parts.indexOf("..");
	// Up to the first `..` the lexical and the physical reading agree.
	if (up === -1) return canonicalizePath(path.join(root, ...parts));
	return walkFrom(path.join(root, ...parts.slice(0, up)), parts.slice(up));
}

/** Resolve prefix, which holds no `..`, then walk the rest one component at a time. */
function walkFrom(prefix: string, rest: ReadonlyArray<string>): string | null {
	const pending = [...rest];
	let cursor = prefix;
	let current: string | null = null;
	while (current === null) {
		try {
			current = path.resolve(realpathSync(cursor));
		} catch {
			// Fall back toward the filesystem root for missing targets and for
			// paths whose links do not resolve.
			const parent = path.dirname(cursor);
			if (parent === cursor) return null;
			pending.unshift(path.basename(cursor));
			cursor = parent;
		}
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
		let target: string;
		try {
			target = readlinkSync(next);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
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
export function canonicalizeExistingPath(absPath: string): string {
	return canonicalizePath(absPath) ?? path.resolve(absPath);
}
