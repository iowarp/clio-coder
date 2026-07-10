/**
 * Speculation observer (shadow mode): the awoc dispatch pipeline's intent
 * detector, rule-based solver, in-memory learner, and observer adapter,
 * ported by semantics into Clio's dispatch domain.
 *
 * The observer watches every dispatch, synchronously computes the plan the
 * pipeline WOULD have chosen (pure rule path, no LLM, no side model), and
 * records plan-versus-actual with an accuracy signal into a bounded JSONL
 * file under the local state dir. It never steers dispatch: every entry
 * point is try/catch-wrapped, there is no new tool surface, and disabling
 * the observer leaves dispatch behavior bit-identical.
 */

import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { clioStateDir } from "../../core/xdg.js";

// ---------------------------------------------------------------------------
// Contracts (ported from awoc dispatch/contracts.ts, trimmed to the observer)
// ---------------------------------------------------------------------------

export type SpeculationTaskType =
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

export type SpeculationComplexity = "trivial" | "simple" | "moderate" | "complex";

export type SpeculationDomain = "frontend" | "backend" | "infra" | "data" | "security" | "general";

export interface SpeculationIntent {
	taskType: SpeculationTaskType;
	complexity: SpeculationComplexity;
	domain: SpeculationDomain;
	decomposable: boolean;
	estimatedSubtasks: number;
	/** Detector confidence in this classification (0..1). */
	confidence: number;
}

export interface SpeculationAgentDescriptor {
	id: string;
	description: string;
}

export interface SpeculationPlan {
	id: string;
	intent: SpeculationIntent;
	/** Agent the rule solver would have dispatched to. */
	agentId: string;
	/** Why the solver picked that agent (rule name). */
	reason: "requested" | "task_type_match" | "description_match" | "default";
	/** Steps the solver would fan out (1 unless decomposable with capacity). */
	steps: number;
	/** Solver confidence in the plan (0..1). */
	confidence: number;
	/** Time the rule path took, in microseconds (sync, sub-millisecond). */
	computeTimeUs: number;
}

export interface SpeculationActual {
	agentId: string;
	outcome: string;
	latencyMs: number;
	tokens: number;
}

export interface SpeculationOutcome {
	observationId: string;
	plan: SpeculationPlan;
	actual: SpeculationActual;
	comparison: {
		agentMatch: boolean;
		/** 1 when the solver's pick matched the actual agent, else 0; the summary averages it. */
		accuracy: number;
	};
}

// ---------------------------------------------------------------------------
// Rule-based intent detector (sync, <1ms; no LLM)
// ---------------------------------------------------------------------------

