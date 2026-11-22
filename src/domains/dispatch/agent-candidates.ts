/** Pure bounded agent admission, cold priors, and agent-role readiness views. */

import type { ToolName } from "../../core/tool-names.js";
import { type DispatchJob, dispatchJobRecipe } from "../agents/dispatch-jobs.js";
import type { ResultContract } from "../agents/result-contract.js";
import {
	AGENT_AUTOMATION_AUTHORITIES,
	type AgentAudience,
	type AgentAutomationAuthority,
	type AgentCapabilityClass,
	type AgentSpec,
	agentSpecFingerprint,
} from "../agents/spec.js";
import type { CapabilityGate } from "../middleware/capability-gate.js";
import { createCapabilityGate } from "../middleware/capability-gate.js";
import type { DispatchRequest } from "./contract.js";
import { type ExecutionRole, requestRunRole } from "./execution-role.js";
import type { RouteCandidate } from "./route-decision.js";
import { type RoutePrior, routePriorForLatencyClass } from "./route-policy.js";
import type { RouteReadinessReport } from "./route-readiness.js";

export type { AgentAutomationAuthority };
export { AGENT_AUTOMATION_AUTHORITIES };

/** Keeps decision evidence and the agent axis finite even when every recipe is hard-rejected. */
export const AGENT_CANDIDATE_LIMIT = 64;

export type AgentTaskType =
	| "code_write"
	| "code_read"
	| "code_review"
	| "debug"
	| "refactor"
	| "test"
	| "docs"
	| "config"
	| "research"
	| "world_knowledge"
	| "run_records"
	| "unknown";
export type AgentTaskComplexity = "trivial" | "simple" | "moderate" | "complex";
export type AgentTaskDomain = "frontend" | "backend" | "infra" | "data" | "security" | "general";

/** Bounded task features. Raw task text never enters a decision or route history. */
export interface AgentTaskFeatures {
	taskType: AgentTaskType;
	/** The job-table row this task resolves to (`dispatch-jobs.ts`). */
	job: DispatchJob;
	complexity: AgentTaskComplexity;
	domain: AgentTaskDomain;
	decomposable: boolean;
	estimatedSubtasks: number;
	confidence: number;
}

const TASK_TYPE_RULES: ReadonlyArray<readonly [AgentTaskType, RegExp]> = [
	// A review commonly discusses tests, documentation, and bugs. Its leading
	// request should win over those subjects when selecting a recipe. This is
	// a routing heuristic, never an authorization rule.
	["code_review", /^(?:please\s+)?(?:(?:independently|carefully)\s+)?(?:review|audit|critique|inspect for)\b/i],
	["test", /\b(tests?|unit tests?|coverage|spec file)\b/i],
	["docs", /\b(documentation|docs|readme|changelog|comment|docstring)\b/i],
	["code_review", /\b(review|audit|critique|inspect for)\b/i],
	["debug", /\b(debug|fix|bug|crash|failure|broken|regression)\b/i],
	["refactor", /\b(refactor|clean ?up|restructure|rename|extract|simplify)\b/i],
	["config", /\b(config|configuration|settings|setup|install|ci pipeline|workflow file)\b/i],
	[
		"world_knowledge",
		/\b(?:open[- ]world|ecosystem landscape|industry landscape|state of (?:the )?art|current alternatives|latest alternatives|advisory second opinion)\b/i,
	],
	["research", /\b(research|investigate|explore|survey|compare|find out)\b/i],
	["code_read", /\b(read|explain|understand|summarize|describe|walk through|map|locate|trace|find where|look at)\b/i],
	["code_write", /\b(write|implement|add|create|build|develop|introduce)\b/i],
];
// A test filename is an object of inspection, not an instruction to write or
// run tests. The ordered generic `test` rule below would otherwise consume it.
const LEADING_READ_TASK =
	/^(?:please\s+)?(?:read|inspect|explain|summarize|describe|map|locate|trace|look at|find where)\b/i;
/**
 * The repair family: a fix asked for by any of these verbs is the same change.
 * One list, so "resolve the parser crash" reads like "fix the parser crash".
 * patch, address and correct are also nouns and adjectives ("labels: correct,
 * incorrect"), so they ask for a change only with an object after them.
 */
