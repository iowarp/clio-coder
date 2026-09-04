/** Pure bounded agent admission, cold priors, and agent-role readiness views. */

import type { ToolName } from "../../core/tool-names.js";
import type { ResultContract } from "../agents/result-contract.js";
import {
	AGENT_AUTOMATION_AUTHORITIES,
	type AgentAudience,
	type AgentAutomationAuthority,
	type AgentCapabilityClass,
	type AgentSpec,
	agentSpecFingerprint,
} from "../agents/spec.js";
import type { DispatchRequest } from "./contract.js";
import { deriveExecutionRole, type ExecutionRole } from "./execution-role.js";
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
	| "unknown";
export type AgentTaskComplexity = "trivial" | "simple" | "moderate" | "complex";
export type AgentTaskDomain = "frontend" | "backend" | "infra" | "data" | "security" | "general";

/** Bounded task features. Raw task text never enters a decision or route history. */
export interface AgentTaskFeatures {
	taskType: AgentTaskType;
	complexity: AgentTaskComplexity;
	domain: AgentTaskDomain;
	decomposable: boolean;
	estimatedSubtasks: number;
	confidence: number;
}

const TASK_TYPE_RULES: ReadonlyArray<readonly [AgentTaskType, RegExp]> = [
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
	["code_read", /\b(read|explain|understand|summarize|describe|walk through|map|locate|trace)\b/i],
	["code_write", /\b(write|implement|add|create|build|develop|introduce)\b/i],
];
const DOMAIN_RULES: ReadonlyArray<readonly [AgentTaskDomain, RegExp]> = [
	["security", /\b(security|vulnerabilit|auth|credential|secret|cve)\b/i],
	["frontend", /\b(ui|css|react|component|frontend|tui|overlay)\b/i],
	["infra", /\b(docker|kubernetes|k8s|deploy|terraform|infra|slurm|cluster)\b/i],
	["data", /\b(dataset|etl|pipeline data|schema migration|parquet|hdf5)\b/i],
	["backend", /\b(api|server|endpoint|database|backend|service)\b/i],
];

export function classifyAgentTask(task: string): AgentTaskFeatures {
	const text = task.trim();
	const taskType = TASK_TYPE_RULES.find(([, pattern]) => pattern.test(text))?.[0] ?? "unknown";
	const domain = DOMAIN_RULES.find(([, pattern]) => pattern.test(text))?.[0] ?? "general";
	const words = text.split(/\s+/u).filter(Boolean).length;
	const complexity: AgentTaskComplexity =
		words <= 6 ? "trivial" : words <= 25 ? "simple" : words <= 80 ? "moderate" : "complex";
	const enumerated = (text.match(/(^|\n)\s*(\d+[.)]|[-*])\s+/gu) ?? []).length;
	const conjunctions = (text.match(/\b(and then|and also|; )\b/giu) ?? []).length;
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
	const allowedAgentIds = recovery
		? [...new Set((request.allowedCandidates ?? []).map((candidate) => candidate.agentId))]
		: input.mode === "active"
			? auto
				? specs
						.filter((spec) => {
							const role = deriveExecutionRole({
								attempt: 0,
								capabilityClass: spec.capabilityClass,
								resultContractKind: spec.resultContract.kind,
							});
							return input.activeAgentRoles.some((pair) => pair.agentId === spec.id && pair.executionRole === role);
						})
						.map((spec) => spec.id)
				: [request.agentId]
			: null;
	const baselineAuthority = baselineSpec?.capabilityClass;
	const candidates = evaluateAgentCandidates(specs, {
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
		features: classifyAgentTask(request.task),
	});
	const evaluations = candidates.evaluations.map((evaluation) => ({
		...evaluation,
		executionRole: recovery ? ("recovery" as const) : evaluation.executionRole,
	}));
	return {
		evaluations,
		dimensions: evaluations
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

const TASK_SIGNALS: Readonly<
	Partial<
		Record<AgentTaskType, { ids: ReadonlyArray<string>; tags: ReadonlyArray<string>; contracts: ReadonlyArray<string> }>
	>
> = {
	code_read: { ids: ["scout"], tags: ["reconnaissance", "symbols", "codewiki"], contracts: ["scout-report"] },
	research: { ids: ["researcher"], tags: ["sources", "external-context", "papers"], contracts: ["research-report"] },
	world_knowledge: {
		ids: ["world-knowledge"],
		tags: ["open-world", "ecosystem", "current-context", "second-opinion"],
		contracts: ["world-knowledge-report"],
	},
	code_review: { ids: ["verifier"], tags: ["review", "verification"], contracts: ["verifier-report"] },
	debug: { ids: ["debugger"], tags: ["debugging", "root-cause"], contracts: ["debugger-report"] },
	test: { ids: ["verifier", "tester"], tags: ["tests", "validation", "regression"], contracts: ["verifier-report"] },
	docs: { ids: ["documenter"], tags: ["docs", "runbooks", "examples"], contracts: ["mutation-report"] },
	code_write: { ids: ["coder"], tags: ["implementation", "repair"], contracts: ["mutation-report"] },
	refactor: { ids: ["coder"], tags: ["refactor", "implementation"], contracts: ["mutation-report"] },
	config: { ids: ["coder"], tags: ["implementation", "operations"], contracts: ["mutation-report"] },
};

function coldPrior(features: AgentTaskFeatures, spec: AgentSpec): { prior: RoutePrior; reasons: string[] } {
	const prior = routePriorForLatencyClass(spec.latencyClass);
	const reasons = [`latency-class:${spec.latencyClass}`];
	const signal = TASK_SIGNALS[features.taskType];
	if (signal === undefined) return { prior, reasons };
	const matches =
		signal.ids.includes(spec.id) ||
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
function evaluateAgentCandidates(specs: ReadonlyArray<AgentSpec>, intent: AgentTaskIntent): AgentCandidateSet {
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
			executionRole: deriveExecutionRole({
				attempt: 0,
				capabilityClass: spec.capabilityClass,
				resultContractKind: spec.resultContract.kind,
			}),
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
