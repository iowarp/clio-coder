/**
 * Route observer (shadow mode).
 *
 * The observer watches every dispatch, receives the shared RouteDecisionV1,
 * the policy would have produced, and records decision-versus-outcome into a
 * bounded JSONL under the local state dir. Selection belongs to the resolver;
 * this module only records the route that shadow or active admission sealed.
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

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { clioStateDir } from "../../core/xdg.js";
import { type AgentTaskType, classifyAgentTask } from "./agent-candidates.js";
import { readGateDecisionArtifacts } from "./gate-decisions.js";
import { verifyReceiptIntegrity } from "./receipt-integrity.js";
import {
	type CandidateEvaluation,
	evaluateRouteDecision,
	fixedRouteDecision,
	type RouteCandidate,
	type RouteDecisionV1,
	type RouteEvaluation,
	type RouteRealizedOutcome,
	routeCandidateKey,
	routeConstraintValidity,
} from "./route-decision.js";
import { createRouteHistoryStore, type RouteHistoryStore } from "./route-history.js";
import { type RouteObservation, routeObservationFromHistory } from "./route-policy.js";
import { type RouteQualityReduction, reduceRouteQuality } from "./route-quality.js";
import type { RunEnvelope, RunReceipt } from "./types.js";

// ---------------------------------------------------------------------------
// Route-history projection
// ---------------------------------------------------------------------------

/**
 * Test-only estimator seam. Production always reads the durable route-history
 * store, so process restart cannot erase the policy's evidence window.
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

/** Rotate the observation log once it crosses this size; one prior generation is kept. */
const OBSERVATION_LOG_MAX_BYTES = 1024 * 1024;

export interface RouteObserveInput {
	task: string;
	/** Decision already produced by the shared joint resolver. */
	decision: RouteDecisionV1;
}

export interface RouteObservationHandle {
	id: string;
	/** The sealed decision, for the caller to fold onto its receipt. */
	decision: RouteDecisionV1;
}

export interface RouteObservedOutcome extends RouteRealizedOutcome {
	receipt: RunReceipt;
	envelope: RunEnvelope;
	quality: RouteQualityReduction;
	phaseTiming: { totalEndToEndMs: number | null; queueWaitMs: number | null } | undefined;
}

export interface RouteObserver {
	/** Register the sealed shadow or active decision for outcome observation. */
	observe(input: RouteObserveInput): RouteObservationHandle;
	/** Immutable evidence snapshot shared by every tuple in one joint resolution. */
	readinessWindow(): RouteReadinessEvidenceWindow;
	/** Reduce and durably record the real terminal route outcome. */
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
	/** Durable production source for route estimation. */
	history?: RouteHistoryStore;
	/** Test-only estimator input seam. Production does not use this store. */
	samples?: RouteSampleStore;
	/** Log directory override; defaults to `<state>/route-decisions`. */
	logDir?: string;
	/** Durable source directory override, primarily for restart/replay tests. */
	stateDir?: string;
}

function durableQualitySources(stateDir: string): {
	receipts: Array<{ receipt: RunReceipt; envelope: RunEnvelope }>;
	gates: ReturnType<typeof readGateDecisionArtifacts>[number]["artifact"][];
} {
	const runsPath = join(stateDir, "runs.json");
	if (!existsSync(runsPath)) return { receipts: [], gates: [] };
	try {
		const parsed = JSON.parse(readFileSync(runsPath, "utf8")) as unknown;
		if (!Array.isArray(parsed)) return { receipts: [], gates: [] };
		const receipts: Array<{ receipt: RunReceipt; envelope: RunEnvelope }> = [];
		for (const envelope of parsed) {
			if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) continue;
			const run = envelope as RunEnvelope;
			const path = run.receiptPath ?? join(stateDir, "receipts", `${run.id}.json`);
			if (!existsSync(path)) continue;
			const receipt = JSON.parse(readFileSync(path, "utf8")) as unknown;
			if (typeof receipt === "object" && receipt !== null && !Array.isArray(receipt)) {
				receipts.push({ receipt: receipt as RunReceipt, envelope: run });
			}
		}
		return { receipts, gates: readGateDecisionArtifacts(undefined, stateDir).map((entry) => entry.artifact) };
	} catch {
		return { receipts: [], gates: [] };
	}
}

function appendObservationLine(dir: string, record: Record<string, unknown>): void {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "observations.jsonl");
	try {
		if (statSync(path).size > OBSERVATION_LOG_MAX_BYTES) {
			renameSync(path, `${path}.1`);
		}
	} catch {
		// Missing file: first append creates it.
	}
	appendFileSync(path, `${JSON.stringify(record)}\n`);
}

/** The compact log projection; the sealed receipt keeps the full evaluation. */
function loggableEvaluation(evaluation: CandidateEvaluation): Record<string, unknown> {
	return {
		key: routeCandidateKey(evaluation.candidate),
		rejection: evaluation.rejection,
		score: evaluation.score,
		dominated: evaluation.dominated,
		sampleCount: evaluation.estimate.sampleCount,
	};
}

