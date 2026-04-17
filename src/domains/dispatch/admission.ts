import type { ActionClass } from "../safety/action-classifier.js";
import type { ScopeSpec } from "../safety/scope.js";

/**
 * Dispatch admission gate. Given a worker's requested scope and the
 * orchestrator's active scope, decide whether the dispatch may proceed. The
 * actual subset predicate is injected so this module stays pure and testable
 * without importing the safety domain's runtime wiring.
 *
 * Rules:
 *   1. worker scope must be a subset of orchestrator scope.
 *   2. every requestedAction must appear in requestedScope.allowedActions.
 *   3. otherwise admit.
 */

export interface AdmissionRequest {
	requestedScope: ScopeSpec;
	orchestratorScope: ScopeSpec;
	requestedActions: ReadonlyArray<ActionClass>;
	agentId: string;
}

export interface AdmissionVerdict {
	admitted: boolean;
	reason: string;
}

export function admit(
	req: AdmissionRequest,
	subsetFn: (worker: ScopeSpec, orch: ScopeSpec) => boolean,
): AdmissionVerdict {
	if (!subsetFn(req.requestedScope, req.orchestratorScope)) {
		return { admitted: false, reason: `scope ${req.agentId} is not a subset` };
	}
	for (const action of req.requestedActions) {
		if (!req.requestedScope.allowedActions.has(action)) {
			return { admitted: false, reason: `action ${action} not in requestedScope.allowedActions` };
		}
	}
	return { admitted: true, reason: "ok" };
}
