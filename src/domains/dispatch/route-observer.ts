/**
 * Route observer (shadow mode).
 *
 * The observer watches every dispatch, synchronously builds the RouteDecisionV1
 * the policy would have produced, and records decision-versus-outcome into a
 * bounded JSONL under the local state dir. It never steers dispatch: every
 * entry point is try/catch-wrapped, there is no new tool surface, and disabling
 * the observer leaves dispatch behavior bit-identical.
 *
 * What it measures is deliberately not "did Clio dispatch to the agent it was
 * asked for". That comparison was true by construction, because the actual
 * agent is the one the caller requested, so it measured obedience rather than
 * route quality. It is replaced by the four families that do carry signal:
 * route regret, constraint validity, prediction calibration, and outcome.
 *
 * The intent detector below survives as the cold-start prior for agent
 * selection. It is a shadow recommendation only: changing the agent changes
 * authority, so no observer output can ever alter the executed agent.
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { clioStateDir } from "../../core/xdg.js";
import {
	type CandidateEvaluation,
	decideRoute,
	evaluateRouteDecision,
	type RouteCandidate,
	type RouteDecisionInput,
	type RouteDecisionV1,
	type RouteEvaluation,
	type RouteRealizedOutcome,
	routeCandidateKey,
} from "./route-decision.js";
import { estimateRoute, type RouteEstimate, type RouteObservation } from "./route-policy.js";

// ---------------------------------------------------------------------------
// Rule-based intent detector (sync, <1ms; no LLM)
// ---------------------------------------------------------------------------

export type RouteTaskType =
	| "code_write"
	| "code_read"
	| "code_review"
	| "debug"
	| "refactor"
	| "test"
	| "docs"
	| "config"
	| "research"
	| "unknown";

export type RouteComplexity = "trivial" | "simple" | "moderate" | "complex";

export type RouteDomain = "frontend" | "backend" | "infra" | "data" | "security" | "general";

/**
 * Bounded task features. Raw task text is deliberately never stored: the
 * observer keeps policy-relevant classifications and hashes, not prompts.
 */
export interface RouteIntent {
	taskType: RouteTaskType;
	complexity: RouteComplexity;
	domain: RouteDomain;
	decomposable: boolean;
	estimatedSubtasks: number;
	/** Detector confidence in this classification (0..1). */
	confidence: number;
}

const TASK_TYPE_RULES: ReadonlyArray<readonly [RouteTaskType, RegExp]> = [
	["test", /\b(tests?|unit tests?|coverage|spec file)\b/i],
	["docs", /\b(documentation|docs|readme|changelog|comment|docstring)\b/i],
	["code_review", /\b(review|audit|critique|inspect for)\b/i],
	["debug", /\b(debug|fix|bug|crash|failure|broken|regression)\b/i],
	["refactor", /\b(refactor|clean ?up|restructure|rename|extract|simplify)\b/i],
	["config", /\b(config|configuration|settings|setup|install|ci pipeline|workflow file)\b/i],
	["research", /\b(research|investigate|explore|survey|compare|find out)\b/i],
	["code_read", /\b(read|explain|understand|summarize|describe|walk through)\b/i],
	["code_write", /\b(write|implement|add|create|build|develop|introduce)\b/i],
];

const DOMAIN_RULES: ReadonlyArray<readonly [RouteDomain, RegExp]> = [
	["security", /\b(security|vulnerabilit|auth|credential|secret|cve)\b/i],
	["frontend", /\b(ui|css|react|component|frontend|tui|overlay)\b/i],
	["infra", /\b(docker|kubernetes|k8s|deploy|terraform|infra|slurm|cluster)\b/i],
	["data", /\b(dataset|etl|pipeline data|schema migration|parquet|hdf5)\b/i],
	["backend", /\b(api|server|endpoint|database|backend|service)\b/i],
];

export function classifyRouteIntent(task: string): RouteIntent {
	const text = task.trim();
	let taskType: RouteTaskType = "unknown";
	for (const [candidate, pattern] of TASK_TYPE_RULES) {
		if (pattern.test(text)) {
			taskType = candidate;
			break;
		}
	}
	let domain: RouteDomain = "general";
	for (const [candidate, pattern] of DOMAIN_RULES) {
		if (pattern.test(text)) {
			domain = candidate;
			break;
		}
	}
	const words = text.split(/\s+/).filter((word) => word.length > 0).length;
	const complexity: RouteComplexity =
		words <= 6 ? "trivial" : words <= 25 ? "simple" : words <= 80 ? "moderate" : "complex";
	// Decomposability: enumerations and conjoined clauses suggest parallel subtasks.
	const enumerated = (text.match(/(^|\n)\s*(\d+[.)]|[-*])\s+/g) ?? []).length;
	const conjunctions = (text.match(/\b(and then|and also|; )\b/gi) ?? []).length;
	const estimatedSubtasks = Math.max(1, Math.min(4, enumerated > 1 ? enumerated : conjunctions > 0 ? 2 : 1));
	return {
		taskType,
		complexity,
		domain,
		decomposable: estimatedSubtasks > 1,
		estimatedSubtasks,
		confidence: taskType === "unknown" ? 0.3 : 0.7,
	};
}

