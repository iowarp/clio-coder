import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * Resolve symlinks for an absolute path as far as the filesystem currently
 * exists. Existing targets return their real path; missing targets return the
 * real path of the deepest existing parent plus the unresolved tail.
 */
export function canonicalizeExistingPath(absPath: string): string {
	const resolved = path.resolve(absPath);
	try {
		return path.resolve(realpathSync(resolved));
	} catch {
		// Fall through to parent-prefix canonicalization for missing targets and
		// paths whose final component cannot be resolved.
	}

	const tail: string[] = [];
	let cursor = resolved;
	while (true) {
		const parent = path.dirname(cursor);
		if (parent === cursor) {
			try {
				return path.resolve(realpathSync(cursor), ...tail);
			} catch {
				return resolved;
			}
		}
		tail.unshift(path.basename(cursor));
		cursor = parent;
		try {
			return path.resolve(realpathSync(cursor), ...tail);
		} catch {
			// Keep walking toward the filesystem root.
		}
	}
}
