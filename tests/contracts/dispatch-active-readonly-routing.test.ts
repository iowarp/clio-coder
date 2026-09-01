import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { validateSettings } from "../../src/core/config.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { consumeActiveRouteApproval } from "../../src/domains/dispatch/active-route-planner.js";
import { activeRoutingEnabled, applyActiveRouteSelection } from "../../src/domains/dispatch/assignment.js";
import type { DispatchRequest } from "../../src/domains/dispatch/contract.js";
import type { RouteCorrelationFacts } from "../../src/domains/dispatch/execution-role.js";
import {
	emptyJointHardFilterVerdicts,
	type JointAgentDimension,
	type JointNodeDimension,
	type JointRouteResolverInput,
	type JointTargetDimension,
	type JointTupleProjection,
	resolveJointRoute,
} from "../../src/domains/dispatch/joint-route-resolver.js";
import {
	approvedRouteCandidates,
	assertApprovedAssignmentRoute,
	assertApprovedRecoveryCapability,
} from "../../src/domains/dispatch/route-approval.js";
import type { RouteCandidate } from "../../src/domains/dispatch/route-decision.js";
import {
	ROUTE_POSTURES,
	type RouteObservation,
	routePriorForLatencyClass,
} from "../../src/domains/dispatch/route-policy.js";
import {
	DECISION_LATENCY_BUDGET_MS,
	evaluateRouteReadiness,
	MINIMUM_ACTIVE_QUALITY_LABELS,
	type RouteReadinessInput,
} from "../../src/domains/dispatch/route-readiness.js";
import type { RoutingIntent } from "../../src/domains/dispatch/routing-intent.js";

const ACTIVE_INTENT: RoutingIntent = {
	posture: "balanced",
	maxCostUsd: null,
	deadlineMs: null,
	minimumQuality: null,
	requiredCapabilities: [],
	locality: "any",
	failover: "approved",
};

function observation(overrides: Partial<RouteObservation> = {}): RouteObservation {
	return {
		qualityLabel: "pass",
		reliability: "success",
		firstPass: true,
		completedCostUsd: 0.1,
		completedEndToEndMs: 100,
		cacheRead: false,
		queueWaitMs: 0,
		...overrides,
	};
}

function target(id: string, modelId = `model-${id}`): JointTargetDimension {
	return {
		targetId: id,
		modelId,
		runtimeId: "llamacpp",
		endpointIdentityHash: `endpoint-${id}`,
	};
}

function candidate(
	targetDimension: JointTargetDimension,
	node: JointNodeDimension,
	overrides: Partial<RouteCandidate> = {},
): RouteCandidate {
	return {
		agentId: "scout",
		specFingerprint: "spec-scout",
		executionRole: "researcher",
		targetId: targetDimension.targetId,
		modelId: targetDimension.modelId,
		runtimeId: targetDimension.runtimeId,
		nodeId: node.nodeId,
		thinkingLevel: "off",
		toolSignature: "read",
		promptCompositionHash: "prompt",
		endpointIdentityHash: targetDimension.endpointIdentityHash,
		settingsFingerprint: "settings",
		...overrides,
	};
}

function agentDimension(agentId: string, executionRole: RouteCandidate["executionRole"]): JointAgentDimension {
	return {
		agentId,
		specFingerprint: `spec-${agentId}`,
		executionRole,
		latencyClass: "balanced",
		coldPrior: routePriorForLatencyClass("balanced"),
	};
}

function resolverInput(options: {
	targets?: JointTargetDimension[];
	role?: RouteCandidate["executionRole"];
	agentId?: string;
	intent?: RoutingIntent;
	observations?: (target: JointTargetDimension) => RouteObservation[];
	filter?: (target: JointTargetDimension) => string | null;
	readiness?: Partial<JointTupleProjection["readiness"]>;
	independenceSubject?: RouteCorrelationFacts | null;
}): JointRouteResolverInput {
	const targets = options.targets ?? [target("a"), target("b")];
	const node = { nodeId: "local" };
	const role = options.role ?? "researcher";
	const agentId = options.agentId ?? "scout";
	const executedRoute = candidate(targets[0] as JointTargetDimension, node, { agentId, executionRole: role });
	const selectedAgent = agentDimension(agentId, role);
	return {
		mode: "active",
		agents: [selectedAgent],
		agentSelection: {
			request: "explicit",
			baselineAgentId: agentId,
			evaluations: [
				{
					agentId,
					specFingerprint: selectedAgent.specFingerprint,
					executionRole: role,
					authority: "read-only",
					rejections: [],
					coldPrior: selectedAgent.coldPrior,
					priorReasons: [],
				},
			],
			authorityBasis: null,
		},
		executedRoute,
		targets,
		nodes: [node],
		intent: options.intent ?? ACTIVE_INTENT,
		independenceSubject: options.independenceSubject ?? null,
		project(projectedAgent, targetDimension, projectedNode) {
			const hardFilters = emptyJointHardFilterVerdicts();
			const rejection = options.filter?.(targetDimension) ?? null;
			if (rejection !== null) hardFilters.authority = rejection;
			return {
				candidate: candidate(targetDimension, projectedNode, {
					agentId: projectedAgent.agentId,
					specFingerprint: projectedAgent.specFingerprint,
					executionRole: projectedAgent.executionRole,
				}),
				hardFilters,
				observations:
					options.observations?.(targetDimension) ??
					Array.from({ length: MINIMUM_ACTIVE_QUALITY_LABELS }, () => observation()),
				capabilities: [],
				readiness: {
					hardConstraintValidity: 1,
					integrityFailures: 0,
					costUpperBoundUsd: 0.2,
					factsFresh: true,
					decisionP95Ms: 1,
					...options.readiness,
				},
			};
		},
	};
}

