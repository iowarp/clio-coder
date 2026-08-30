import { lstatSync, realpathSync } from "node:fs";
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
		if (!lstatSync(full).isDirectory()) return null;
		return full;
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
		if (!entry.enabled || !entry.compatible || !entry.effective) continue;
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
		});
	}
	return roots;
}
