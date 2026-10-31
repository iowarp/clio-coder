/**
 * Route observer (shadow mode).
 *
 * The observer watches every dispatch, receives the shared RouteDecisionV1
 * the policy would have produced, journals it as `route.decided` in the
 * journal of the session or run that asked (#434). Route history is the
 * telemetry domain's fold over this host's run.settled records, which carry
 * the executed route; the observer reduces its quality and serves readiness
 * from it. Selection belongs to the resolver; this module only records the
 * route that shadow or active admission sealed.
 *
 * What it measures is deliberately not "did Clio dispatch to the agent it was
 * asked for". That comparison was true by construction, because the actual
 * agent is the one the caller requested, so it measured obedience rather than
 * route quality. It is replaced by the four families that do carry signal:
 * route regret, constraint validity, prediction calibration, and outcome.
 *
 * The bounded intent classifier below survives only as a cold-start agent
 * prior. It never contributes a hard constraint or durable raw task text.
 */

import type { TelemetryContext } from "../../core/telemetry/context.js";
import type { EventPayload } from "../../core/telemetry/events.js";
import { telemetryHub } from "../../core/telemetry/hub.js";
import { ROUTE_HARD_FILTERS, ROUTE_REASONS } from "../../core/telemetry/schemas.js";
import { clioStateDir } from "../../core/xdg.js";
import type { RouteHistoryEntry, RouteHistoryFold } from "../telemetry/index.js";
import { type AgentTaskType, classifyAgentTask } from "./agent-candidates.js";
import {
	createDurableQualitySourceCache,
	type DurableQualitySourceCache,
	type DurableQualitySources,
} from "./durable-quality-sources.js";
import {
	evaluateRouteDecision,
	fixedRouteDecision,
	type RouteCandidate,
	type RouteDecisionV1,
	type RouteEvaluation,
	type RouteRealizedOutcome,
	routeCandidateKey,
	routeCapabilityKey,
	routeDriftGuard,
	routeDriftInvalidates,
} from "./route-decision.js";
import type { RouteObservation } from "./route-policy.js";
import { type RouteQualityLabel, type RouteQualityReduction, reduceRouteQuality } from "./route-quality.js";
import type { RunResult } from "./types.js";

function receiptHasUnknownCost(receipt: RunResult): boolean {
	return (
		receipt.costSummary?.hasUnknown ?? (receipt.costProvenance === undefined || receipt.costProvenance === "unknown")
	);
}

// ---------------------------------------------------------------------------
// Route-history projection
// ---------------------------------------------------------------------------

/** The route identity a history entry was settled under, as the policy's candidate shape. */
function entryCandidate(entry: RouteHistoryEntry): RouteCandidate {
	const { thinkingLevel, ...rest } = entry.route;
	return { ...rest, ...(thinkingLevel !== null ? { thinkingLevel } : {}) };
}

/**
 * The estimator projection of one history entry. Only a verified, completed, non-quality-failed run contributes
 * cost or timing; an unverified run keeps its reliability and first-pass facts but no quality label (#434).
 */
function routeObservationFromEntry(entry: RouteHistoryEntry, qualityLabel: RouteQualityLabel): RouteObservation {
	const completed = entry.sealVerified && entry.reliability === "success" && qualityLabel !== "fail";
	const cost = entry.pricedCostUsd;
	return {
		qualityLabel,
		reliability: entry.reliability,
		firstPass: entry.firstPass,
		completedCostUsd: completed && (cost.kind === "measured" || cost.kind === "estimated") ? cost.value : null,
		completedEndToEndMs: completed ? entry.phaseTiming.totalEndToEndMs : null,
		cacheRead: entry.cacheRead,
		queueWaitMs: completed ? entry.phaseTiming.queueWaitMs : null,
	};
}

/**
 * Test-only estimator seam. Production always reads the route history fold
 * over run journals, so process restart cannot erase the policy's evidence window.
 */
export interface RouteSampleStore {
	samplesFor(candidate: RouteCandidate): ReadonlyArray<RouteObservation>;
	record(candidate: RouteCandidate, observation: RouteObservation): void;
}