const FIX_VERBS =
	"fix|repair|resolve|(?:patch|address|correct)(?=\\s+(?:the|this|that|a|an|any|it|these|those|all)\\b)";
const MUTATION_REQUEST = new RegExp(
	`\\b(?:write|implement|add|create|build|develop|${FIX_VERBS}|edit|change|modify|refactor|update)\\b`,
	"i",
);
/** A polite request ("could you fix ...", "can we add ...") is an instruction, not a question; it is read without its lead. */
const POLITE_REQUEST_LEAD =
	/^(?:please\s+)?(?:(?:can|could|would|will)\s+you|(?:can|could|should|shall)\s+(?:we|i))\s+(?:please\s+)?/i;
/** Sentence breaks; a path's dot (`src/a.ts`) is not one. */
const SENTENCE_BREAK = /(?<=[.!?])\s+/;
/** A task about a dispatched run's record: it names a run (run id, run record, run receipt). */
const RUN_RECORD_TASK = /\b(?:run[\s_-]?(?:records?|ids?|receipts?)|runIds?)\b/i;
/**
 * A mutation asked for rather than mentioned. The verb has to open a clause, so
 * "do not edit files" and "verify the fix" stay reports while "run the tests
 * and fix any failures" stays a change. Writing up the report itself is not a
 * mutation unless it names somewhere on disk to put it.
 */
const IMPERATIVE_MUTATION = new RegExp(
	`(?:^|[.;:!?,\\n]\\s*|\\b(?:and|then|also|please|must|should|need to|needs to)\\s+)(?:implement|add|create|build(?=\\s+(?:a|an|the\\s+(?:new|missing))\\b)|develop|${FIX_VERBS}|edit|change|modify|refactor|update|write(?!\\s+(?:up\\s+)?(?:(?:a|an|the|your)\\s+)?(?:\\w+\\s+)?(?:report|summary)\\b(?!\\s+(?:to|into|in|on)\\b)))\\b`,
	"i",
);

/**
 * A mutation verb whose object is nothing is a prohibition. "Change nothing."
 * opens a clause with "change", so it is removed before the imperative check;
 * "fix it and change nothing else" still mutates through "fix". A sentence that
 * carries an exception ("change nothing in x.ts except the limit") is kept.
 */
const MUTATION_PROHIBITION =
	/(?:\b(?:change|edit|modify|touch|write|alter|update)\s+(?:nothing|no\s+(?:files?|code|sources?)|none\s+of\s+(?:it|them|the\s+\w+))\b(?:\s+else\b)?|\bleave\s+(?:(?!\b(?:and|then|but|except|also|unchanged|untouched|as[\s-]is|alone|intact)\b)[^.;,\n]){0,60}?\b(?:unchanged|untouched|as[\s-]is|alone|intact)\b)(?=(?:(?!\b(?:except|but|other\s+than|besides|apart\s+from|aside\s+from|save\s+for|beyond|unless)\b|[.!?](?:\s|$))[^;\n])*(?:[.!?](?:\s|$)|[;\n]|$))/gi;

/**
 * A member name in code (`m.add(1,1)`, `cache.update`) is an identifier, not a verb: its dot would otherwise
 * open a clause for IMPERATIVE_MUTATION and its name would win the ordered `code_write` scan, so "verify
 * m.add(1,1)==2" read as a request to add something (M-40). Masked are a method call of any name and a
 * mutation verb reached through a dot; a file extension (`m.py`, `app.config.ts`) is neither and stays.
 */
