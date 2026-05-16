import { statSync } from "node:fs";
import path from "node:path";
import { listInstalledExtensions } from "./state.js";
import type { ExtensionResourceKind, ExtensionResourceRoot } from "./types.js";

export function extensionResourcePath(rootPath: string, resourcePath: string): string | null {
	const root = path.resolve(rootPath);
	const full = path.resolve(root, resourcePath);
	const relative = path.relative(root, full);
	if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return full;
	return null;
}

export function enabledExtensionResourceRoots(
	kind: ExtensionResourceKind,
	cwd = process.cwd(),
): ExtensionResourceRoot[] {
	const roots: ExtensionResourceRoot[] = [];
	for (const entry of listInstalledExtensions(cwd)) {
		if (!entry.enabled || !entry.effective) continue;
		const rel = entry.resources[kind];
		if (!rel) continue;
		const full = extensionResourcePath(entry.rootPath, rel);
		if (!full) continue;
		try {
			if (!statSync(full).isDirectory()) continue;
		} catch {
			continue;
		}
		roots.push({
			id: entry.id,
			scope: entry.scope,
			path: full,
			source: `extension:${entry.scope}:${entry.id}`,
		});
	}
	return roots;
}
