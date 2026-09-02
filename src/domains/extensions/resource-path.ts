import { realpathSync, statSync } from "node:fs";
import path from "node:path";

export function extensionResourcePath(rootPath: string, resourcePath: string): string | null {
	const root = path.resolve(rootPath);
	const full = path.resolve(root, resourcePath);
	const relative = path.relative(root, full);
	if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		return null;
	}
	try {
		const rootReal = realpathSync(root);
		const fullReal = realpathSync(full);
		const canonicalRelative = path.relative(rootReal, fullReal);
		if (
			canonicalRelative === ".." ||
			canonicalRelative.startsWith(`..${path.sep}`) ||
			path.isAbsolute(canonicalRelative)
		) {
			return null;
		}
		if (!statSync(fullReal).isDirectory()) return null;
		return fullReal;
	} catch {
		return null;
	}
}
