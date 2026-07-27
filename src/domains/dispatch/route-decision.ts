/**
 * RouteDecisionV1: the sealed, explainable artifact behind one route choice.
 *
 * A routing decision selects an admissible execution system, not a difficulty
 * label for a prompt. The selectable object is the whole tuple of agent,
 * target, model, runtime, node, and operational composition, and the operator
 * chooses the operating point on the cost-quality-latency frontier by naming a
 * posture.
 *
 * Three invariants hold at every mode:
 *
 *   - Hard constraints eliminate. A candidate the admission chain rejected can
 *     never appear as `selected` or in `approvedFallbacks`, at any posture,
 *     for any score. It stays in `candidateEvaluations` with its reason, which
 *     is what makes the decision explainable rather than merely recorded.
 *   - The decision is deterministic. `decisionHash` covers the inputs, not the
 *     wall clock, so equal inputs produce an equal hash and an offline replay
 *     of a stored decision reproduces it exactly.
 *   - Shadow mode is advisory. In shadow mode the caller has already resolved
 *     and is already executing a route; this module records what the policy
 *     would have chosen and never returns anything the caller feeds back into
 *     placement. `executedRoute` is carried in the artifact precisely so regret
 *     is computable later without re-running the decision.
 *
 * Pure by construction: no I/O, no clock, no engine state.
 */

import { createHash } from "node:crypto";
import type { ExecutionRole } from "./execution-role.js";
import {
	clearsPostureFloors,
	compareRankedRoutes,
	DEFAULT_ROUTE_PRIOR,
	dominatesRoute,
	estimateRoute,
	ROUTE_POLICY_VERSION,
	type RouteEstimate,
	type RoutingPosture,
	routeScoreScale,
	scoreRoute,
} from "./route-policy.js";

/**
 * The unit of selection. It is the agent and its whole operational
 * composition, not a model name: a cheap model that strips the Coder's editing
 * tools is not a cheap route, so the tool surface and prompt composition are
 * part of the candidate's identity.
 */
export interface RouteCandidate {
	agentId: string;
	specFingerprint: string;
	executionRole: ExecutionRole;
	targetId: string;
	modelId: string;
	runtimeId: string;
	nodeId: string;
	thinkingLevel?: string;
	toolSignature: string;
	promptCompositionHash: string;
	/** Hash of the effective endpoint URL. Raw endpoint data never enters the decision. */
	endpointIdentityHash: string;
	/** Fingerprint of the immutable settings snapshot used to construct this route. */
	settingsFingerprint: string;
}

export type RouteDecisionMode = "fixed" | "shadow" | "active";

export interface CandidateEvaluation {
	candidate: RouteCandidate;
	estimate: RouteEstimate;
	/** Null when every hard constraint passed; otherwise the constraint that rejected it. */
	rejection: string | null;
	/** Posture score. Null for a rejected candidate: a rejected route is never scored. */
	score: number | null;
	/** True when an admissible candidate is no worse on all three objectives and better on one. */
	dominated: boolean;
}

export interface RouteDecisionV1 {
	policyVersion: string;
	mode: RouteDecisionMode;
	posture: RoutingPosture;
	selected: RouteCandidate;
	approvedFallbacks: RouteCandidate[];
	hardConstraints: string[];
	candidateEvaluations: CandidateEvaluation[];
	reasonCodes: string[];
	decisionDurationMs: number;
	confidence: number;
	decisionHash: string;
	/**
	 * The route the caller actually ran. Equal to `selected` at fixed and active
	 * mode; in shadow mode it is the production route the decision did not
	 * touch, and the pair is what route regret is computed from.
	 */
	executedRoute: RouteCandidate;
}

/** Candidate plus verdict, before scoring. The caller owns hard-filter truth. */
export interface RouteCandidateInput {
	candidate: RouteCandidate;
	estimate: RouteEstimate;
	rejection: string | null;
}

export interface RouteDecisionInput {
	mode: RouteDecisionMode;
	posture: RoutingPosture;
	/** The route the production pipeline resolved and is executing. */
	executedRoute: RouteCandidate;
	/** Every enumerated tuple with its hard-filter verdict; order is the caller's approval order. */
	candidates: ReadonlyArray<RouteCandidateInput>;
	/** Names of the hard constraints the caller applied, for the explanation. */
	hardConstraints: ReadonlyArray<string>;
	/** Envelope width; the selected route does not count against it. */
	maxFallbacks: number;
	/** Measured resolver duration. Excluded from the hash: it is not an input. */
	decisionDurationMs: number;
}