// ---------------------------------------------------------------------------
// Learner: the four evaluation families, aggregated
// ---------------------------------------------------------------------------

const LEARNER_CAPACITY = 256;

export interface RouteEvaluationRecord {
	observationId: string;
	decision: RouteDecisionV1;
	realized: RouteRealizedOutcome;
	evaluation: RouteEvaluation;
}

export interface RouteObserverSummary {
	totalObservations: number;
	recordedOutcomes: number;
	/** Mean posture-score regret; 0 means the executed routes were the policy's own picks. */
	meanScoreRegret: number;
	/** Share of decisions whose executed route was dominated by an admissible alternate. */
	offFrontierRate: number;
	/** Share of decisions where the policy would have run a different route. */
	shadowDivergenceRate: number;
	/** Share of decisions that respected every hard constraint. Anything below 1 is a defect. */
	constraintValidityRate: number;
	/** Mean Brier score over measured quality labels; lower is better calibrated. */
	meanQualityBrier: number;
	/** Mean ratio of actual to estimated cost for the route that ran. */
	meanCostRatio: number;
	qualityPassRate: number;
	firstPassRate: number;
	escalationRate: number;
	taskTypeDistribution: Record<string, number>;
}

export interface RouteLearner {
	record(record: RouteEvaluationRecord, taskType: AgentTaskType): void;
	recent(limit?: number): RouteEvaluationRecord[];
	summary(totalObservations: number): RouteObserverSummary;
}