function readinessInput(overrides: Partial<RouteReadinessInput> = {}): RouteReadinessInput {
	return {
		estimate: {
			qualityLabeledCount: 6,
			unmeasuredCount: 0,
			qualityCoverage: 1,
			qualityMean: 1,
			qualityLowerBound: 0.95,
			firstPassSuccessProbability: 1,
			expectedCostUsd: 0.1,
			costUpperBoundUsd: 0.2,
			expectedEndToEndMs: 100,
			p95EndToEndMs: 200,
			reliability: 1,
			cacheHitProbability: 0,
			queueWaitMs: 0,
			sampleCount: 6,
			confidence: 1,
		},
		posture: "balanced",
		hardConstraintValidity: 1,
		integrityFailures: 0,
		costUpperBoundUsd: 0.2,
		factsFresh: true,
		decisionP95Ms: 1,
		requestedMinimumQuality: null,
		...overrides,
	};
}

function request(): DispatchRequest {
	return {
		agentId: "scout",
		executionRole: "researcher",
		task: "inspect this repository",
		routingIntent: ACTIVE_INTENT,
		failover: "approved",
		allowedCandidates: [
			{ agentId: "scout", target: "a", model: "model-a", node: "local" },
			{ agentId: "scout", target: "b", model: "model-b", node: "local" },
		],
	};
}