/** Stable identity of a tuple. Two candidates with equal keys are the same route. */
export function routeCandidateKey(candidate: RouteCandidate): string {
	return [
		candidate.agentId,
		candidate.specFingerprint,
		candidate.executionRole,
		candidate.targetId,
		candidate.modelId,
		candidate.runtimeId,
		candidate.nodeId,
		candidate.thinkingLevel ?? "",
		candidate.toolSignature,
		candidate.promptCompositionHash,
		candidate.endpointIdentityHash,
		candidate.settingsFingerprint,
	].join("\u0000");
}

export function sameRouteIdentity(left: RouteCandidate, right: RouteCandidate): boolean {
	return routeCandidateKey(left) === routeCandidateKey(right);
}

/** The route facts a resolved or probed tuple supplies, in the resolver's shape. */
export interface RouteIdentityInput {
	agentId: string;
	specFingerprint: string;
	targetId: string;
	wireModelId: string;
	runtimeId: string;
	nodeId: string;
	thinkingLevel: string | null;
	toolSignature: string;
	endpointIdentityHash: string;
	settingsFingerprint: string;
}

/**
 * The request facts that decide a tuple's prompt composition. The role itself is
 * derived once by `execution-role.ts` and passed in, so candidate construction
 * cannot invent a second, divergent role policy.
 */
export interface RouteRoleInput {
	executionRole: ExecutionRole;
	/** Persona override prompt when the request substituted one, else undefined. */
	personaPrompt?: string;
}

/**
 * Prompt composition identity for a tuple that may never have run.
 *
 * The real compiled prompt hash requires composing the prompt, which is async
 * and would multiply the cost of enumerating alternates. This is the identity
 * of the composition's inputs instead: the recipe surface, the tool surface the
 * runtime actually leaves, and any persona override. Two candidates with the
 * same value would compose the same worker prompt, which is the grouping route
 * statistics need, and it is computable for a tuple never dispatched.
 */
export function promptCompositionIdentity(identity: RouteIdentityInput, role: RouteRoleInput): string {
	const persona =
		role.personaPrompt !== undefined ? createHash("sha256").update(role.personaPrompt, "utf8").digest("hex") : null;
	return createHash("sha256")
		.update(
			JSON.stringify({
				specFingerprint: identity.specFingerprint,
				toolSignature: identity.toolSignature,
				persona,
			}),
			"utf8",
		)
		.digest("hex");
}

export function toRouteCandidate(identity: RouteIdentityInput, role: RouteRoleInput): RouteCandidate {
	return {
		agentId: identity.agentId,
		specFingerprint: identity.specFingerprint,
		executionRole: role.executionRole,
		targetId: identity.targetId,
		modelId: identity.wireModelId,
		runtimeId: identity.runtimeId,
		nodeId: identity.nodeId,
		...(identity.thinkingLevel !== null ? { thinkingLevel: identity.thinkingLevel } : {}),
		toolSignature: identity.toolSignature,
		promptCompositionHash: promptCompositionIdentity(identity, role),
		endpointIdentityHash: identity.endpointIdentityHash,
		settingsFingerprint: identity.settingsFingerprint,
	};
}

