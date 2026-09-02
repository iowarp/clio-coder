import { realpathSync } from "node:fs";
import path from "node:path";
import { buildExtensionSnapshot } from "./snapshot.js";
import { committedExtensionSnapshot } from "./snapshot-store.js";
import type { ExtensionResourceKind, ExtensionResourceRoot, ExtensionSnapshot } from "./types.js";

export { extensionResourcePath } from "./resource-path.js";

/**
 * The committed snapshot when a store is bound for this cwd; otherwise an
 * ephemeral generation-0 build that never touches the store. The ephemeral
 * branch serves the CLI, `config inspect` with an explicit cwd, and any
 * process that never booted the extensions bundle.
 */
export function extensionSnapshotFor(cwd = process.cwd()): ExtensionSnapshot {
	const committed = committedExtensionSnapshot();
	try {
		if (committed !== null && committed.cwd === realpathSync(path.resolve(cwd))) return committed;
	} catch {
		// Fall through to an ephemeral build, which retains the original error semantics.
	}
	return buildExtensionSnapshot({ cwd, generation: 0 });
}

export function enabledExtensionResourceRoots(
	kind: ExtensionResourceKind,
	cwd = process.cwd(),
): ExtensionResourceRoot[] {
	return [...extensionSnapshotFor(cwd).resourceRoots[kind]];
}
