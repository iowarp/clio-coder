import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

/**
 * Whether `path`, with every link resolved, stays inside `root`. A path that
 * cannot be resolved is not inside: a repository may ship links, and a link
 * that leaves the checkout must not pull outside files into project context.
 */
export function realpathInside(path: string, root: string): boolean {
	try {
		const rel = relative(realpathSync(root), realpathSync(path));
		return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	} catch {
		return false;
	}
}