const CODE_MEMBER =
	/(?<=[\w$)\]]\.)(?:[A-Za-z_$][\w$]*(?=\()|(?:write|implement|add|create|build|develop|fix|repair|resolve|patch|address|correct|edit|change|modify|refactor|update)\b)/gi;

function withoutCodeMembers(task: string): string {
	return task.replace(CODE_MEMBER, "member");
}

/**
 * Each sentence as the request it makes, polite lead removed, and whether it
 * asks for an answer: a sentence ending in "?" does, unless a polite lead
 * makes it a request.
 */
function taskSentences(task: string): Array<{ request: string; question: boolean }> {
	return task
		.trim()
		.split(SENTENCE_BREAK)
		.filter((sentence) => sentence.length > 0)
		.map((sentence) => ({
			request: sentence.replace(POLITE_REQUEST_LEAD, ""),
			question: !POLITE_REQUEST_LEAD.test(sentence) && /\?\s*$/.test(sentence),
		}));
}

/** Judged per sentence: a question ("which dependency do we need to patch?") asks for an answer, not a change. */
export function asksForMutation(task: string): boolean {
	return taskSentences(withoutCodeMembers(task).replace(MUTATION_PROHIBITION, " ")).some(
		(sentence) => !sentence.question && IMPERATIVE_MUTATION.test(sentence.request),
	);
}

const DOMAIN_RULES: ReadonlyArray<readonly [AgentTaskDomain, RegExp]> = [
	["security", /\b(security|vulnerabilit|auth|credential|secret|cve)\b/i],
	["frontend", /\b(ui|css|react|component|frontend|tui|overlay)\b/i],
	["infra", /\b(docker|kubernetes|k8s|deploy|terraform|infra|slurm|cluster)\b/i],
	["data", /\b(dataset|etl|pipeline data|schema migration|parquet|hdf5)\b/i],
	["backend", /\b(api|server|endpoint|database|backend|service)\b/i],
];

/**
 * The job a task shape asks for. A shape is a change only when the task asks
 * for one: "run the tests" is a check and "why does this crash" a diagnosis,
 * while "add a test" and "resolve the crash" write. A task with a question in it
 * or led by a read verb that asks for no change (`readOnly`) never gets a
 * writing job, so "where is the configuration loaded?" is an inspection.
 */
function jobForTaskShape(taskType: AgentTaskType, mutates: boolean, readOnly: boolean): DispatchJob {
	switch (taskType) {
		case "code_read":
		case "unknown":
			return mutates ? "implement" : "inspect";
		case "code_review":
			return "review";
		case "test":
			return mutates ? "add-tests" : "check";
		case "debug":
			return mutates ? "implement" : "diagnose";
		case "docs":
			return readOnly ? "inspect" : "docs";
		case "research":
			return "research";
		case "world_knowledge":
			return "open-world";
		case "run_records":
			return "run-records";
		case "code_write":
		case "refactor":
		case "config":
			return readOnly ? "inspect" : "implement";
	}
}

export function classifyAgentTask(task: string): AgentTaskFeatures {
	const text = withoutCodeMembers(task.trim());
	const request = text.replace(POLITE_REQUEST_LEAD, "");
	const mutates = asksForMutation(text);
	const readOnly =
		!mutates && (taskSentences(text).some((sentence) => sentence.question) || LEADING_READ_TASK.test(request));
	const taskType: AgentTaskType =
		!mutates && RUN_RECORD_TASK.test(request)
			? "run_records"
			: LEADING_READ_TASK.test(request) && !MUTATION_REQUEST.test(request)
				? "code_read"
				: (TASK_TYPE_RULES.find(([, pattern]) => pattern.test(request))?.[0] ?? "unknown");
	const job = jobForTaskShape(taskType, mutates, readOnly);
	const domain = DOMAIN_RULES.find(([, pattern]) => pattern.test(text))?.[0] ?? "general";
	const words = text.split(/\s+/u).filter(Boolean).length;
	const complexity: AgentTaskComplexity =
		words <= 6 ? "trivial" : words <= 25 ? "simple" : words <= 80 ? "moderate" : "complex";
	const enumerated = (text.match(/(^|\n)\s*(\d+[.)]|[-*])\s+/gu) ?? []).length;
	const conjunctions = (text.match(/\b(and then|and also|; )\b/giu) ?? []).length;
	const estimatedSubtasks = Math.max(1, Math.min(4, enumerated > 1 ? enumerated : conjunctions > 0 ? 2 : 1));
	return {
		taskType,
		job,
		complexity,
		domain,
		decomposable: estimatedSubtasks > 1,
		estimatedSubtasks,
		confidence: taskType === "unknown" ? 0.3 : 0.7,
	};
}

