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
import { isAgentCapabilityClass } from "../agents/spec.js";
import type { AgentCandidateEvaluation, AgentRoleReadinessReport } from "./agent-candidates.js";
import {
	type ExecutionRole,
	gateRouteCorrelation,
	isExecutionRole,
	type RouteCorrelationFacts,
} from "./execution-role.js";
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
import { evaluateRouteReadiness, type RouteReadinessReport } from "./route-readiness.js";

function routeCorrelationFacts(candidate: RouteCandidate): RouteCorrelationFacts {
	return {
		agentId: candidate.agentId,
		targetId: candidate.targetId,
		wireModelId: candidate.modelId,
		runtimeId: candidate.runtimeId,
		nodeId: candidate.nodeId,
	};
}

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

export type AgentSelectionAuthorityBasis = "operator-plan-approval" | "full-auto-policy";

export interface RouteDecisionAgentSelectionInput {
	request: "explicit" | "auto";
	baselineAgentId: string;
	evaluations: ReadonlyArray<AgentCandidateEvaluation>;
	readiness: ReadonlyArray<AgentRoleReadinessReport>;
	authorityBasis: AgentSelectionAuthorityBasis | null;
}

export interface RouteDecisionAgentSelection {
	request: "explicit" | "auto";
	activation: "shadow" | "active";
	baselineAgentId: string;
	recommendedAgentId: string;
	evaluations: AgentCandidateEvaluation[];
	readiness: AgentRoleReadinessReport[];
	/** Input authority provenance is retained even when no transition was selected, so replay can reproduce the hash. */
	authorityBasis: AgentSelectionAuthorityBasis | null;
	authorityTransition: null | {
		from: string;
		to: string;
		basis: "same-authority" | AgentSelectionAuthorityBasis;
	};
}

