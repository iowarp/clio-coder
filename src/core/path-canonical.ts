import { readlinkSync, realpathSync } from "node:fs";
import path from "node:path";

/** Linux MAXSYMLINKS. The kernel refuses a lookup that follows more links. */
const MAX_SYMLINK_HOPS = 40;

/**
 * Resolve an absolute path to where a read or write through it would land.
 * Existing targets return their real path. Otherwise the walk starts at the
 * deepest ancestor realpath resolves and takes the rest one component at a
 * time: a symlink at any component, dangling or not, is read and resolution
 * continues against the link's directory, and the first missing component
 * ends the walk with the rest appended unresolved.
 *
 * Returns null when the path cannot be canonicalized: a link loop, more than
 * MAX_SYMLINK_HOPS links, or a component that cannot be inspected. A
 * containment check must treat null as outside every root.
 */
export function canonicalizePath(absPath: string): string | null {
	const resolved = path.resolve(absPath);
	try {
		return path.resolve(realpathSync(resolved));
	} catch {
		// Fall through to the component walk for missing targets and for paths
		// whose links do not resolve.
	}

	const pending: string[] = [];
	let cursor = resolved;
	let current: string | null = null;
	while (current === null) {
		const parent = path.dirname(cursor);
		if (parent === cursor) return null;
		pending.unshift(path.basename(cursor));
		cursor = parent;
		try {
			current = path.resolve(realpathSync(cursor));
		} catch {
			// Keep walking toward the filesystem root.
		}
	}

	// Only non-link components are appended, so current stays a real path and
	// `..` from a link target steps up lexically the way the kernel would.
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
			if (code === "ENOENT" || code === "ENOTDIR") return path.resolve(next, ...pending);
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