export interface AgentTaskIntent {
	selectionMode: "explicit" | "auto";
	baselineAgentId: string;
	approvedAudiences: ReadonlyArray<AgentAudience>;
	approvedAuthorities: ReadonlyArray<AgentAutomationAuthority>;
	requiredTools: ReadonlyArray<ToolName>;
	requiredSkills: ReadonlyArray<string>;
	expectedResultContractKind: ResultContract["kind"] | null;
	locality: "local-only" | "prefer-local" | "any";
	localAgentIds: ReadonlyArray<string>;
	allowedAgentIds: ReadonlyArray<string> | null;
	features: AgentTaskFeatures;
}

export interface AgentCandidateEvaluation {
	agentId: string;
	specFingerprint: string;
	executionRole: ExecutionRole;
	authority: AgentCapabilityClass;
	rejections: ReadonlyArray<string>;
	coldPrior: RoutePrior;
	priorReasons: ReadonlyArray<string>;
}

export interface AgentCandidateSet {
	evaluations: ReadonlyArray<AgentCandidateEvaluation>;
	eligible: ReadonlyArray<AgentCandidateEvaluation>;
}

export interface AgentRouteDimension {
	agentId: string;
	specFingerprint: string;
	executionRole: ExecutionRole;
	latencyClass: AgentSpec["latencyClass"];
	coldPrior: RoutePrior;
}

/** Pure projection from one trusted request into the agent dimension of the joint route universe. */
export function agentRouteCandidates(input: {
	gate?: CapabilityGate;
	specs: ReadonlyArray<AgentSpec>;
	request: DispatchRequest;
	mode: "shadow" | "active";
	activeAgentRoles: ReadonlyArray<{ agentId: string; executionRole: ExecutionRole }>;
	intentOverride?: {
		expectedResultContractKind: ResultContract["kind"];
		requestedAuthority: AgentAutomationAuthority;
	};
}): { evaluations: AgentCandidateEvaluation[]; dimensions: AgentRouteDimension[] } {
	const { request, specs } = input;
	const byId = new Map(specs.map((spec) => [spec.id, spec]));
	const baselineSpec = byId.get(request.agentId);
	const auto = request.agentSelection?.mode === "auto";
	const recovery = (request.lineage?.attempt ?? 0) > 0;
	// Each alternate takes the role this request would run under seated as it: the one rule, over the request's own
	// gate position, write scope and contract (DESIGN 4.2).
	const roleOf = (spec: AgentSpec): ExecutionRole =>
		requestRunRole({ ...request, agentId: spec.id }, () => ({
			capabilityClass: spec.capabilityClass,
			resultContract: spec.resultContract,
		}));
	const allowedAgentIds = recovery
		? [...new Set((request.allowedCandidates ?? []).map((candidate) => candidate.agentId))]
		: input.mode === "active"
			? auto
				? specs
						.filter((spec) => {
							const role = roleOf(spec);
							return input.activeAgentRoles.some((pair) => pair.agentId === spec.id && pair.executionRole === role);
						})
						.map((spec) => spec.id)
				: [request.agentId]
			: null;
	const baselineAuthority = baselineSpec?.capabilityClass;
	const candidates = evaluateAgentCandidates(
		specs,
		{
			selectionMode: auto ? "auto" : "explicit",
			baselineAgentId: request.agentSelection?.baselineAgentId ?? request.agentId,
			approvedAudiences: ["base", "shadow", "custom"],
			approvedAuthorities:
				input.intentOverride !== undefined
					? [input.intentOverride.requestedAuthority]
					: auto
						? (request.agentSelection?.approvedAuthorities ?? [])
						: baselineAuthority !== undefined &&
								AGENT_AUTOMATION_AUTHORITIES.includes(baselineAuthority as AgentAutomationAuthority)
							? [baselineAuthority as AgentAutomationAuthority]
							: [],
			requiredTools: [],
			requiredSkills: [],
			expectedResultContractKind:
				input.intentOverride?.expectedResultContractKind ?? (auto ? null : (baselineSpec?.resultContract.kind ?? null)),
			locality: request.routingIntent?.locality ?? "any",
			localAgentIds: specs.map((spec) => spec.id),
			allowedAgentIds,
			// Always the rules. A decision model never picks for the main agent,
			// and dispatch never waits on one.
			features: classifyAgentTask(request.task),
		},
		roleOf,
	);
	const evaluations = candidates.evaluations.map((evaluation) => ({
		...evaluation,
		executionRole: recovery ? ("recovery" as const) : evaluation.executionRole,
	}));
	const ranked = (input.gate ?? createCapabilityGate()).rank({
		kind: "agents",
		task: request.task,
		candidates: specs
			.filter((spec) => evaluations.some((entry) => entry.agentId === spec.id && entry.rejections.length === 0))
			.map((spec) => ({ id: spec.id, description: spec.description, triggers: spec.tags })),
	});
	const order = new Map(ranked.map((candidate, index) => [candidate.id, index]));
	for (const candidate of evaluations) {
		const index = order.get(candidate.agentId);
		if (index === undefined || candidate.rejections.length > 0) continue;
		candidate.coldPrior = {
			...candidate.coldPrior,
			qualityMean: Math.min(1, candidate.coldPrior.qualityMean + 0.05 / (index + 1)),
		};
		candidate.priorReasons = [...candidate.priorReasons, "capability-relevance"];
	}
	// FW-1: prioritize population without removing the baseline or any admitted fallback.
	const population = [...evaluations].sort((a, b) => (order.get(a.agentId) ?? 100) - (order.get(b.agentId) ?? 100));
	return {
		evaluations,
		dimensions: population
			.filter((evaluation) => evaluation.rejections.length === 0)
			.map((evaluation) => ({
				agentId: evaluation.agentId,
				specFingerprint: evaluation.specFingerprint,
				executionRole: evaluation.executionRole,
				latencyClass: byId.get(evaluation.agentId)?.latencyClass ?? "balanced",
				coldPrior: evaluation.coldPrior,
			})),
	};
}