// ---------------------------------------------------------------------------
// Agent shadow recommendation (sync, pure)
// ---------------------------------------------------------------------------

export interface RouteAgentDescriptor {
	id: string;
	description: string;
}

/** Agent-id hints per task type, tried in order against the known agents. */
const TASK_TYPE_AGENT_HINTS: Readonly<Partial<Record<RouteTaskType, ReadonlyArray<string>>>> = {
	code_review: ["reviewer", "verifier"],
	test: ["verifier", "tester"],
	docs: ["docs", "writer", "docs-writer"],
	research: ["scout", "researcher"],
};

export interface AgentRecommendation {
	agentId: string;
	/** Why the rules picked that agent. */
	reason: "requested" | "task_type_match" | "description_match" | "default";
	confidence: number;
}

/**
 * The agent the rules would recommend. Advisory only: promoting a Scout to a
 * Coder changes authority and must pass admission or prior approval, so this
 * output is recorded and never applied.
 */
export function recommendAgent(input: {
	intent: RouteIntent;
	requestedAgentId: string | undefined;
	agents: ReadonlyArray<RouteAgentDescriptor>;
}): AgentRecommendation {
	const { intent, agents } = input;
	const known = new Set(agents.map((agent) => agent.id));
	if (input.requestedAgentId !== undefined && known.has(input.requestedAgentId)) {
		return {
			agentId: input.requestedAgentId,
			reason: "requested",
			confidence: Math.min(1, intent.confidence + 0.2),
		};
	}
	const hinted = (TASK_TYPE_AGENT_HINTS[intent.taskType] ?? []).find((hint) =>
		agents.some((agent) => agent.id === hint || agent.id.includes(hint)),
	);
	const hintedAgent =
		hinted !== undefined ? agents.find((agent) => agent.id === hinted || agent.id.includes(hinted)) : undefined;
	if (hintedAgent !== undefined) {
		return { agentId: hintedAgent.id, reason: "task_type_match", confidence: intent.confidence };
	}
	const keyword = intent.taskType.replace("code_", "");
	const byDescription = agents.find((agent) => agent.description.toLowerCase().includes(keyword));
	if (byDescription !== undefined && intent.taskType !== "unknown") {
		return { agentId: byDescription.id, reason: "description_match", confidence: intent.confidence };
	}
	return {
		agentId: input.requestedAgentId ?? agents[0]?.id ?? "coder",
		reason: "default",
		confidence: intent.confidence,
	};
}

// ---------------------------------------------------------------------------
// Route-tuple sample store (bounded, in-memory)
// ---------------------------------------------------------------------------

/** Runs retained per route tuple; the estimator only needs a recent window. */
const SAMPLES_PER_ROUTE = 32;
/** Distinct route tuples retained; a fleet has far fewer than this in practice. */
const ROUTE_SAMPLE_KEYS = 256;

export interface RouteSampleStore {
	samplesFor(candidate: RouteCandidate): ReadonlyArray<RouteObservation>;
	record(candidate: RouteCandidate, observation: RouteObservation): void;
}

export function createRouteSampleStore(): RouteSampleStore {
	const byRoute = new Map<string, RouteObservation[]>();
	return {
		samplesFor(candidate) {
			return byRoute.get(routeCandidateKey(candidate)) ?? [];
		},
		record(candidate, observation) {
			const key = routeCandidateKey(candidate);
			const samples = byRoute.get(key) ?? [];
			samples.push(observation);
			if (samples.length > SAMPLES_PER_ROUTE) samples.splice(0, samples.length - SAMPLES_PER_ROUTE);
			byRoute.set(key, samples);
			if (byRoute.size > ROUTE_SAMPLE_KEYS) {
				const oldest = byRoute.keys().next().value;
				if (oldest !== undefined) byRoute.delete(oldest);
			}
		},
	};
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
	/** Mean Brier score of the verified-success estimate; lower is better calibrated. */
	meanVerifiedSuccessBrier: number;
	/** Mean ratio of actual to estimated cost for the route that ran. */
	meanCostRatio: number;
	verifiedRate: number;
	firstPassRate: number;
	escalationRate: number;
	taskTypeDistribution: Record<string, number>;
}

