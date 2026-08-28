import path from "node:path";
import { asDirectoryPathBoundary, pathBoundaryEntryCovers, resolvePathBoundary } from "../../core/path-boundary.js";
import type { ActionClass } from "./action-classifier.js";

/**
 * Scope rules for worker-vs-orchestrator privilege checks. Phase 2 ships the
 * shapes and the subset predicate. Phase 6 consumes isSubset at dispatch
 * admission so a worker scope never escalates past the orchestrator.
 */

export interface ScopeSpec {
	allowedActions: ReadonlySet<ActionClass>;
	allowedWriteRoots: ReadonlyArray<string>;
	allowNetwork: boolean;
	allowDispatch: boolean;
}

function normalizeRoot(root: string): string {
	return resolvePathBoundary(process.cwd(), root);
}

export function isSubset(worker: ScopeSpec, orchestrator: ScopeSpec): boolean {
	for (const action of worker.allowedActions) {
		if (!orchestrator.allowedActions.has(action)) return false;
	}
	for (const root of worker.allowedWriteRoots) {
		const covered = orchestrator.allowedWriteRoots.some((outer) =>
			pathBoundaryEntryCovers(normalizeRoot(outer), normalizeRoot(root)),
		);
		if (!covered) return false;
	}
	if (worker.allowNetwork && !orchestrator.allowNetwork) return false;
	if (worker.allowDispatch && !orchestrator.allowDispatch) return false;
	return true;
}

export const READONLY_SCOPE: ScopeSpec = {
	allowedActions: new Set<ActionClass>(["read"]),
	allowedWriteRoots: [],
	allowNetwork: true,
	allowDispatch: false,
};

export const WORKSPACE_SCOPE: ScopeSpec = {
	allowedActions: new Set<ActionClass>(["read", "write", "execute", "dispatch"]),
	allowedWriteRoots: [asDirectoryPathBoundary(path.resolve(process.cwd()))],
	allowNetwork: true,
	allowDispatch: true,
};

export const CONFIRMED_SCOPE: ScopeSpec = {
	allowedActions: new Set<ActionClass>(["read", "write", "execute", "dispatch", "system_modify"]),
	allowedWriteRoots: [asDirectoryPathBoundary(path.resolve(process.cwd()))],
	allowNetwork: true,
	allowDispatch: true,
};