/** Tag and contract signals per task shape; the recipe itself comes from the job table. */
const TASK_SIGNALS: Readonly<
	Partial<Record<AgentTaskType, { tags: ReadonlyArray<string>; contracts: ReadonlyArray<string> }>>
> = {
	code_read: { tags: ["reconnaissance", "symbols", "codewiki"], contracts: ["scout-report"] },
	research: { tags: ["sources", "external-context", "papers"], contracts: ["research-report"] },
	world_knowledge: {
		tags: ["open-world", "ecosystem", "current-context", "second-opinion"],
		contracts: ["world-knowledge-report"],
	},
	code_review: { tags: ["review", "verification"], contracts: ["review-verdict", "verifier-report"] },
	debug: { tags: ["debugging", "root-cause"], contracts: ["debugger-report"] },
	test: { tags: ["tests", "validation", "regression"], contracts: ["verifier-report"] },
	docs: { tags: ["docs", "runbooks", "examples"], contracts: ["mutation-report"] },
	code_write: { tags: ["implementation", "repair"], contracts: ["mutation-report"] },
	refactor: { tags: ["refactor", "implementation"], contracts: ["mutation-report"] },
	config: { tags: ["implementation", "operations"], contracts: ["mutation-report"] },
};

function coldPrior(features: AgentTaskFeatures, spec: AgentSpec): { prior: RoutePrior; reasons: string[] } {
	const prior = routePriorForLatencyClass(spec.latencyClass);
	const reasons = [`latency-class:${spec.latencyClass}`];
	const signal = TASK_SIGNALS[features.taskType];
	if (signal === undefined) return { prior, reasons };
	const matches =
		spec.id === dispatchJobRecipe(features.job) ||
		spec.tags.some((tag) => signal.tags.includes(tag)) ||
		signal.contracts.includes(spec.resultContract.kind);
	if (!matches) return { prior, reasons };
	const confidence = Math.max(0, Math.min(1, features.confidence));
	prior.qualityMean = Math.min(1, prior.qualityMean + 0.15 * confidence);
	prior.firstPassSuccessProbability = Math.min(1, prior.firstPassSuccessProbability + 0.1 * confidence);
	prior.reliability = Math.min(1, prior.reliability + 0.05 * confidence);
	prior.expectedEndToEndMs *= 1 - 0.15 * confidence;
	reasons.push(`bounded-task-feature:${features.taskType}`);
	return { prior, reasons };
}