export interface RouteLearner {
	record(record: RouteEvaluationRecord, taskType: RouteTaskType): void;
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

export function createRouteLearner(capacity = LEARNER_CAPACITY): RouteLearner {
	const buffer: RouteEvaluationRecord[] = [];
	const taskTypes: RouteTaskType[] = [];
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
				meanVerifiedSuccessBrier: meanOf(evaluations.map((evaluation) => evaluation.calibration.verifiedSuccessBrier)),
				meanCostRatio: meanOf(evaluations.map((evaluation) => evaluation.calibration.costRatio)),
				verifiedRate: rateOf(evaluations.map((evaluation) => evaluation.outcome.verified)),
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
	requestedAgentId: string | undefined;
	/** The route the production pipeline resolved and is about to execute. */
	executedRoute: RouteCandidate;
	/** Enumerated tuples with their hard-filter verdicts, in approval order. */
	candidates: ReadonlyArray<{ candidate: RouteCandidate; rejection: string | null }>;
	hardConstraints: ReadonlyArray<string>;
	maxFallbacks: number;
}

export interface RouteObservationHandle {
	id: string;
	/** The sealed decision, for the caller to fold onto its receipt. */
	decision: RouteDecisionV1;
}

export interface RouteObserver {
	/** Build the shadow decision for a dispatch; null when observation failed. */
	observe(input: RouteObserveInput): RouteObservationHandle | null;
	/** Record what the real dispatch actually did for a prior observation. */
	recordOutcome(observationId: string, realized: RouteRealizedOutcome): void;
	summary(): RouteObserverSummary;
}

export interface CreateRouteObserverOptions {
	/** Known agent descriptors; read per observation so hot-reloads apply. */
	getAgents: () => ReadonlyArray<RouteAgentDescriptor>;
	/** Estimator inputs per route tuple; defaults to a bounded in-memory store. */
	samples?: RouteSampleStore;
	/** Log directory override; defaults to `<state>/route-decisions`. */
	logDir?: string;
	/** Monotonic microsecond clock; injectable so a test can pin decision duration. */
	nowUs?: () => number;
	/** Estimator seam; defaults to the shrinkage estimator over the sample store. */
	estimate?: (samples: ReadonlyArray<RouteObservation>) => RouteEstimate;
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

export function createRouteObserver(options: CreateRouteObserverOptions): RouteObserver {
	const learner = createRouteLearner();
	const samples = options.samples ?? createRouteSampleStore();
	const pending = new Map<string, { decision: RouteDecisionV1; taskType: RouteTaskType }>();
	const PENDING_LIMIT = 512;
	let totalObservations = 0;
	let sequence = 0;
	const logDir = (): string => options.logDir ?? join(clioStateDir(), "route-decisions");
	const nowUs = options.nowUs ?? ((): number => Number(process.hrtime.bigint() / 1000n));
	const estimateFor = options.estimate ?? estimateRoute;

	return {
		observe(input) {
			try {
				const startedUs = nowUs();
				const intent = classifyRouteIntent(input.task);
				const recommendation = recommendAgent({
					intent,
					requestedAgentId: input.requestedAgentId,
					agents: options.getAgents(),
				});
				// Shadow is the only mode this observer produces: it records what the
				// policy would do while the caller executes `executedRoute` untouched.
				const decisionInput: RouteDecisionInput = {
					mode: "shadow",
					posture: "balanced",
					executedRoute: input.executedRoute,
					candidates: input.candidates.map((entry) => ({
						candidate: entry.candidate,
						estimate: estimateFor(samples.samplesFor(entry.candidate)),
						rejection: entry.rejection,
					})),
					hardConstraints: input.hardConstraints,
					maxFallbacks: input.maxFallbacks,
					decisionDurationMs: Math.max(0, nowUs() - startedUs) / 1000,
				};
				const decision = decideRoute(decisionInput);
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
					agentRecommendation: recommendation,
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
				// Observation must never disturb dispatch.
				return null;
			}
		},
		recordOutcome(observationId, realized) {
			try {
				const entry = pending.get(observationId);
				if (entry === undefined) return;
				pending.delete(observationId);
				const evaluation = evaluateRouteDecision(entry.decision, realized);
				learner.record({ observationId, decision: entry.decision, realized, evaluation }, entry.taskType);
				samples.record(realized.route, {
					verified: realized.verified,
					firstPass: realized.firstPass,
					costUsd: realized.costUsd,
					endToEndMs: realized.endToEndMs,
					succeeded: realized.outcome === "succeeded",
					cacheRead: false,
					queueWaitMs: 0,
				});
				appendObservationLine(logDir(), {
					kind: "outcome",
					id: observationId,
					at: new Date().toISOString(),
					decisionHash: entry.decision.decisionHash,
					executed: routeCandidateKey(realized.route),
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
