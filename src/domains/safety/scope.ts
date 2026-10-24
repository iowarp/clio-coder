import path from "node:path";
import { asDirectoryPathBoundary, resolvePathBoundary, writeRootsCover } from "../../core/path-boundary.js";
import type { ActionClass } from "./action-classifier.js";

/**
 * Scope rules for worker-vs-orchestrator privilege checks. Dispatch admission
 * consumes isSubset so a worker scope never escalates past the orchestrator.
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
		const covered = writeRootsCover(orchestrator.allowedWriteRoots.map(normalizeRoot), normalizeRoot(root));
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

/**
 * Scopes rooted at the process working directory, read at each use. `run --cwd`
 * and ACP `session/new` enter the selected workspace after this module is
 * imported, so a root captured at import named the launch directory (#433).
 * The root stays the process directory, the one the orchestrator's own tools
 * and policy engine resolve against, so a resumed session recorded elsewhere
 * fails closed instead of widening worker writes past the orchestrator.
 */
function processWorkspaceRoots(): string[] {
	return [asDirectoryPathBoundary(path.resolve(process.cwd()))];
}

export const WORKSPACE_SCOPE: ScopeSpec = {
	allowedActions: new Set<ActionClass>(["read", "write", "execute", "dispatch"]),
	get allowedWriteRoots() {
		return processWorkspaceRoots();
	},
	allowNetwork: true,
	allowDispatch: true,
};

export const CONFIRMED_SCOPE: ScopeSpec = {
	allowedActions: new Set<ActionClass>(["read", "write", "execute", "dispatch", "system_modify", "destructive"]),
	get allowedWriteRoots() {
		return processWorkspaceRoots();
	},
	allowNetwork: true,
	allowDispatch: true,
};
