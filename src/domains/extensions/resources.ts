import { realpathSync } from "node:fs";
import path from "node:path";
import { buildExtensionSnapshot } from "./snapshot.js";
import { committedExtensionSnapshot } from "./snapshot-store.js";
import type { ExtensionResourceKind, ExtensionResourceRoot } from "./types.js";

export { extensionResourcePath } from "./resource-path.js";

export function enabledExtensionResourceRoots(
	kind: ExtensionResourceKind,
	cwd = process.cwd(),
): ExtensionResourceRoot[] {
	const committed = committedExtensionSnapshot();
	try {
		if (committed !== null && committed.cwd === realpathSync(path.resolve(cwd))) {
			return [...committed.resourceRoots[kind]];
		}
	} catch {
		// Fall through to an ephemeral build, which retains the original error semantics.
	}
	return [...buildExtensionSnapshot({ cwd, generation: 0 }).resourceRoots[kind]];
}
