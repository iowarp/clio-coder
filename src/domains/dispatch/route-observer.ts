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

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { clioDataDir, clioStateDir } from "../../core/xdg.js";
import type { AgentLatencyClass } from "../agents/spec.js";
import { parseEvalArtifactV3 } from "../eval/artifacts/store.js";
import { readGateDecisionArtifacts } from "./gate-decisions.js";
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
import { createRouteHistoryStore, type RouteHistoryStore } from "./route-history.js";
import {
	estimateRoute,
	type RouteEstimate,
	type RouteObservation,
	routeObservationFromHistory,
	routePriorForLatencyClass,
} from "./route-policy.js";
import { type RouteQualityReduction, reduceRouteQuality, routeQualityEvalDigest } from "./route-quality.js";
import type { RunEnvelope, RunReceipt } from "./types.js";

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
	latencyClass?: AgentLatencyClass;
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
			byRoute.set(key, samples);
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

export interface RouteObservedOutcome extends RouteRealizedOutcome {
	receipt: RunReceipt;
	envelope: RunEnvelope;
	quality: RouteQualityReduction;
	phaseTiming: { totalEndToEndMs: number | null; queueWaitMs: number | null } | undefined;
}

export interface RouteObserver {
	/** Build the shadow decision for a dispatch; null when observation failed. */
	observe(input: RouteObserveInput): RouteObservationHandle | null;
	/** Reduce and durably record the real terminal route outcome. */
	recordOutcome(observationId: string, outcome: RouteObservedOutcome): void;
	summary(): RouteObserverSummary;
}

export interface CreateRouteObserverOptions {
	/** Known agent descriptors; read per observation so hot-reloads apply. */
	getAgents: () => ReadonlyArray<RouteAgentDescriptor>;
	/** Durable production source for route estimation. */
	history?: RouteHistoryStore;
	/** Test-only estimator input seam. Production does not use this store. */
	samples?: RouteSampleStore;
	/** Log directory override; defaults to `<state>/route-decisions`. */
	logDir?: string;
	/** Durable source directory override, primarily for restart/replay tests. */
	stateDir?: string;
	/** Monotonic microsecond clock; injectable so a test can pin decision duration. */
	nowUs?: () => number;
	/** Estimator seam; defaults to the shrinkage estimator over the sample store. */
	estimate?: (samples: ReadonlyArray<RouteObservation>, prior?: Parameters<typeof estimateRoute>[1]) => RouteEstimate;
}

function durableQualitySources(stateDir: string): {
	receipts: Array<{ receipt: RunReceipt; envelope: RunEnvelope }>;
	gates: ReturnType<typeof readGateDecisionArtifacts>[number]["artifact"][];
	evals: Array<{ artifact: Parameters<typeof routeQualityEvalDigest>[0]; digest: string }>;
} {
	const runsPath = join(stateDir, "runs.json");
	if (!existsSync(runsPath)) return { receipts: [], gates: [], evals: [] };
	try {
		const parsed = JSON.parse(readFileSync(runsPath, "utf8")) as unknown;
		if (!Array.isArray(parsed)) return { receipts: [], gates: [], evals: [] };
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
		const evals: Array<{ artifact: Parameters<typeof routeQualityEvalDigest>[0]; digest: string }> = [];
		const evalDirectory = join(clioDataDir(), "evals");
		if (existsSync(evalDirectory)) {
			for (const name of readdirSync(evalDirectory)
				.filter((entry) => entry.endsWith(".json"))
				.sort()) {
				try {
					const artifact = parseEvalArtifactV3(JSON.parse(readFileSync(join(evalDirectory, name), "utf8")) as unknown, name);
					evals.push({ artifact, digest: routeQualityEvalDigest(artifact) });
				} catch {
					// Retired or malformed artifact formats are not routing evidence.
				}
			}
		}
		return { receipts, gates: readGateDecisionArtifacts(undefined, stateDir).map((entry) => entry.artifact), evals };
	} catch {
		return { receipts: [], gates: [], evals: [] };
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

export function createRouteObserver(options: CreateRouteObserverOptions): RouteObserver {
	const learner = createRouteLearner();
	const history = options.history ?? createRouteHistoryStore();
	const samples = options.samples;
	const pending = new Map<string, { decision: RouteDecisionV1; taskType: RouteTaskType }>();
	const PENDING_LIMIT = 512;
	let totalObservations = 0;
	let sequence = 0;
	const logDir = (): string => options.logDir ?? join(clioStateDir(), "route-decisions");
	const nowUs = options.nowUs ?? ((): number => Number(process.hrtime.bigint() / 1000n));
	const estimateFor = options.estimate ?? estimateRoute;
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
				evalArtifacts: sources.evals,
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

	return {
		observe(input) {
			try {
				reconcileHistory();
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
					candidates: input.candidates.map((entry) => {
						const latencyClass = options.getAgents().find((agent) => agent.id === entry.candidate.agentId)?.latencyClass;
						return {
							candidate: entry.candidate,
							estimate: estimateFor(
								samples?.samplesFor(entry.candidate) ?? history.recordsFor(entry.candidate).map(routeObservationFromHistory),
								latencyClass === undefined ? undefined : routePriorForLatencyClass(latencyClass),
							),
							rejection: entry.rejection,
						};
					}),
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
					version: 1,
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