function canonical(value: unknown): string {
	if (value === null || value === undefined) return "null";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error(`route decision: non-finite number ${String(value)}`);
		// Estimates are floats derived from division; a fixed precision keeps the
		// hash stable against the last bits of otherwise-equal computations.
		return JSON.stringify(Number(value.toFixed(9)));
	}
	if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.filter((key) => record[key] !== undefined)
			.map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
			.join(",")}}`;
	}
	throw new Error(`route decision: unsupported value of type ${typeof value}`);
}

/**
 * The hash covers exactly the decision's inputs: policy version, mode, posture,
 * the executed route, the enumerated candidates with their estimates and
 * verdicts, the declared hard constraints, and the envelope width. It excludes
 * `decisionDurationMs`, which is a measurement of the decision rather than an
 * input to it, so a replay on a faster machine still reproduces the hash.
 */
export function routeDecisionHash(input: RouteDecisionInput): string {
	return createHash("sha256")
		.update(
			canonical({
				policyVersion: ROUTE_POLICY_VERSION,
				mode: input.mode,
				posture: input.posture,
				executedRoute: input.executedRoute,
				candidates: input.candidates.map((entry) => ({
					candidate: entry.candidate,
					estimate: entry.estimate,
					rejection: entry.rejection,
				})),
				hardConstraints: [...input.hardConstraints],
				maxFallbacks: input.maxFallbacks,
			}),
			"utf8",
		)
		.digest("hex");
}

/**
 * Build the decision.
 *
 * Order of operations is the whole point: hard filters eliminate, then floors
 * eliminate, then the remaining candidates are scored and ordered. A candidate
 * that never cleared a hard filter is scored `null` and cannot reach `selected`
 * or `approvedFallbacks` regardless of how attractive its estimate looks.
 *
 * At `manual` posture the operator named the route, so the executed route is
 * selected and the alternates are recorded but never promoted.
 */
export function decideRoute(input: RouteDecisionInput): RouteDecisionV1 {
	const reasonCodes: string[] = [];
	const admissible = input.candidates.filter((entry) => entry.rejection === null);
	const rejectedCount = input.candidates.length - admissible.length;
	if (rejectedCount > 0) reasonCodes.push(`hard-filter-rejected-${rejectedCount}`);

	const scale = routeScoreScale(admissible.map((entry) => entry.estimate));
	const clearing = admissible.filter((entry) => clearsPostureFloors(entry.estimate, input.posture));
	if (clearing.length < admissible.length) {
		reasonCodes.push(`posture-floor-excluded-${admissible.length - clearing.length}`);
	}
	if (clearing.length === 0 && admissible.length > 0) {
		reasonCodes.push("posture-floors-unsatisfiable");
		// Shadow reports the failed floor without changing execution. Active mode
		// must fail closed instead of reviving a merely hard-admissible route.
		if (input.mode === "active") throw new Error("route decision: posture-floors-unsatisfiable");
	}
	const selectable = clearing.length > 0 ? clearing : admissible;

	// Approval order is the caller's enumeration order, with the resolved route
	// first, so it is the stable tie-break the comparator needs.
	const approvalOrder = new Map(input.candidates.map((entry, index) => [routeCandidateKey(entry.candidate), index]));
	const ranked = selectable
		.map((entry) => {
			const key = routeCandidateKey(entry.candidate);
			return {
				entry,
				ranked: {
					key,
					order: approvalOrder.get(key) ?? input.candidates.length,
					estimate: entry.estimate,
					score: scoreRoute(entry.estimate, input.posture, scale),
				},
			};
		})
		.sort((left, right) => compareRankedRoutes(left.ranked, right.ranked));

	const dominatedKeys = new Set<string>();
	for (const outer of admissible) {
		for (const inner of admissible) {
			if (inner === outer) continue;
			if (dominatesRoute(inner.estimate, outer.estimate)) {
				dominatedKeys.add(routeCandidateKey(outer.candidate));
				break;
			}
		}
	}

	const scores = new Map(ranked.map((entry) => [entry.ranked.key, entry.ranked.score]));
	const candidateEvaluations: CandidateEvaluation[] = input.candidates.map((entry) => {
		const key = routeCandidateKey(entry.candidate);
		return {
			candidate: { ...entry.candidate },
			estimate: { ...entry.estimate },
			rejection: entry.rejection,
			score: entry.rejection === null ? (scores.get(key) ?? null) : null,
			dominated: entry.rejection === null && dominatedKeys.has(key),
		};
	});

	const executedKey = routeCandidateKey(input.executedRoute);
	const executedAdmissible = admissible.some((entry) => routeCandidateKey(entry.candidate) === executedKey);
	const manual = input.posture === "manual";
	const best = ranked[0]?.entry.candidate;
	const selected = manual || best === undefined ? { ...input.executedRoute } : { ...best };
	if (manual) reasonCodes.push("manual-posture-exact-route");
	if (best === undefined) reasonCodes.push("no-admissible-candidate");
	if (!executedAdmissible) reasonCodes.push("executed-route-not-admissible");
	if (input.mode === "shadow") reasonCodes.push("shadow-advisory-only");
	if (input.mode !== "active" && best !== undefined && routeCandidateKey(selected) !== executedKey) {
		reasonCodes.push("shadow-differs-from-executed");
	}

	const selectedKey = routeCandidateKey(selected);
	const approvedFallbacks: RouteCandidate[] = [];
	if (!manual) {
		for (const entry of ranked) {
			if (approvedFallbacks.length >= Math.max(0, input.maxFallbacks)) break;
			if (entry.ranked.key === selectedKey) continue;
			approvedFallbacks.push({ ...entry.entry.candidate });
		}
	}

	const selectedEstimate = candidateEvaluations.find(
		(evaluation) => routeCandidateKey(evaluation.candidate) === selectedKey,
	)?.estimate;
	const coldShare =
		admissible.length === 0
			? 1
			: admissible.filter((entry) => entry.estimate.sampleCount === 0).length / admissible.length;
	const confidence = Math.max(0, Math.min(1, (selectedEstimate?.confidence ?? 0) * (1 - coldShare) + coldShare * 0));

	return {
		policyVersion: ROUTE_POLICY_VERSION,
		mode: input.mode,
		posture: input.posture,
		selected,
		approvedFallbacks,
		hardConstraints: [...input.hardConstraints],
		candidateEvaluations,
		reasonCodes,
		decisionDurationMs: input.decisionDurationMs,
		confidence,
		decisionHash: routeDecisionHash(input),
		executedRoute: { ...input.executedRoute },
	};
}

/**
 * Failure-isolated production fallback. Observation cannot make a receipt lose
 * its routing evidence, so callers seal this exact one-candidate decision when
 * the shadow observer or its durable inputs fail.
 */
export function fixedRouteDecision(
	executedRoute: RouteCandidate,
	reasonCode = "observer-failure-fixed-route",
): RouteDecisionV1 {
	const input: RouteDecisionInput = {
		mode: "fixed",
		posture: "manual",
		executedRoute,
		candidates: [{ candidate: executedRoute, estimate: estimateRoute([], DEFAULT_ROUTE_PRIOR), rejection: null }],
		hardConstraints: ["fixed-executed-route"],
		maxFallbacks: 0,
		decisionDurationMs: 0,
	};
	const decision = decideRoute(input);
	return { ...decision, reasonCodes: [...decision.reasonCodes, reasonCode] };
}

// ---------------------------------------------------------------------------
// Decision evaluation, computed from a stored decision and its settled receipt
// ---------------------------------------------------------------------------

/**
 * What the run actually did, read back off its own receipt. Every field here
 * exists on a sealed receipt, which is what lets an offline replay reproduce
 * the metrics below without the process that made the decision.
 */
export interface RouteRealizedOutcome {
	route: RouteCandidate;
	outcome: string;
	qualityLabel: "pass" | "fail" | "unmeasured";
	/** True when the assignment's first attempt is the one that settled it. */
	firstPass: boolean;
	/** Zero-based attempt index of the settling run. */
	attempt: number;
	costUsd: number;
	endToEndMs: number;
}

/**
 * Distance between the operating point the policy chose and the one that ran.
 * Zero regret means the executed route was the policy's own pick. Regret is
 * measured against the decision's own recorded estimates, never against a
 * re-estimation, so it is stable under replay.
 */
export interface RouteRegret {
	/** Selected score minus executed score. Zero when they are the same route. */
	score: number;
	/** Selected expected cost minus executed expected cost; negative means the executed route was cheaper. */
	expectedCostUsd: number;
	expectedLatencyMs: number;
	/** True when the executed route was dominated by an admissible alternate. */
	executedOffFrontier: boolean;
	/** True when the policy would have run a different route. */
	routeDiffered: boolean;
}

function evaluationFor(decision: RouteDecisionV1, candidate: RouteCandidate): CandidateEvaluation | undefined {
	const key = routeCandidateKey(candidate);
	return decision.candidateEvaluations.find((evaluation) => routeCandidateKey(evaluation.candidate) === key);
}

export function routeRegret(decision: RouteDecisionV1): RouteRegret {
	const selected = evaluationFor(decision, decision.selected);
	const executed = evaluationFor(decision, decision.executedRoute);
	return {
		score: (selected?.score ?? 0) - (executed?.score ?? 0),
		expectedCostUsd: (selected?.estimate.expectedCostUsd ?? 0) - (executed?.estimate.expectedCostUsd ?? 0),
		expectedLatencyMs: (selected?.estimate.expectedEndToEndMs ?? 0) - (executed?.estimate.expectedEndToEndMs ?? 0),
		executedOffFrontier: executed?.dominated ?? false,
		routeDiffered: !sameRouteIdentity(decision.selected, decision.executedRoute),
	};
}

/**
 * Did the decision respect its own hard constraints? This is the check that
 * replaces "did Clio dispatch to the agent it was asked for", which was true by
 * construction and therefore measured nothing.
 */
export interface RouteConstraintValidity {
	selectedAdmissible: boolean;
	executedAdmissible: boolean;
	fallbacksAdmissible: boolean;
	/** True when all three hold, which is the invariant the router must never break. */
	valid: boolean;
}

export function routeConstraintValidity(decision: RouteDecisionV1): RouteConstraintValidity {
	const admissible = (candidate: RouteCandidate): boolean => evaluationFor(decision, candidate)?.rejection === null;
	const selectedAdmissible = admissible(decision.selected);
	const executedAdmissible = admissible(decision.executedRoute);
	const fallbacksAdmissible = decision.approvedFallbacks.every(admissible);
	return {
		selectedAdmissible,
		executedAdmissible,
		fallbacksAdmissible,
		valid: selectedAdmissible && executedAdmissible && fallbacksAdmissible,
	};
}

/**
 * How wrong the estimate for the route that actually ran turned out to be.
 * Ratios are reported alongside absolute errors because a $0.01 miss on a $0.02
 * route and a $0.01 miss on a $5 route are not the same kind of wrong.
 */
export interface RoutePredictionCalibration {
	costErrorUsd: number;
	costRatio: number;
	latencyErrorMs: number;
	latencyRatio: number;
	/** Squared error of the quality estimate against a measured label; null when unmeasured. */
	qualityBrier: number | null;
	firstPassBrier: number;
	/** Samples that backed the executed route's estimate at decision time. */
	sampleCount: number;
}

function ratio(actual: number, expected: number): number {
	if (expected === 0) return actual === 0 ? 1 : Number.POSITIVE_INFINITY;
	return actual / expected;
}

export function routePredictionCalibration(
	decision: RouteDecisionV1,
	realized: RouteRealizedOutcome,
): RoutePredictionCalibration {
	const executed = evaluationFor(decision, realized.route);
	const estimate = executed?.estimate;
	const quality = realized.qualityLabel === "unmeasured" ? null : realized.qualityLabel === "pass" ? 1 : 0;
	const firstPass = realized.firstPass ? 1 : 0;
	return {
		costErrorUsd: realized.costUsd - (estimate?.expectedCostUsd ?? 0),
		costRatio: ratio(realized.costUsd, estimate?.expectedCostUsd ?? 0),
		latencyErrorMs: realized.endToEndMs - (estimate?.expectedEndToEndMs ?? 0),
		latencyRatio: ratio(realized.endToEndMs, estimate?.expectedEndToEndMs ?? 0),
		qualityBrier: quality === null ? null : (quality - (estimate?.qualityMean ?? 0)) ** 2,
		firstPassBrier: (firstPass - (estimate?.firstPassSuccessProbability ?? 0)) ** 2,
		sampleCount: estimate?.sampleCount ?? 0,
	};
}

/** What the run produced, independent of what any router predicted. */
export interface RouteOutcomeMetrics {
	outcome: string;
	qualityLabel: "pass" | "fail" | "unmeasured";
	firstPass: boolean;
	escalated: boolean;
	attempts: number;
	costUsd: number;
	endToEndMs: number;
}

export function routeOutcomeMetrics(realized: RouteRealizedOutcome): RouteOutcomeMetrics {
	return {
		outcome: realized.outcome,
		qualityLabel: realized.qualityLabel,
		firstPass: realized.firstPass,
		escalated: realized.attempt > 0,
		attempts: realized.attempt + 1,
		costUsd: realized.costUsd,
		endToEndMs: realized.endToEndMs,
	};
}

/** The four evaluation families for one settled decision, in one record. */
export interface RouteEvaluation {
	regret: RouteRegret;
	validity: RouteConstraintValidity;
	calibration: RoutePredictionCalibration;
	outcome: RouteOutcomeMetrics;
}

export function evaluateRouteDecision(decision: RouteDecisionV1, realized: RouteRealizedOutcome): RouteEvaluation {
	return {
		regret: routeRegret(decision),
		validity: routeConstraintValidity(decision),
		calibration: routePredictionCalibration(decision, realized),
		outcome: routeOutcomeMetrics(realized),
	};
}