function meanOf(values: ReadonlyArray<number>): number {
	const finite = values.filter((value) => Number.isFinite(value));
	if (finite.length === 0) return 0;
	return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function rateOf(values: ReadonlyArray<boolean>): number {
	if (values.length === 0) return 0;
	return values.filter(Boolean).length / values.length;
}

function createRouteLearner(capacity = LEARNER_CAPACITY): RouteLearner {
	const buffer: RouteEvaluationRecord[] = [];
	const taskTypes: AgentTaskType[] = [];
	return {
		record(record, taskType) {
			buffer.push(record);
			taskTypes.push(taskType);
			if (buffer.length > capacity) {
				buffer.splice(0, buffer.length - capacity);
				taskTypes.splice(0, taskTypes.length - capacity);
			}
		},
		recent(limit) {
			const slice = limit !== undefined ? buffer.slice(-limit) : [...buffer];
			return slice.reverse();
		},
		summary(totalObservations) {
			const taskTypeDistribution: Record<string, number> = {};
			for (const taskType of taskTypes) {
				taskTypeDistribution[taskType] = (taskTypeDistribution[taskType] ?? 0) + 1;
			}
			const evaluations = buffer.map((record) => record.evaluation);
			return {
				totalObservations,
				recordedOutcomes: buffer.length,
				meanScoreRegret: meanOf(evaluations.map((evaluation) => evaluation.regret.score)),
				offFrontierRate: rateOf(evaluations.map((evaluation) => evaluation.regret.executedOffFrontier)),
				shadowDivergenceRate: rateOf(evaluations.map((evaluation) => evaluation.regret.routeDiffered)),
				constraintValidityRate: rateOf(evaluations.map((evaluation) => evaluation.validity.valid)),
				meanQualityBrier: meanOf(
					evaluations.flatMap((evaluation) =>
						evaluation.calibration.qualityBrier === null ? [] : [evaluation.calibration.qualityBrier],
					),
				),
				meanCostRatio: meanOf(evaluations.map((evaluation) => evaluation.calibration.costRatio)),
				qualityPassRate: rateOf(evaluations.map((evaluation) => evaluation.outcome.qualityLabel === "pass")),
				firstPassRate: rateOf(evaluations.map((evaluation) => evaluation.outcome.firstPass)),
				escalationRate: rateOf(evaluations.map((evaluation) => evaluation.outcome.escalated)),
				taskTypeDistribution,
			};
		},
	};
}

// ---------------------------------------------------------------------------
// Observer adapter (shadow mode, bounded JSONL)
// ---------------------------------------------------------------------------

export interface RouteObserveInput {
	task: string;
	/** Decision already produced by the shared joint resolver. */
	decision: RouteDecisionV1;
	/** The scope that asked for the route; the async context when absent (#434). */
	ctx?: TelemetryContext;
}

export interface RouteObservationHandle {
	id: string;
	/** The sealed decision, for the caller to fold onto its receipt. */
	decision: RouteDecisionV1;
}

export interface RouteObservedOutcome extends RouteRealizedOutcome {
	receipt: RunResult;
	quality: RouteQualityReduction;
	phaseTiming: { totalEndToEndMs: number | null; queueWaitMs: number | null } | undefined;
}

export interface RouteObserver {
	/** Register the sealed shadow or active decision for outcome observation. */
	observe(input: RouteObserveInput): RouteObservationHandle;
	/** Immutable evidence snapshot shared by every tuple in one joint resolution. */
	readinessWindow(): RouteReadinessEvidenceWindow;
	/** Evaluate the real terminal route outcome; the run's own run.settled is its durable record. */
	recordOutcome(observationId: string, outcome: RouteObservedOutcome): void;
	summary(): RouteObserverSummary;
}

export interface RouteReadinessEvidence {
	observations: ReadonlyArray<RouteObservation>;
	readiness: {
		hardConstraintValidity: number;
		integrityFailures: number;
		costUpperBoundUsd: number | null;
		factsFresh: boolean;
		decisionP95Ms: number;
	};
}

export interface RouteReadinessEvidenceWindow {
	forRoute(
		candidate: RouteCandidate,
		current: { costUpperBoundUsd: number | null; factsFresh: boolean },
	): RouteReadinessEvidence;
}

export interface CreateRouteObserverOptions {
	/** The route history fold to read; one over the state directory when absent. */
	history?: RouteHistoryFold;
	/** Test-only estimator input seam. Production does not use this store. */
	samples?: RouteSampleStore;
	/** Durable source directory override, primarily for restart/replay tests. */
	stateDir?: string;
}

/**
 * Identity of everything a history entry's quality reduction can read beyond
 * its own run. Gates are the only path by which another run matters,
 * so with no gate artifacts the key is empty and a reduction depends on the
 * subject alone.
 */
function gateEvidenceKey(sources: DurableQualitySources, serialOf: (value: object) => number): string {
	if (sources.gates.length === 0) return "";
	const referenced = new Set<string>();
	for (const gate of sources.gates) {
		for (const subject of gate.subjects) referenced.add(subject.runId);
		if (gate.decider !== undefined) referenced.add(gate.decider.runId);
	}
	const parts = sources.gates.map((gate) => `g${serialOf(gate)}`);
	for (const source of sources.runs) {
		if (referenced.has(source.runId)) parts.push(`r${serialOf(source)}`);
	}
	return parts.join(",");
}

type RouteTuple = EventPayload<"route.decided">["selected"];
function routeTuple(candidate: RouteCandidate): RouteTuple {
	return {
		agentId: candidate.agentId,
		executionRole: candidate.executionRole,
		targetId: candidate.targetId,
		modelId: candidate.modelId,
		runtimeId: candidate.runtimeId,
		nodeId: candidate.nodeId,
	};
}

function vocabularyValue<const T extends readonly string[]>(values: T, value: string): T[number] {
	return (values as readonly string[]).includes(value) ? (value as T[number]) : "unknown";
}

function finiteOrNull(value: number | null): number | null {
	return value !== null && Number.isFinite(value) ? value : null;
}

/**
 * The decision as `route.decided` carries it (#434). A rejection keeps its filter name and drops the filter's prose,
 * and a counted reason such as `hard-filter-rejected-3` keeps its count as a number.
 */
function routeDecidedFacts(decision: RouteDecisionV1): EventPayload<"route.decided"> {
	const executedKey = routeCandidateKey(decision.executedRoute);
	const executed = decision.candidateEvaluations.find(
		(evaluation) => routeCandidateKey(evaluation.candidate) === executedKey,
	);
	return {
		policyVersion: decision.policyVersion,
		mode: decision.mode,
		posture: decision.posture,
		decisionHash: decision.decisionHash,
		decisionDurationMs: Math.max(0, decision.decisionDurationMs),
		confidence: finiteOrNull(decision.confidence),
		selected: routeTuple(decision.selected),
		executed: routeTuple(decision.executedRoute),
		fallbacks: decision.approvedFallbacks.map(routeTuple),
		recommendedAgentId: decision.agentSelection.recommendedAgentId,
		candidates: decision.candidateEvaluations.map((evaluation) => ({
			route: routeTuple(evaluation.candidate),
			rejection:
				evaluation.rejection === null
					? null
					: vocabularyValue(ROUTE_HARD_FILTERS, evaluation.rejection.split(":", 1)[0]?.trim() ?? ""),
			score: finiteOrNull(evaluation.score),
			dominated: evaluation.dominated,
			samples: evaluation.estimate.sampleCount,
			ready: evaluation.activeReadiness.ready,
		})),
		reasons: decision.reasonCodes.map((code) => {
			const counted = /^(.*)-(\d+)$/.exec(code);
			return counted?.[1] !== undefined && counted[2] !== undefined
				? { code: vocabularyValue(ROUTE_REASONS, counted[1]), count: Number(counted[2]) }
				: { code: vocabularyValue(ROUTE_REASONS, code) };
		}),
		verdict: {
			differs: routeCandidateKey(decision.selected) !== executedKey,
			executedAdmissible: executed !== undefined && executed.rejection === null,
		},
	};
}

function percentile95(values: ReadonlyArray<number>): number {
	if (values.length === 0) return Number.POSITIVE_INFINITY;
	const ordered = [...values].sort((left, right) => left - right);
	return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

export function createRouteObserver(options: CreateRouteObserverOptions): RouteObserver {
	const learner = createRouteLearner();
	const samples = options.samples;
	const pending = new Map<string, { decision: RouteDecisionV1; taskType: AgentTaskType }>();
	const PENDING_LIMIT = 512;
	let totalObservations = 0;
	let sequence = 0;
	let qualitySources: DurableQualitySourceCache | undefined;
	const sourceCache = (): DurableQualitySourceCache => {
		qualitySources ??= createDurableQualitySourceCache({
			stateDir: options.stateDir ?? clioStateDir(),
			...(options.history !== undefined ? { history: options.history } : {}),
		});
		return qualitySources;
	};
	const serials = new WeakMap<object, number>();
	let nextSerial = 0;
	const serialOf = (value: object): number => {
		let serial = serials.get(value);
		if (serial === undefined) {
			nextSerial += 1;
			serial = nextSerial;
			serials.set(value, serial);
		}
		return serial;
	};
	// Per history entry: the gate evidence its quality was last reduced under. An unchanged entry keeps its object,
	// so matching evidence skips the reduction and a dispatch pays only for new evidence.
	const reduced = new WeakMap<RouteHistoryEntry, { gateKey: string; label: RouteQualityLabel }>();
	const qualityOf = (entry: RouteHistoryEntry, sources: DurableQualitySources, gateKey: string): RouteQualityLabel => {
		const subject = sourceCache().sourceOf(entry);
		// A run whose seal does not verify cannot keep a quality label (#434).
		if (subject === null) return "unmeasured";
		const previous = reduced.get(entry);
		if (previous !== undefined && previous.gateKey === gateKey) return previous.label;
		const label = reduceRouteQuality({ subject, runs: sources.runs, gateArtifacts: sources.gates }).label;
		reduced.set(entry, { gateKey, label });
		return label;
	};
	const readinessWindow = (): RouteReadinessEvidenceWindow => {
		const sources = sourceCache().read();
		const gateKey = gateEvidenceKey(sources, serialOf);
		return {
			forRoute(candidate, current) {
				const key = routeCapabilityKey(candidate);
				const guard = routeDriftGuard(candidate);
				const entries = sources.history.filter((entry) => {
					const route = entryCandidate(entry);
					return routeCapabilityKey(route) === key && !routeDriftInvalidates(routeDriftGuard(route), guard);
				});
				let integrityFailures = 0;
				let validConstraints = 0;
				const durations: number[] = [];
				const observations: RouteObservation[] = [];
				for (const entry of entries) {
					observations.push(routeObservationFromEntry(entry, qualityOf(entry, sources, gateKey)));
					if (!entry.sealVerified) {
						integrityFailures += 1;
						continue;
					}
					if (entry.decision.constraintsValid) validConstraints += 1;
					durations.push(entry.decision.durationMs);
				}
				return {
					observations,
					readiness: {
						hardConstraintValidity: entries.length === 0 ? 0 : validConstraints / entries.length,
						integrityFailures,
						costUpperBoundUsd: current.costUpperBoundUsd,
						factsFresh: current.factsFresh,
						decisionP95Ms: percentile95(durations),
					},
				};
			},
		};
	};

	return {
		readinessWindow,
		observe(input) {
			try {
				const intent = classifyAgentTask(input.task);
				const decision = input.decision;
				sequence += 1;
				const observationId = `route-${decision.decisionHash.slice(0, 12)}-${sequence.toString(36)}`;
				totalObservations += 1;
				pending.set(observationId, { decision, taskType: intent.taskType });
				if (pending.size > PENDING_LIMIT) {
					const oldest = pending.keys().next().value;
					if (oldest !== undefined) pending.delete(oldest);
				}
				telemetryHub().emit("route.decided", routeDecidedFacts(decision), input.ctx);
				return { id: observationId, decision };
			} catch {
				// Active authority already changed execution and must remain sealed. A
				// failed shadow observer falls back to the exact production tuple.
				const decision =
					input.decision.mode === "active"
						? input.decision
						: fixedRouteDecision(input.decision.executedRoute, "observer-failure-fixed-route");
				sequence += 1;
				const observationId = `route-fixed-${decision.decisionHash.slice(0, 12)}-${sequence.toString(36)}`;
				totalObservations += 1;
				pending.set(observationId, { decision, taskType: classifyAgentTask(input.task).taskType });
				try {
					telemetryHub().emit("route.decided", routeDecidedFacts(decision), input.ctx);
				} catch {
					// The sealed fallback must reach its receipt even when its journal record cannot be built.
				}
				return { id: observationId, decision };
			}
		},
		recordOutcome(observationId, outcome) {
			try {
				const entry = pending.get(observationId);
				if (entry === undefined) return;
				pending.delete(observationId);
				const realized: RouteRealizedOutcome = outcome;
				const evaluation = evaluateRouteDecision(entry.decision, realized);
				learner.record({ observationId, decision: entry.decision, realized, evaluation }, entry.taskType);
				const reliability =
					realized.outcome === "canceled" ||
					realized.outcome === "denied_by_policy" ||
					(outcome.receipt.outcomeDetail?.toLowerCase().includes("permission") === true &&
						(outcome.receipt.outcomeDetail?.toLowerCase().includes("denied") === true ||
							outcome.receipt.outcomeDetail?.toLowerCase().includes("required") === true))
						? "neutral"
						: realized.outcome === "succeeded"
							? "success"
							: "failure";
				const completed = realized.outcome === "succeeded" && outcome.quality.label !== "fail";
				const unpriced = receiptHasUnknownCost(outcome.receipt);
				samples?.record(realized.route, {
					qualityLabel: outcome.quality.label,
					reliability,
					firstPass: realized.firstPass,
					completedCostUsd: completed && !unpriced ? realized.costUsd : null,
					completedEndToEndMs: completed ? realized.endToEndMs : null,
					cacheRead: outcome.receipt.cacheReadTokenCount == null ? null : outcome.receipt.cacheReadTokenCount > 0,
					queueWaitMs: completed ? (outcome.phaseTiming?.queueWaitMs ?? null) : null,
				});
			} catch {
				// Observation must never disturb dispatch.
			}
		},
		summary() {
			return learner.summary(totalObservations);
		},
	};
}