const TASK_TYPE_RULES: ReadonlyArray<readonly [SpeculationTaskType, RegExp]> = [
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

const DOMAIN_RULES: ReadonlyArray<readonly [SpeculationDomain, RegExp]> = [
	["security", /\b(security|vulnerabilit|auth|credential|secret|cve)\b/i],
	["frontend", /\b(ui|css|react|component|frontend|tui|overlay)\b/i],
	["infra", /\b(docker|kubernetes|k8s|deploy|terraform|infra|slurm|cluster)\b/i],
	["data", /\b(dataset|etl|pipeline data|schema migration|parquet|hdf5)\b/i],
	["backend", /\b(api|server|endpoint|database|backend|service)\b/i],
];

export function classifySpeculationIntent(task: string): SpeculationIntent {
	const text = task.trim();
	let taskType: SpeculationTaskType = "unknown";
	for (const [candidate, pattern] of TASK_TYPE_RULES) {
		if (pattern.test(text)) {
			taskType = candidate;
			break;
		}
	}
	let domain: SpeculationDomain = "general";
	for (const [candidate, pattern] of DOMAIN_RULES) {
		if (pattern.test(text)) {
			domain = candidate;
			break;
		}
	}
	const words = text.split(/\s+/).filter((word) => word.length > 0).length;
	const complexity: SpeculationComplexity =
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
// Rule-based solver (sync, pure)
// ---------------------------------------------------------------------------

/** Agent-id hints per task type, tried in order against the known agents. */
const TASK_TYPE_AGENT_HINTS: Readonly<Partial<Record<SpeculationTaskType, ReadonlyArray<string>>>> = {
	code_review: ["reviewer", "verifier"],
	test: ["verifier", "tester"],
	docs: ["docs", "writer", "docs-writer"],
	research: ["scout", "researcher"],
};

export interface SpeculationSolverInput {
	intent: SpeculationIntent;
	task: string;
	requestedAgentId: string | undefined;
	agents: ReadonlyArray<SpeculationAgentDescriptor>;
	availableCapacity: number;
}

export function solveSpeculationPlan(input: SpeculationSolverInput): SpeculationPlan {
	const startedNs = process.hrtime.bigint();
	const { intent, agents } = input;
	let agentId: string;
	let reason: SpeculationPlan["reason"];
	const known = new Set(agents.map((agent) => agent.id));
	if (input.requestedAgentId !== undefined && known.has(input.requestedAgentId)) {
		agentId = input.requestedAgentId;
		reason = "requested";
	} else {
		const hinted = (TASK_TYPE_AGENT_HINTS[intent.taskType] ?? []).find((hint) =>
			agents.some((agent) => agent.id === hint || agent.id.includes(hint)),
		);
		const hintedAgent =
			hinted !== undefined ? agents.find((agent) => agent.id === hinted || agent.id.includes(hinted)) : undefined;
		if (hintedAgent !== undefined) {
			agentId = hintedAgent.id;
			reason = "task_type_match";
		} else {
			const keyword = intent.taskType.replace("code_", "");
			const byDescription = agents.find((agent) => agent.description.toLowerCase().includes(keyword));
			if (byDescription !== undefined && intent.taskType !== "unknown") {
				agentId = byDescription.id;
				reason = "description_match";
			} else {
				agentId = input.requestedAgentId ?? agents[0]?.id ?? "coder";
				reason = "default";
			}
		}
	}
	const steps = intent.decomposable ? Math.min(intent.estimatedSubtasks, Math.max(1, input.availableCapacity)) : 1;
	const confidence = Math.max(0, Math.min(1, intent.confidence + (reason === "requested" ? 0.2 : 0)));
	const computeTimeUs = Number((process.hrtime.bigint() - startedNs) / 1000n);
	return {
		id: `spec-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`,
		intent,
		agentId,
		reason,
		steps,
		confidence,
		computeTimeUs,
	};
}

// ---------------------------------------------------------------------------
// In-memory learner (circular buffer + accuracy summary)
// ---------------------------------------------------------------------------

const LEARNER_CAPACITY = 256;

export interface SpeculationSummary {
	totalObservations: number;
	recordedOutcomes: number;
	agentMatchRate: number;
	taskTypeDistribution: Record<string, number>;
}

export interface SpeculationLearner {
	record(outcome: SpeculationOutcome): void;
	recent(limit?: number): SpeculationOutcome[];
	summary(totalObservations: number): SpeculationSummary;
}

export function createSpeculationLearner(capacity = LEARNER_CAPACITY): SpeculationLearner {
	const buffer: SpeculationOutcome[] = [];
	return {
		record(outcome) {
			buffer.push(outcome);
			if (buffer.length > capacity) buffer.splice(0, buffer.length - capacity);
		},
		recent(limit) {
			const slice = limit !== undefined ? buffer.slice(-limit) : [...buffer];
			return slice.reverse();
		},
		summary(totalObservations) {
			const taskTypeDistribution: Record<string, number> = {};
			let matches = 0;
			for (const outcome of buffer) {
				const key = outcome.plan.intent.taskType;
				taskTypeDistribution[key] = (taskTypeDistribution[key] ?? 0) + 1;
				if (outcome.comparison.agentMatch) matches += 1;
			}
			return {
				totalObservations,
				recordedOutcomes: buffer.length,
				agentMatchRate: buffer.length > 0 ? matches / buffer.length : 0,
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

export interface SpeculationObserveInput {
	task: string;
	requestedAgentId?: string;
}

export interface SpeculationObserver {
	/** Compute the would-be plan for a dispatch; returns the observation id, or null when observation failed. */
	observe(input: SpeculationObserveInput): string | null;
	/** Record what the real dispatch actually did for a prior observation. */
	recordOutcome(observationId: string, actual: SpeculationActual): void;
	summary(): SpeculationSummary;
}

export interface CreateSpeculationObserverOptions {
	/** Known agent descriptors; read per observation so hot-reloads apply. */
	getAgents: () => ReadonlyArray<SpeculationAgentDescriptor>;
	/** Free worker capacity at observation time; defaults to 1. */
	getAvailableCapacity?: () => number;
	/** Log directory override; defaults to `<state>/speculation`. */
	logDir?: string;
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

export function createSpeculationObserver(options: CreateSpeculationObserverOptions): SpeculationObserver {
	const learner = createSpeculationLearner();
	const pending = new Map<string, SpeculationPlan>();
	const PENDING_LIMIT = 512;
	let totalObservations = 0;
	const logDir = (): string => options.logDir ?? join(clioStateDir(), "speculation");
	return {
		observe(input) {
			try {
				const intent = classifySpeculationIntent(input.task);
				const plan = solveSpeculationPlan({
					intent,
					task: input.task,
					requestedAgentId: input.requestedAgentId,
					agents: options.getAgents(),
					availableCapacity: options.getAvailableCapacity?.() ?? 1,
				});
				totalObservations += 1;
				pending.set(plan.id, plan);
				if (pending.size > PENDING_LIMIT) {
					const oldest = pending.keys().next().value;
					if (oldest !== undefined) pending.delete(oldest);
				}
				appendObservationLine(logDir(), {
					kind: "plan",
					id: plan.id,
					at: new Date().toISOString(),
					intent: plan.intent,
					agentId: plan.agentId,
					reason: plan.reason,
					steps: plan.steps,
					confidence: plan.confidence,
					computeTimeUs: plan.computeTimeUs,
				});
				return plan.id;
			} catch {
				// Observation must never disturb dispatch.
				return null;
			}
		},
		recordOutcome(observationId, actual) {
			try {
				const plan = pending.get(observationId);
				if (plan === undefined) return;
				pending.delete(observationId);
				const agentMatch = plan.agentId === actual.agentId;
				const outcome: SpeculationOutcome = {
					observationId,
					plan,
					actual,
					comparison: { agentMatch, accuracy: agentMatch ? 1 : 0 },
				};
				learner.record(outcome);
				appendObservationLine(logDir(), {
					kind: "outcome",
					id: observationId,
					at: new Date().toISOString(),
					plannedAgentId: plan.agentId,
					actual,
					comparison: outcome.comparison,
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