describe("contracts/dispatch active read-only routing", () => {
	it("default settings remain shadow-only", () => {
		deepStrictEqual(DEFAULT_SETTINGS.fleet.adaptiveRouting, {
			roles: [],
			postures: [],
			agentRoles: [],
		});
		strictEqual(
			activeRoutingEnabled({
				settings: DEFAULT_SETTINGS.fleet.adaptiveRouting,
				role: "researcher",
				posture: "balanced",
				capabilityClass: "read-only",
				failover: "approved",
			}),
			false,
		);
		const configured = validateSettings({
			fleet: {
				adaptiveRouting: {
					roles: ["researcher"],
					postures: ["balanced"],
					agentRoles: [],
				},
			},
		});
		deepStrictEqual(configured.issues, []);
		deepStrictEqual(configured.settings.fleet.adaptiveRouting, {
			roles: ["researcher"],
			postures: ["balanced"],
			agentRoles: [],
		});
	});

	it("active readiness names every unmet prerequisite", () => {
		const report = evaluateRouteReadiness(
			readinessInput({
				estimate: { ...readinessInput().estimate, qualityLabeledCount: 0, qualityLowerBound: 0, reliability: 0 },
				hardConstraintValidity: 0,
				integrityFailures: 1,
				costUpperBoundUsd: null,
				factsFresh: false,
				decisionP95Ms: DECISION_LATENCY_BUDGET_MS + 1,
				requestedMinimumQuality: 0.9,
			}),
		);
		deepStrictEqual(report.gaps, [
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
	});

	it("active read-only route executes the selected joint tuple", () => {
		const input = resolverInput({
			intent: { ...ACTIVE_INTENT, posture: "economy" },
			observations: (dimension) =>
				Array.from({ length: 6 }, () => observation({ completedCostUsd: dimension.targetId === "b" ? 0.01 : 1 })),
		});
		const decision = resolveJointRoute(input).decision;
		strictEqual(decision.selected.targetId, "b");
		const approval = {
			version: 1 as const,
			decision,
			totalCostUpperBoundUsd: 0.6,
			deadlineMs: 60_000,
			maxAttempts: 3,
		};
		assertApprovedAssignmentRoute(approval);
		deepStrictEqual(approvedRouteCandidates(approval)[0], {
			agentId: "scout",
			target: "b",
			model: "model-b",
			node: "local",
		});
		const applied = applyActiveRouteSelection(request(), decision);
		deepStrictEqual(
			[applied.target, applied.model, applied.workerRuntime, applied.node],
			["b", "model-b", "llamacpp", "local"],
		);
	});

	it("unmeasured quality refuses active routing", () => {
		throws(
			() => resolveJointRoute(resolverInput({ observations: () => [] })),
			/no-active-eligible-candidate.*insufficient-quality-labels/u,
		);
	});

	it("quality lower bound and reliability floors both apply", () => {
		const floors = ROUTE_POSTURES.quality.floors;
		const quality = evaluateRouteReadiness(
			readinessInput({
				posture: "quality",
				estimate: { ...readinessInput().estimate, qualityLowerBound: floors.qualityLowerBound - 0.01 },
			}),
		);
		const reliability = evaluateRouteReadiness(
			readinessInput({
				posture: "quality",
				estimate: { ...readinessInput().estimate, reliability: floors.reliability - 0.01 },
			}),
		);
		deepStrictEqual(quality.gaps, ["quality-lower-bound-below-posture-floor"]);
		deepStrictEqual(reliability.gaps, ["reliability-below-posture-floor"]);
	});

	it("reviewer independence breaks an admissible tie", () => {
		const subject: RouteCorrelationFacts = {
			agentId: "coder",
			targetId: "builder",
			wireModelId: "model-a",
			runtimeId: "llamacpp",
			nodeId: "local",
		};
		const decision = resolveJointRoute(
			resolverInput({
				agentId: "verifier",
				role: "reviewer",
				targets: [target("a", "model-a"), target("b", "independent-model")],
				independenceSubject: subject,
			}),
		).decision;
		strictEqual(decision.selected.modelId, "independent-model");
	});

	it("hard constraints override independence and posture score", () => {
		const subject: RouteCorrelationFacts = {
			agentId: "coder",
			targetId: "builder",
			wireModelId: "model-a",
			runtimeId: "llamacpp",
			nodeId: "local",
		};
		const decision = resolveJointRoute(
			resolverInput({
				agentId: "verifier",
				role: "reviewer",
				targets: [target("a", "model-a"), target("b", "independent-model")],
				independenceSubject: subject,
				filter: (dimension) => (dimension.targetId === "b" ? "outside governance" : null),
			}),
		).decision;
		strictEqual(decision.selected.modelId, "model-a");
		strictEqual(decision.candidateEvaluations[1]?.score, null);
	});

	it("approved fallback boundary re-evaluates only envelope members", () => {
		const decision = resolveJointRoute(
			resolverInput({
				targets: [target("a"), target("b"), target("outside")],
				filter: (dimension) => (dimension.targetId === "outside" ? "outside approved envelope" : null),
			}),
		).decision;
		strictEqual(decision.candidateEvaluations.length, 3);
		ok(decision.candidateEvaluations.find((entry) => entry.candidate.targetId === "outside")?.rejection !== null);
		ok(decision.approvedFallbacks.every((entry) => entry.targetId !== "outside"));
		const approval = {
			version: 1 as const,
			decision,
			totalCostUpperBoundUsd: 1,
			deadlineMs: 60_000,
			maxAttempts: 2,
		};
		const recovery = resolveJointRoute(resolverInput({ targets: [target("b")], role: "recovery" })).decision;
		assertApprovedRecoveryCapability(approval, recovery.selected);
		const consumed = consumeActiveRouteApproval({
			request: {
				...request(),
				lineage: { parentRunId: "first", rootRunId: "first", attempt: 1, depth: 0 },
				assignmentDeadlineAt: 123_456,
				routeApproval: approval,
				routeAttemptDecision: recovery,
			},
			settings: {
				roles: ["researcher"],
				postures: ["balanced"],
				agentRoles: [],
			},
			capabilityClass: "read-only",
			failover: "approved",
			requestedAt: new Date(0).toISOString(),
			observe: (_request, active) => active,
		});
		strictEqual(consumed?.observation.mode, "active");
		strictEqual(consumed?.observation.selected.executionRole, "recovery");
		strictEqual(consumed?.request.target, "b");
		strictEqual(consumed?.request.assignmentDeadlineAt, 123_456);
	});

	it("manual and failover-none routes never drift", () => {
		const settings = {
			roles: ["researcher"] as const,
			postures: ["balanced"] as const,
			agentRoles: [],
		};
		strictEqual(
			activeRoutingEnabled({
				settings,
				role: "researcher",
				posture: "balanced",
				capabilityClass: "read-only",
				failover: "none",
			}),
			false,
		);
		strictEqual(
			activeRoutingEnabled({
				settings,
				role: "researcher",
				posture: "manual",
				capabilityClass: "read-only",
				failover: "none",
			}),
			false,
		);
	});

	it("active decision selected and executed identities are equal", () => {
		const decision = resolveJointRoute(resolverInput({})).decision;
		deepStrictEqual(decision.executedRoute, decision.selected);
		strictEqual(decision.mode, "active");
	});
});
