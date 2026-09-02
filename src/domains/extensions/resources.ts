import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { listInstalledExtensions } from "./state.js";
import type { ExtensionResourceKind, ExtensionResourceRoot } from "./types.js";

export function extensionResourcePath(rootPath: string, resourcePath: string): string | null {
	const root = path.resolve(rootPath);
	const full = path.resolve(root, resourcePath);
	const relative = path.relative(root, full);
	if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
		return null;
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

export function enabledExtensionResourceRoots(
	kind: ExtensionResourceKind,
	cwd = process.cwd(),
): ExtensionResourceRoot[] {
	const roots: ExtensionResourceRoot[] = [];
	for (const entry of listInstalledExtensions(cwd)) {
		if (!entry.loadable) continue;
		const rel = entry.resources[kind];
		if (!rel) continue;
		const full = extensionResourcePath(entry.rootPath, rel);
		if (!full) continue;
		roots.push({
			id: entry.id,
			scope: entry.scope,
			path: full,
			rootPath: entry.rootPath,
			source: `extension:${entry.scope}:${entry.id}`,
			installedContentDigest: entry.installedContentDigest as string,
		});
	}
	return roots;
}