function exactKeys(value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean {
	return Object.keys(value).sort().join("\u0000") === [...keys].sort().join("\u0000");
}

function decisionRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const READINESS_GAPS = new Set([
	"hard-constraint-validity-below-one",
	"integrity-failures-in-window",
	"insufficient-quality-labels",
	"quality-lower-bound-below-posture-floor",
	"quality-lower-bound-below-requested-minimum",
	"reliability-below-posture-floor",
	"cost-upper-bound-unknown",
	"route-facts-stale",
	"decision-latency-above-budget",
]);

function decisionRouteCandidate(value: unknown): value is RouteCandidate {
	if (!decisionRecord(value)) return false;
	const required = [
		"agentId",
		"specFingerprint",
		"executionRole",
		"targetId",
		"modelId",
		"runtimeId",
		"nodeId",
		"toolSignature",
		"promptCompositionHash",
		"endpointIdentityHash",
		"settingsFingerprint",
	];
	const keys = Object.keys(value);
	if (keys.some((key) => !required.includes(key) && key !== "thinkingLevel")) return false;
	if (required.some((key) => !Object.hasOwn(value, key))) return false;
	return (
		isExecutionRole(value.executionRole) &&
		required
			.filter((key) => key !== "executionRole")
			.every((key) => typeof value[key] === "string" && String(value[key]).length > 0) &&
		(value.thinkingLevel === undefined || (typeof value.thinkingLevel === "string" && value.thinkingLevel.length > 0))
	);
}

function decisionReadinessReport(value: unknown): value is RouteReadinessReport {
	if (!decisionRecord(value) || !exactKeys(value, ["ready", "gaps", "labelsNeeded"])) return false;
	return (
		typeof value.ready === "boolean" &&
		Array.isArray(value.gaps) &&
		value.gaps.length <= READINESS_GAPS.size &&
		value.gaps.every((gap) => typeof gap === "string" && READINESS_GAPS.has(gap)) &&
		new Set(value.gaps).size === value.gaps.length &&
		value.ready === (value.gaps.length === 0) &&
		Number.isInteger(value.labelsNeeded) &&
		Number(value.labelsNeeded) >= 0
	);
}

/** Strict validator for the required agent-selection evidence sealed in decisions and approvals. */
export function isRouteDecisionAgentSelection(value: unknown): value is RouteDecisionAgentSelection {
	if (!decisionRecord(value)) return false;
	if (
		!exactKeys(value, [
			"request",
			"activation",
			"baselineAgentId",
			"recommendedAgentId",
			"evaluations",
			"readiness",
			"authorityBasis",
			"authorityTransition",
		]) ||
		(value.request !== "explicit" && value.request !== "auto") ||
		(value.activation !== "shadow" && value.activation !== "active") ||
		typeof value.baselineAgentId !== "string" ||
		value.baselineAgentId.length === 0 ||
		typeof value.recommendedAgentId !== "string" ||
		value.recommendedAgentId.length === 0 ||
		(value.authorityBasis !== null &&
			value.authorityBasis !== "operator-plan-approval" &&
			value.authorityBasis !== "full-auto-policy") ||
		!Array.isArray(value.evaluations) ||
		value.evaluations.length === 0 ||
		value.evaluations.length > 64 ||
		!Array.isArray(value.readiness) ||
		value.readiness.length === 0 ||
		value.readiness.length > 64
	)
		return false;
	const priorKeys = [
		"qualityMean",
		"firstPassSuccessProbability",
		"costUpperBoundUsd",
		"expectedEndToEndMs",
		"reliability",
		"queueWaitMs",
	];
	if (
		!value.evaluations.every((entry) => {
			if (
				!decisionRecord(entry) ||
				!exactKeys(entry, [
					"agentId",
					"specFingerprint",
					"executionRole",
					"authority",
					"rejections",
					"coldPrior",
					"priorReasons",
				])
			)
				return false;
			const prior = entry.coldPrior;
			if (
				typeof entry.agentId !== "string" ||
				entry.agentId.length === 0 ||
				typeof entry.specFingerprint !== "string" ||
				entry.specFingerprint.length === 0 ||
				!isExecutionRole(entry.executionRole) ||
				!isAgentCapabilityClass(entry.authority) ||
				!Array.isArray(entry.rejections) ||
				entry.rejections.length > 64 ||
				!entry.rejections.every((reason) => typeof reason === "string") ||
				!Array.isArray(entry.priorReasons) ||
				entry.priorReasons.length > 64 ||
				!entry.priorReasons.every((reason) => typeof reason === "string") ||
				!decisionRecord(prior) ||
				!exactKeys(prior, priorKeys) ||
				!priorKeys.every((key) => typeof prior[key] === "number" && Number.isFinite(prior[key]))
			)
				return false;
			return true;
		})
	)
		return false;
	if (
		!value.readiness.every((entry) => {
			if (
				!decisionRecord(entry) ||
				!exactKeys(entry, [
					"agentId",
					"specFingerprint",
					"executionRole",
					"ready",
					"candidateCount",
					"readyCandidateCount",
					"routes",
				])
			)
				return false;
			if (
				!Array.isArray(entry.routes) ||
				entry.routes.length === 0 ||
				entry.routes.length > 64 ||
				!entry.routes.every(
					(route) =>
						decisionRecord(route) &&
						exactKeys(route, ["candidate", "report"]) &&
						decisionRouteCandidate(route.candidate) &&
						decisionReadinessReport(route.report) &&
						route.candidate.agentId === entry.agentId &&
						route.candidate.specFingerprint === entry.specFingerprint &&
						route.candidate.executionRole === entry.executionRole,
				)
			)
				return false;
			const readyCandidateCount = entry.routes.filter(
				(route) => decisionRecord(route) && decisionRecord(route.report) && route.report.ready === true,
			).length;
			return (
				typeof entry.agentId === "string" &&
				entry.agentId.length > 0 &&
				typeof entry.specFingerprint === "string" &&
				entry.specFingerprint.length > 0 &&
				isExecutionRole(entry.executionRole) &&
				typeof entry.ready === "boolean" &&
				Number.isInteger(entry.candidateCount) &&
				Number(entry.candidateCount) === entry.routes.length &&
				Number.isInteger(entry.readyCandidateCount) &&
				Number(entry.readyCandidateCount) === readyCandidateCount &&
				entry.ready === readyCandidateCount > 0
			);
		})
	)
		return false;
	if (value.authorityTransition !== null) {
		const transition = value.authorityTransition;
		if (
			!decisionRecord(transition) ||
			!exactKeys(transition, ["from", "to", "basis"]) ||
			typeof transition.from !== "string" ||
			transition.from.length === 0 ||
			typeof transition.to !== "string" ||
			transition.to.length === 0 ||
			(transition.basis !== "same-authority" &&
				transition.basis !== "operator-plan-approval" &&
				transition.basis !== "full-auto-policy")
		) {
			return false;
		}
		if (
			value.request !== "auto" ||
			value.activation !== "active" ||
			transition.from !== value.baselineAgentId ||
			transition.to !== value.recommendedAgentId
		)
			return false;
		const from = value.evaluations.find((entry) => entry.agentId === transition.from);
		const to = value.evaluations.find((entry) => entry.agentId === transition.to);
		if (from === undefined || to === undefined) return false;
		if (transition.basis === "same-authority") {
			if (from.authority !== to.authority) return false;
		} else if (transition.basis !== value.authorityBasis) return false;
	}
	return (
		(value.request !== "explicit" || value.authorityBasis === null) &&
		new Set(
			value.evaluations.map((entry) => `${entry.agentId}\u0000${entry.specFingerprint}\u0000${entry.executionRole}`),
		).size === value.evaluations.length &&
		value.evaluations.some((entry) => entry.agentId === value.baselineAgentId) &&
		value.evaluations.some((entry) => entry.agentId === value.recommendedAgentId)
	);
}

export interface CandidateEvaluation {
	candidate: RouteCandidate;
	estimate: RouteEstimate;
	/** Exact prerequisite report used by active admission for this tuple. */
	activeReadiness: RouteReadinessReport;
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
	/** Required agent hard-filter, prior, readiness, and authority explanation. */
	agentSelection: RouteDecisionAgentSelection;
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
	activeReadiness: RouteReadinessReport;
	rejection: string | null;
}

export interface RouteDecisionInput {
	mode: RouteDecisionMode;
	posture: RoutingPosture;
	/** The route the production pipeline resolved and is executing. */
	executedRoute: RouteCandidate;
	/** Every enumerated tuple with its hard-filter verdict; order is the caller's approval order. */
	candidates: ReadonlyArray<RouteCandidateInput>;
	/** Builder route being judged or reviewed, for the post-filter independence tie-break. */
	independenceSubject: RouteCorrelationFacts | null;
	/** Names of the hard constraints the caller applied, for the explanation. */
	hardConstraints: ReadonlyArray<string>;
	/** Envelope width; the selected route does not count against it. */
	maxFallbacks: number;
	/** Measured resolver duration. Excluded from the hash: it is not an input. */
	decisionDurationMs: number;
	agentSelection: RouteDecisionAgentSelectionInput;
}

/**
 * The dimensions history aggregates over: what the route can do, not how this
 * particular run was worded or configured. Two candidates with equal capability
 * keys are the same route for the purpose of accumulating quality evidence.
 *
 * Editing the session prompt or an unrelated settings key must not restart the
 * evidence count for an unchanged agent, model, runtime, and node. Measured on
 * real history, prompt-composition edits alone sharded 28 observations into
 * buckets no larger than four, which no posture floor can ever clear.
 */
export function routeCapabilityKey(candidate: RouteCandidate): string {
	return [
		candidate.agentId,
		candidate.specFingerprint,
		candidate.executionRole,
		candidate.targetId,
		candidate.modelId,
		candidate.runtimeId,
		candidate.nodeId,
		candidate.thinkingLevel ?? "",
	].join("\u0000");
}

/**
 * The remaining identity dimensions. They are sealed on every observation so
 * offline replay reconstructs exactly which prompt and settings produced it,
 * and they are checked for staleness, but they do not create parallel buckets.
 */
export interface RouteDriftGuard {
	promptCompositionHash: string;
	settingsFingerprint: string;
	toolSignature: string;
	endpointIdentityHash: string;
}

export function routeDriftGuard(candidate: RouteCandidate): RouteDriftGuard {
	return {
		promptCompositionHash: candidate.promptCompositionHash,
		settingsFingerprint: candidate.settingsFingerprint,
		toolSignature: candidate.toolSignature,
		endpointIdentityHash: candidate.endpointIdentityHash,
	};
}

/**
 * Whether drift between an observation and the route being estimated makes that
 * observation stale. The rule is deliberately written out rather than folded
 * into a hash, because which drift matters is a judgement and a hash hides it.
 *
 * Invalidating, because the route no longer does the same work:
 *
 * - `toolSignature`. An agent that gained or lost a tool solves a different
 *   problem. Evidence from the old surface does not describe the new one.
 * - `endpointIdentityHash`. The target id is stable but the URL behind it moved,
 *   so the observations describe some other physical service.
 *
 * Not invalidating, because the route behaves the same:
 *
 * - `promptCompositionHash`. Session-prompt and skill-framing wording. It
 *   changes what the model is told, not what the route is capable of, and it
 *   changes on nearly every release.
 * - `settingsFingerprint`. It covers the whole settings snapshot, almost all of
 *   which is unrelated to this route. Every part of settings that does change
 *   this route's behavior is already in the capability key or in one of the two
 *   invalidating guards above, so treating the whole fingerprint as drift only
 *   discards evidence for edits to unrelated targets.
 */
export function routeDriftInvalidates(observed: RouteDriftGuard, current: RouteDriftGuard): boolean {
	return (
		observed.toolSignature !== current.toolSignature || observed.endpointIdentityHash !== current.endpointIdentityHash
	);
}

/** Exact identity of a tuple. Two candidates with equal keys are the same route. */
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
function promptCompositionIdentity(identity: RouteIdentityInput, role: RouteRoleInput): string {
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

function hashNumber(value: number): number {
	if (!Number.isFinite(value)) throw new Error(`route decision: non-finite number ${String(value)}`);
	// Estimates are floats derived from division; a fixed precision keeps the
	// hash stable against the last bits of otherwise-equal computations.
	return Number(value.toFixed(9));
}

function estimateHashProjection(estimate: RouteEstimate): ReadonlyArray<number> {
	return [
		hashNumber(estimate.qualityLabeledCount),
		hashNumber(estimate.unmeasuredCount),
		hashNumber(estimate.qualityCoverage),
		hashNumber(estimate.qualityMean),
		hashNumber(estimate.qualityLowerBound),
		hashNumber(estimate.firstPassSuccessProbability),
		hashNumber(estimate.expectedCostUsd),
		hashNumber(estimate.costUpperBoundUsd),
		hashNumber(estimate.expectedEndToEndMs),
		hashNumber(estimate.p95EndToEndMs),
		hashNumber(estimate.reliability),
		hashNumber(estimate.cacheHitProbability),
		hashNumber(estimate.queueWaitMs),
		hashNumber(estimate.sampleCount),
		hashNumber(estimate.confidence),
	];
}

function readinessHashProjection(report: RouteReadinessReport): readonly [boolean, ReadonlyArray<string>, number] {
	return [report.ready, report.gaps, hashNumber(report.labelsNeeded)];
}

/**
 * The hash covers exactly the decision's inputs: policy version, mode, posture,
 * the executed route, the enumerated candidates with their estimates and
 * verdicts, the declared hard constraints, and the envelope width. It excludes
 * `decisionDurationMs`, which is a measurement of the decision rather than an
 * input to it, so a replay on a faster machine still reproduces the hash.
 */
function routeDecisionHash(input: RouteDecisionInput): string {
	// Arrays give every field an explicit position, so native JSON serialization
	// is deterministic without recursively sorting hundreds of short-lived
	// objects at the maximum universe bound. Candidate identity uses the same
	// exact-route key as admission, ranking, and fallback selection.
	const candidates = input.candidates.map((entry) => [
		routeCandidateKey(entry.candidate),
		estimateHashProjection(entry.estimate),
		readinessHashProjection(entry.activeReadiness),
		entry.rejection,
	]);
	const agentSelection = [
		input.agentSelection.request,
		input.agentSelection.baselineAgentId,
		input.agentSelection.evaluations.map((entry) => [
			entry.agentId,
			entry.specFingerprint,
			entry.executionRole,
			entry.authority,
			entry.rejections,
			[
				hashNumber(entry.coldPrior.qualityMean),
				hashNumber(entry.coldPrior.firstPassSuccessProbability),
				hashNumber(entry.coldPrior.costUpperBoundUsd),
				hashNumber(entry.coldPrior.expectedEndToEndMs),
				hashNumber(entry.coldPrior.reliability),
				hashNumber(entry.coldPrior.queueWaitMs),
			],
			entry.priorReasons,
		]),
		input.agentSelection.readiness.map((entry) => [
			entry.agentId,
			entry.specFingerprint,
			entry.executionRole,
			entry.ready,
			hashNumber(entry.candidateCount),
			hashNumber(entry.readyCandidateCount),
			entry.routes.map((route) => [routeCandidateKey(route.candidate), readinessHashProjection(route.report)]),
		]),
		input.agentSelection.authorityBasis,
	];
	const independenceSubject =
		input.independenceSubject === null
			? null
			: [
					input.independenceSubject.agentId,
					input.independenceSubject.targetId,
					input.independenceSubject.wireModelId,
					input.independenceSubject.runtimeId,
					input.independenceSubject.nodeId,
				];
	return createHash("sha256")
		.update(
			JSON.stringify([
				ROUTE_POLICY_VERSION,
				input.mode,
				input.posture,
				routeCandidateKey(input.executedRoute),
				candidates,
				independenceSubject,
				agentSelection,
				input.hardConstraints,
				hashNumber(input.maxFallbacks),
			]),
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
	const candidateKeys = new Map(input.candidates.map((entry) => [entry, routeCandidateKey(entry.candidate)]));
	const candidateKey = (entry: RouteCandidateInput): string => candidateKeys.get(entry) as string;
	const hardAdmissible = input.candidates.filter((entry) => entry.rejection === null);
	const rejectedCount = input.candidates.length - hardAdmissible.length;
	if (rejectedCount > 0) reasonCodes.push(`hard-filter-rejected-${rejectedCount}`);
	const readinessExcluded =
		input.mode === "active" ? hardAdmissible.filter((entry) => !entry.activeReadiness.ready).length : 0;
	if (readinessExcluded > 0) reasonCodes.push(`active-readiness-excluded-${readinessExcluded}`);
	const admissible =
		input.mode === "active" ? hardAdmissible.filter((entry) => entry.activeReadiness.ready) : hardAdmissible;

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
	const approvalOrder = new Map(input.candidates.map((entry, index) => [candidateKey(entry), index]));
	const ranked = selectable
		.map((entry) => {
			const key = candidateKey(entry);
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
		.sort((left, right) => {
			const policyOrder = compareRankedRoutes(
				{ ...left.ranked, key: "", order: 0 },
				{ ...right.ranked, key: "", order: 0 },
			);
			if (policyOrder !== 0) return policyOrder;
			if (
				input.independenceSubject !== null &&
				(input.executedRoute.executionRole === "reviewer" || input.executedRoute.executionRole === "judge")
			) {
				const leftIndependent = gateRouteCorrelation(
					input.independenceSubject,
					routeCorrelationFacts(left.entry.candidate),
				).independent;
				const rightIndependent = gateRouteCorrelation(
					input.independenceSubject,
					routeCorrelationFacts(right.entry.candidate),
				).independent;
				if (leftIndependent !== rightIndependent) return leftIndependent ? -1 : 1;
			}
			return compareRankedRoutes(left.ranked, right.ranked);
		});

	const dominatedKeys = new Set<string>();
	for (const outer of admissible) {
		for (const inner of admissible) {
			if (inner === outer) continue;
			if (dominatesRoute(inner.estimate, outer.estimate)) {
				dominatedKeys.add(candidateKey(outer));
				break;
			}
		}
	}

	const scores = new Map(ranked.map((entry) => [entry.ranked.key, entry.ranked.score]));
	const candidateEvaluations: CandidateEvaluation[] = input.candidates.map((entry) => {
		const key = candidateKey(entry);
		return {
			candidate: { ...entry.candidate },
			estimate: { ...entry.estimate },
			activeReadiness: { ...entry.activeReadiness, gaps: [...entry.activeReadiness.gaps] },
			rejection: entry.rejection,
			score: entry.rejection === null ? (scores.get(key) ?? null) : null,
			dominated: entry.rejection === null && dominatedKeys.has(key),
		};
	});

	const executedKey = routeCandidateKey(input.executedRoute);
	const executedAdmissible = admissible.some((entry) => candidateKey(entry) === executedKey);
	const manual = input.posture === "manual";
	const best = ranked[0]?.entry.candidate;
	if (input.mode === "active" && best === undefined) {
		const gaps = hardAdmissible.flatMap((entry) => entry.activeReadiness.gaps);
		const detail = [...new Set(gaps)].join(", ") || "no-hard-admissible-candidate";
		throw new Error(`route decision: no-active-eligible-candidate (${detail})`);
	}
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
	const recommendedAgentId = best?.agentId ?? input.agentSelection.baselineAgentId;
	let authorityTransition: RouteDecisionAgentSelection["authorityTransition"] = null;
	if (input.mode === "active" && selected.agentId !== input.agentSelection.baselineAgentId) {
		if (input.agentSelection.request !== "auto") {
			throw new Error("route decision: explicit agent selection cannot change authority");
		}
		const from = input.agentSelection.evaluations.find(
			(evaluation) => evaluation.agentId === input.agentSelection.baselineAgentId,
		)?.authority;
		const to = input.agentSelection.evaluations.find((evaluation) => evaluation.agentId === selected.agentId)?.authority;
		const basis =
			from !== undefined && to !== undefined && from === to ? "same-authority" : input.agentSelection.authorityBasis;
		if (basis === null) throw new Error("route decision: active agent authority transition lacks trusted approval");
		authorityTransition = { from: input.agentSelection.baselineAgentId, to: selected.agentId, basis };
	}

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
		agentSelection: {
			request: input.agentSelection.request,
			activation: input.mode === "active" ? "active" : "shadow",
			baselineAgentId: input.agentSelection.baselineAgentId,
			recommendedAgentId,
			evaluations: structuredClone([...input.agentSelection.evaluations]),
			readiness: structuredClone([...input.agentSelection.readiness]),
			authorityBasis: input.agentSelection.authorityBasis,
			authorityTransition,
		},
		decisionHash: routeDecisionHash({
			...input,
			executedRoute: input.mode === "active" ? selected : input.executedRoute,
		}),
		executedRoute: { ...(input.mode === "active" ? selected : input.executedRoute) },
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
	const estimate = estimateRoute([], DEFAULT_ROUTE_PRIOR);
	const activeReadiness = evaluateRouteReadiness({
		estimate,
		posture: "manual",
		hardConstraintValidity: 1,
		integrityFailures: 0,
		costUpperBoundUsd: null,
		factsFresh: false,
		decisionP95Ms: Number.POSITIVE_INFINITY,
		requestedMinimumQuality: null,
	});
	const input: RouteDecisionInput = {
		mode: "fixed",
		posture: "manual",
		executedRoute,
		candidates: [
			{
				candidate: executedRoute,
				estimate,
				activeReadiness,
				rejection: null,
			},
		],
		independenceSubject: null,
		hardConstraints: ["fixed-executed-route"],
		maxFallbacks: 0,
		decisionDurationMs: 0,
		agentSelection: {
			request: "explicit",
			baselineAgentId: executedRoute.agentId,
			evaluations: [
				{
					agentId: executedRoute.agentId,
					specFingerprint: executedRoute.specFingerprint,
					executionRole: executedRoute.executionRole,
					authority: "internal",
					rejections: [],
					coldPrior: { ...DEFAULT_ROUTE_PRIOR },
					priorReasons: ["fixed-route"],
				},
			],
			readiness: [
				{
					agentId: executedRoute.agentId,
					specFingerprint: executedRoute.specFingerprint,
					executionRole: executedRoute.executionRole,
					ready: activeReadiness.ready,
					candidateCount: 1,
					readyCandidateCount: activeReadiness.ready ? 1 : 0,
					routes: [{ candidate: { ...executedRoute }, report: { ...activeReadiness, gaps: [...activeReadiness.gaps] } }],
				},
			],
			authorityBasis: null,
		},
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

function routeRegret(decision: RouteDecisionV1): RouteRegret {
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

function routePredictionCalibration(
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

function routeOutcomeMetrics(realized: RouteRealizedOutcome): RouteOutcomeMetrics {
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
