/**
 * Node-target route facts and their admission evaluation.
 *
 * A fact is always scoped to the node it was observed from. A `localhost`
 * endpoint means a different machine on every node, so an orchestrator-local
 * probe can never stand in for a fact about a remote node: `evaluateRouteFacts`
 * looks up the exact node-target tuple and refuses when the store has no fact
 * for it.
 *
 * Truth here has three states, not two. `false` is a proven negative, `true` a
 * proven positive, and `unknown` an absence of evidence. Shadow evaluation may
 * carry an unknown forward; an active hard requirement refuses it, because a
 * requirement satisfied by ignorance is not a requirement.
 */

/** Explicit tri-state. Unknown is never coerced toward either verdict. */
export type FactState = "true" | "false" | "unknown";

/** Facts one node observed about one target endpoint. */
export interface NodeTargetFact {
	nodeId: string;
	targetId: string;
	/** The endpoint answered from this node. */
	reachable: FactState;
	/** The node's runtime can speak this target's API family. */
	runtimeCompatible: FactState;
	/** The requested wire model is servable by this endpoint. */
	modelAvailable: FactState;
	/** The requested wire model is already resident, so no cold load is needed. */
	modelResident: FactState;
	/** Hash of the probed endpoint; no raw URL enters a durable fact. */
	endpointIdentityHash: string;
	wireModelId: string | null;
	probedAt: string;
	probeDurationMs: number;
}

/** Bounded resource facts a node attested, in the same tri-state discipline. */
export interface NodeResourceFact {
	nodeId: string;
	labels: ReadonlyArray<string>;
	cpuCount: number | null;
	totalMemoryBytes: number | null;
	gpuCount: number | null;
	vramBytes: number | null;
	observedAt: string;
}

/** What a route demands of the node-target tuple it wants to run on. */
export interface RouteFactRequirement {
	nodeId: string;
	targetId: string;
	wireModelId: string | null;
	endpointIdentityHash: string;
	/** Hard requirements. Each named requirement must be a proven positive. */
	requireReachable: boolean;
	requireRuntimeCompatible: boolean;
	requireModelAvailable: boolean;
	/** Minimum GPU count and VRAM the route declares it needs, if any. */
	requireGpuCount: number | null;
	requireVramBytes: number | null;
	/** Active admission refuses unknown; shadow evaluation records it. */
	mode: "active" | "shadow";
}

export type RouteFactVerdict =
	| { ok: true; unknowns: ReadonlyArray<string> }
	| { ok: false; reason: string; unknowns: ReadonlyArray<string> };

/** Facts older than this are stale evidence and satisfy no hard requirement. */
export const ROUTE_FACT_FRESHNESS_MS = 15 * 60 * 1000;

function isFresh(probedAt: string, now: number, freshnessMs: number): boolean {
	const at = Date.parse(probedAt);
	if (!Number.isFinite(at)) return false;
	return at <= now && now - at <= freshnessMs;
}

export interface RouteFactEvaluationOptions {
	now?: number;
	freshnessMs?: number;
}

/**
 * Evaluate one node-target tuple against a route's hard requirements. Returns
 * the unmet unknowns alongside the verdict so a shadow decision can report
 * exactly what evidence activation still needs.
 */
export function evaluateRouteFacts(
	facts: ReadonlyArray<NodeTargetFact>,
	resources: ReadonlyArray<NodeResourceFact>,
	requirement: RouteFactRequirement,
	options?: RouteFactEvaluationOptions,
): RouteFactVerdict {
	const now = options?.now ?? Date.now();
	const freshnessMs = options?.freshnessMs ?? ROUTE_FACT_FRESHNESS_MS;
	const unknowns: string[] = [];

	const fact = facts.find((entry) => entry.nodeId === requirement.nodeId && entry.targetId === requirement.targetId);
	if (!fact) {
		const unknowns = ["reachable", "runtimeCompatible", "modelAvailable"];
		if (requirement.mode === "shadow") return { ok: true, unknowns };
		return {
			ok: false,
			reason: `no probe fact for target '${requirement.targetId}' on node '${requirement.nodeId}'; run 'clio-coder doctor'`,
			unknowns,
		};
	}
	const fresh = isFresh(fact.probedAt, now, freshnessMs);
	if (fact.endpointIdentityHash !== requirement.endpointIdentityHash) {
		return {
			ok: false,
			reason: `node '${requirement.nodeId}' endpoint identity for target '${requirement.targetId}' does not match settings`,
			unknowns,
		};
	}

	const checks: Array<[string, boolean, FactState]> = [
		["reachable", requirement.requireReachable, fact.reachable],
		["runtimeCompatible", requirement.requireRuntimeCompatible, fact.runtimeCompatible],
		["modelAvailable", requirement.requireModelAvailable, fact.modelAvailable],
	];
	for (const [name, required, state] of checks) {
		if (state === "unknown") unknowns.push(name);
		if (!required) continue;
		if (state === "false") {
			return {
				ok: false,
				reason: `node '${requirement.nodeId}' proved ${name}=false for target '${requirement.targetId}'`,
				unknowns,
			};
		}
		if (state === "unknown" && requirement.mode === "active") {
			return {
				ok: false,
				reason: `node '${requirement.nodeId}' has no ${name} evidence for target '${requirement.targetId}'`,
				unknowns,
			};
		}
		if (!fresh && requirement.mode === "active") {
			return {
				ok: false,
				reason: `node '${requirement.nodeId}' ${name} evidence for target '${requirement.targetId}' is stale (probed ${fact.probedAt})`,
				unknowns,
			};
		}
	}
	if (
		requirement.requireModelAvailable &&
		requirement.wireModelId !== null &&
		fact.wireModelId !== null &&
		fact.wireModelId !== requirement.wireModelId
	) {
		return {
			ok: false,
			reason: `node '${requirement.nodeId}' model evidence names '${fact.wireModelId}', not '${requirement.wireModelId}'`,
			unknowns,
		};
	}

	const resource = resources.find((entry) => entry.nodeId === requirement.nodeId);
	const resourceChecks: Array<[string, number | null, number | null | undefined]> = [
		["gpuCount", requirement.requireGpuCount, resource?.gpuCount],
		["vramBytes", requirement.requireVramBytes, resource?.vramBytes],
	];
	for (const [name, required, observed] of resourceChecks) {
		if (observed === null || observed === undefined) {
			if (required !== null) unknowns.push(name);
			if (required !== null && requirement.mode === "active") {
				return {
					ok: false,
					reason: `node '${requirement.nodeId}' reports unknown ${name}; a declared fit requirement cannot be satisfied by unknown`,
					unknowns,
				};
			}
			continue;
		}
		if (required !== null && observed < required) {
			return {
				ok: false,
				reason: `node '${requirement.nodeId}' ${name} ${observed} is below the declared requirement ${required}`,
				unknowns,
			};
		}
	}
	return { ok: true, unknowns };
}