function candidateRejections(spec: AgentSpec, intent: AgentTaskIntent): string[] {
	const rejections: string[] = [];
	if (!intent.approvedAudiences.includes(spec.audience)) rejections.push(`audience:${spec.audience}`);
	if (!intent.approvedAuthorities.includes(spec.capabilityClass as AgentAutomationAuthority)) {
		rejections.push(`authority:${spec.capabilityClass}`);
	}
	for (const tool of intent.requiredTools) if (!spec.tools.includes(tool)) rejections.push(`required-tool:${tool}`);
	for (const skill of intent.requiredSkills)
		if (!spec.skills.includes(skill)) rejections.push(`required-skill:${skill}`);
	if (intent.expectedResultContractKind !== null && spec.resultContract.kind !== intent.expectedResultContractKind) {
		rejections.push(`result-contract:${spec.resultContract.kind}`);
	}
	if (intent.locality === "local-only" && !intent.localAgentIds.includes(spec.id)) rejections.push("locality:not-local");
	if (intent.allowedAgentIds !== null && !intent.allowedAgentIds.includes(spec.id))
		rejections.push("governance:not-approved");
	return rejections;
}

/** Hard filters first; display-only category is deliberately never read. */
function evaluateAgentCandidates(
	specs: ReadonlyArray<AgentSpec>,
	intent: AgentTaskIntent,
	roleOf: (spec: AgentSpec) => ExecutionRole,
): AgentCandidateSet {
	if (specs.length > AGENT_CANDIDATE_LIMIT) {
		throw new Error(
			`dispatch routing configuration error: agent candidate overflow (${specs.length}/${AGENT_CANDIDATE_LIMIT})`,
		);
	}
	const evaluations = specs.map((spec): AgentCandidateEvaluation => {
		const { prior, reasons } = coldPrior(intent.features, spec);
		return {
			agentId: spec.id,
			specFingerprint: agentSpecFingerprint(spec),
			executionRole: roleOf(spec),
			authority: spec.capabilityClass,
			rejections: candidateRejections(spec, intent),
			coldPrior: prior,
			priorReasons: reasons,
		};
	});
	return { evaluations, eligible: evaluations.filter((evaluation) => evaluation.rejections.length === 0) };
}

export interface AgentRoleReadinessReport {
	agentId: string;
	specFingerprint: string;
	executionRole: ExecutionRole;
	ready: boolean;
	candidateCount: number;
	readyCandidateCount: number;
	/** Exact-route gaps, projected without pooling observations across tuples. */
	routes: ReadonlyArray<{ candidate: RouteCandidate; report: RouteReadinessReport }>;
}

export function agentRoleReadinessReport(
	entries: ReadonlyArray<{ candidate: RouteCandidate; report: RouteReadinessReport }>,
): ReadonlyArray<AgentRoleReadinessReport> {
	const groups = new Map<string, Array<{ candidate: RouteCandidate; report: RouteReadinessReport }>>();
	for (const entry of entries) {
		const key = `${entry.candidate.agentId}\u0000${entry.candidate.specFingerprint}\u0000${entry.candidate.executionRole}`;
		const group = groups.get(key) ?? [];
		group.push(entry);
		groups.set(key, group);
	}
	return [...groups.values()].map((routes) => ({
		agentId: routes[0]?.candidate.agentId ?? "",
		specFingerprint: routes[0]?.candidate.specFingerprint ?? "",
		executionRole: routes[0]?.candidate.executionRole ?? "builder",
		ready: routes.some((route) => route.report.ready),
		candidateCount: routes.length,
		readyCandidateCount: routes.filter((route) => route.report.ready).length,
		routes,
	}));
}