function percentile95(values: ReadonlyArray<number>): number {
	if (values.length === 0) return Number.POSITIVE_INFINITY;
	const ordered = [...values].sort((left, right) => left - right);
	return ordered[Math.ceil(ordered.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
}

export function createRouteObserver(options: CreateRouteObserverOptions): RouteObserver {
	const learner = createRouteLearner();
	const history =
		options.history ?? createRouteHistoryStore(options.stateDir === undefined ? {} : { stateDir: options.stateDir });
	const samples = options.samples;
	const pending = new Map<string, { decision: RouteDecisionV1; taskType: AgentTaskType }>();
	const PENDING_LIMIT = 512;
	let totalObservations = 0;
	let sequence = 0;
	const logDir = (): string => options.logDir ?? join(clioStateDir(), "route-decisions");
	const reconcileHistory = (): void => {
		const sources = durableQualitySources(options.stateDir ?? clioStateDir());
		if (sources.receipts.length === 0) return;
		const byDigest = new Map(sources.receipts.map((source) => [source.receipt.integrity.digest, source]));
		for (const record of history.all()) {
			const subject = byDigest.get(record.receiptDigest);
			if (subject === undefined) continue;
			const quality = reduceRouteQuality({
				subject,
				receipts: sources.receipts,
				gateArtifacts: sources.gates,
			});
			const completed = record.reliability === "success" && quality.label !== "fail";
			history.upsert({
				...record,
				qualityLabel: quality.label,
				completedCostUsd: completed ? record.completedCostUsd : null,
				completedPhaseTiming: completed ? record.completedPhaseTiming : null,
				sourceDigests: quality.sourceDigests,
			});
		}
	};
	const readinessWindow = (): RouteReadinessEvidenceWindow => {
		reconcileHistory();
		const sources = durableQualitySources(options.stateDir ?? clioStateDir());
		const byDigest = new Map(sources.receipts.map((source) => [source.receipt.integrity.digest, source]));
		return {
			forRoute(candidate, current) {
				const records = history.recordsFor(candidate);
				let integrityFailures = 0;
				let validConstraints = 0;
				const durations: number[] = [];
				for (const record of records) {
					const source = byDigest.get(record.receiptDigest);
					const decision = source?.receipt.routeDecision;
					if (
						source === undefined ||
						decision === undefined ||
						!verifyReceiptIntegrity(source.receipt, source.envelope).ok
					) {
						integrityFailures += 1;
						continue;
					}
					if (routeConstraintValidity(decision).valid) validConstraints += 1;
					durations.push(decision.decisionDurationMs);
				}
				return {
					observations: records.map(routeObservationFromHistory),
					readiness: {
						hardConstraintValidity: records.length === 0 ? 0 : validConstraints / records.length,
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
				appendObservationLine(logDir(), {
					kind: "decision",
					id: observationId,
					at: new Date().toISOString(),
					intent,
					agentRecommendation: {
						agentId: decision.agentSelection.recommendedAgentId,
						executionRole:
							decision.agentSelection.evaluations.find(
								(evaluation) => evaluation.agentId === decision.agentSelection.recommendedAgentId,
							)?.executionRole ?? decision.selected.executionRole,
					},
					policyVersion: decision.policyVersion,
					mode: decision.mode,
					posture: decision.posture,
					decisionHash: decision.decisionHash,
					decisionDurationMs: decision.decisionDurationMs,
					confidence: decision.confidence,
					selected: routeCandidateKey(decision.selected),
					executed: routeCandidateKey(decision.executedRoute),
					approvedFallbacks: decision.approvedFallbacks.map(routeCandidateKey),
					hardConstraints: decision.hardConstraints,
					reasonCodes: decision.reasonCodes,
					candidateEvaluations: decision.candidateEvaluations.map(loggableEvaluation),
				});
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
				const sample: RouteObservation = {
					qualityLabel: outcome.quality.label,
					reliability,
					firstPass: realized.firstPass,
					completedCostUsd: completed ? realized.costUsd : null,
					completedEndToEndMs: completed ? realized.endToEndMs : null,
					cacheRead: false,
					queueWaitMs: completed ? (outcome.phaseTiming?.queueWaitMs ?? null) : null,
				};
				samples?.record(realized.route, sample);
				history.upsert({
					version: 3,
					receiptDigest: outcome.receipt.integrity.digest,
					assignmentId: outcome.receipt.lineage?.rootRunId ?? outcome.receipt.runId,
					route: realized.route,
					executionRole: realized.route.executionRole,
					qualityLabel: outcome.quality.label,
					reliability,
					firstPass: realized.firstPass,
					completedCostUsd: sample.completedCostUsd,
					completedPhaseTiming:
						completed && outcome.phaseTiming !== undefined
							? {
									requestToDecisionMs: null,
									decisionMs: null,
									admissionWaitMs: null,
									queueWaitMs: outcome.phaseTiming.queueWaitMs,
									spawnSetupMs: null,
									timeToFirstModelTokenMs: null,
									timeToFirstToolMs: null,
									executionMs: null,
									totalEndToEndMs: outcome.phaseTiming.totalEndToEndMs,
								}
							: null,
					cacheRead: completed && (outcome.receipt.cacheReadTokenCount ?? 0) > 0,
					sourceDigests: outcome.quality.sourceDigests,
					settledAt: outcome.receipt.endedAt,
				});
				appendObservationLine(logDir(), {
					kind: "outcome",
					id: observationId,
					at: new Date().toISOString(),
					decisionHash: entry.decision.decisionHash,
					executed: routeCandidateKey(realized.route),
					quality: outcome.quality,
					regret: evaluation.regret,
					validity: evaluation.validity,
					calibration: evaluation.calibration,
					outcome: evaluation.outcome,
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
