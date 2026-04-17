import path from "node:path";
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
	return path.resolve(root);
}

function isUnder(child: string, parent: string): boolean {
	const c = normalizeRoot(child);
	const p = normalizeRoot(parent);
	if (c === p) return true;
	const rel = path.relative(p, c);
	return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export function isSubset(worker: ScopeSpec, orchestrator: ScopeSpec): boolean {
	for (const action of worker.allowedActions) {
		if (!orchestrator.allowedActions.has(action)) return false;
	}
	for (const root of worker.allowedWriteRoots) {
		const covered = orchestrator.allowedWriteRoots.some((outer) => isUnder(root, outer));
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

export const DEFAULT_SCOPE: ScopeSpec = {
	allowedActions: new Set<ActionClass>(["read", "write", "execute", "dispatch"]),
	allowedWriteRoots: [process.cwd()],
	allowNetwork: true,
	allowDispatch: true,
};

export const SUPER_SCOPE: ScopeSpec = {
	allowedActions: new Set<ActionClass>(["read", "write", "execute", "dispatch", "system_modify"]),
	allowedWriteRoots: [process.cwd()],
	allowNetwork: true,
	allowDispatch: true,
};
