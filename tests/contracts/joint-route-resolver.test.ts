import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	emptyJointHardFilterVerdicts,
	JOINT_ROUTE_FALLBACK_LIMIT,
	JOINT_ROUTE_UNIVERSE_LIMIT,
	type JointAgentDimension,
	type JointNodeDimension,
	type JointRouteResolverInput,
	type JointTargetDimension,
	resolveJointRoute,
} from "../../src/domains/dispatch/joint-route-resolver.js";
import type { RouteCandidate } from "../../src/domains/dispatch/route-decision.js";
import { evaluateRouteFacts, type NodeTargetFact } from "../../src/domains/dispatch/route-facts.js";
import {
	estimateRoute,
	type RouteObservation,
	routePriorForLatencyClass,
} from "../../src/domains/dispatch/route-policy.js";
import type { RoutingIntent } from "../../src/domains/dispatch/routing-intent.js";

const intent: RoutingIntent = {
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

function candidate(targetDimension: JointTargetDimension, node: JointNodeDimension): RouteCandidate {
	return {
		agentId: "coder",
		specFingerprint: "spec",
		executionRole: "builder",
		targetId: targetDimension.targetId,
		modelId: targetDimension.modelId,
		runtimeId: targetDimension.runtimeId,
		nodeId: node.nodeId,
		toolSignature: "tools",
		promptCompositionHash: "prompt",
		endpointIdentityHash: targetDimension.endpointIdentityHash,
		settingsFingerprint: "settings",
	};
}

function agent(latencyClass: "fast" | "balanced" | "deep" = "balanced"): JointAgentDimension {
	return {
		agentId: "coder",
		specFingerprint: "spec",
		executionRole: "builder",
		latencyClass,
		coldPrior: routePriorForLatencyClass(latencyClass),
	};
}

function resolverInput(
	options: {
		targets?: JointTargetDimension[];
		nodes?: JointNodeDimension[];
		filter?: (target: JointTargetDimension, node: JointNodeDimension) => string | null;
		observations?: (target: JointTargetDimension, node: JointNodeDimension) => RouteObservation[];
		latencyClass?: "fast" | "balanced" | "deep";
		universeLimit?: number;
		posture?: RoutingIntent["posture"];
	} = {},
): JointRouteResolverInput {
	const targets = options.targets ?? [target("a")];
	const nodes = options.nodes ?? [{ nodeId: "local" }];
	const executedRoute = candidate(targets[0] as JointTargetDimension, nodes[0] as JointNodeDimension);
	const selectedAgent = agent(options.latencyClass);
	return {
		mode: "shadow",
		agents: [selectedAgent],
		agentSelection: {
			request: "explicit",
			baselineAgentId: "coder",
			evaluations: [
				{
					agentId: selectedAgent.agentId,
					specFingerprint: selectedAgent.specFingerprint,
					executionRole: selectedAgent.executionRole,
					authority: "workspace-edit",
					rejections: [],
					coldPrior: selectedAgent.coldPrior,
					priorReasons: [],
				},
			],
			authorityBasis: null,
		},
		executedRoute,
		targets,
		nodes,
		intent: { ...intent, posture: options.posture ?? "balanced" },
		independenceSubject: null,
		...(options.universeLimit !== undefined ? { universeLimit: options.universeLimit } : {}),
		project(projectedAgent, targetDimension, node) {
			const filters = emptyJointHardFilterVerdicts();
			const rejection = options.filter?.(targetDimension, node) ?? null;
			if (rejection !== null) filters["endpoint-reachability"] = rejection;
			return {
				candidate: {
					...candidate(targetDimension, node),
					agentId: projectedAgent.agentId,
					specFingerprint: projectedAgent.specFingerprint,
					executionRole: projectedAgent.executionRole,
				},
				hardFilters: filters,
				observations: options.observations?.(targetDimension, node) ?? Array.from({ length: 6 }, () => observation()),
				capabilities: [],
				readiness: {
					hardConstraintValidity: 1,
					integrityFailures: 0,
					costUpperBoundUsd: 0.2,
					factsFresh: true,
					decisionP95Ms: 1,
				},
			};
		},
	};
}

function fact(nodeId: string, targetId: string, reachable: NodeTargetFact["reachable"]): NodeTargetFact {
	return {
		nodeId,
		targetId,
		reachable,
		runtimeCompatible: "true",
		modelAvailable: "true",
		modelResident: "unknown",
		endpointIdentityHash: `endpoint-${targetId}`,
		wireModelId: `model-${targetId}`,
		probedAt: "2026-07-20T00:00:00.000Z",
		probeDurationMs: 1,
	};
}

describe("joint route resolver", () => {
	it("target and node are enumerated as a cross-product", () => {
		const decision = resolveJointRoute(
			resolverInput({ targets: [target("a"), target("b")], nodes: [{ nodeId: "n1" }, { nodeId: "n2" }] }),
		).decision;
		deepStrictEqual(
			decision.candidateEvaluations.map(({ candidate }) => `${candidate.targetId}/${candidate.nodeId}`),
			["a/n1", "a/n2", "b/n1", "b/n2"],
		);
	});

	it("node-local target reachability rejects only the invalid tuples", () => {
		const facts = [fact("n1", "a", "true"), fact("n2", "a", "false"), fact("n1", "b", "true"), fact("n2", "b", "true")];
		const decision = resolveJointRoute(
			resolverInput({
				targets: [target("a"), target("b")],
				nodes: [{ nodeId: "n1" }, { nodeId: "n2" }],
				filter(targetDimension, node) {
					const verdict = evaluateRouteFacts(
						facts,
						[],
						{
							nodeId: node.nodeId,
							targetId: targetDimension.targetId,
							wireModelId: targetDimension.modelId,
							endpointIdentityHash: targetDimension.endpointIdentityHash,
							requireReachable: true,
							requireRuntimeCompatible: true,
							requireModelAvailable: true,
							requireGpuCount: null,
							requireVramBytes: null,
							mode: "shadow",
						},
						{ now: Date.parse("2026-07-20T00:01:00.000Z") },
					);
					return verdict.ok ? null : verdict.reason;
				},
			}),
		).decision;
		deepStrictEqual(
			decision.candidateEvaluations
				.filter((entry) => entry.rejection !== null)
				.map((entry) => `${entry.candidate.targetId}/${entry.candidate.nodeId}`),
			["a/n2"],
		);
	});

	it("cooldown routes around one target without denying the dispatch", () => {
		const input = resolverInput({ targets: [target("cool"), target("healthy")], nodes: [{ nodeId: "local" }] });
		const originalProject = input.project;
		input.project = (projectedAgent, targetDimension, node) => {
			const projection = originalProject(projectedAgent, targetDimension, node);
			const filters = { ...projection.hardFilters };
			if (targetDimension.targetId === "cool") filters.cooldown = "target tuple cooling down";
			return { ...projection, hardFilters: filters };
		};
		const decision = resolveJointRoute(input).decision;
		strictEqual(decision.selected.targetId, "healthy");
		strictEqual(decision.candidateEvaluations.filter((entry) => entry.rejection !== null).length, 1);
	});

	it("resource fit rejects only the node model tuple it describes", () => {
		const input = resolverInput({ targets: [target("a"), target("b")], nodes: [{ nodeId: "gpu" }, { nodeId: "cpu" }] });
		const originalProject = input.project;
		input.project = (projectedAgent, targetDimension, node) => {
			const projection = originalProject(projectedAgent, targetDimension, node);
			const filters = { ...projection.hardFilters };
			if (targetDimension.targetId === "b" && node.nodeId === "cpu")
				filters["resource-fit"] = "VRAM requirement is not met";
			return { ...projection, hardFilters: filters };
		};
		const decision = resolveJointRoute(input).decision;
		deepStrictEqual(
			decision.candidateEvaluations
				.filter((entry) => entry.rejection !== null)
				.map((entry) => `${entry.candidate.targetId}/${entry.candidate.nodeId}`),
			["b/cpu"],
		);
	});

	it("quality cost latency reliability and cache signals use eligible denominators", () => {
		const estimate = estimateRoute([
			observation(),
			observation({
				qualityLabel: "unmeasured",
				reliability: "neutral",
				completedCostUsd: null,
				completedEndToEndMs: null,
			}),
			observation({ qualityLabel: "fail", reliability: "failure", completedCostUsd: null, completedEndToEndMs: null }),
			observation({ cacheRead: true, completedCostUsd: 0.3, completedEndToEndMs: 300, queueWaitMs: 20 }),
		]);
		strictEqual(estimate.qualityLabeledCount, 3);
		strictEqual(estimate.unmeasuredCount, 1);
		strictEqual(estimate.qualityMean, 2 / 3);
		strictEqual(estimate.cacheHitProbability, 1 / 2);
		ok(estimate.reliability < 1);
		ok(estimate.expectedCostUsd > 0.1);
		ok(estimate.expectedEndToEndMs > 100);
	});

	it("cold latency classes affect priors and measured latency supersedes them", () => {
		const fast = estimateRoute([], routePriorForLatencyClass("fast"));
		const balanced = estimateRoute([], routePriorForLatencyClass("balanced"));
		const deep = estimateRoute([], routePriorForLatencyClass("deep"));
		ok(fast.expectedEndToEndMs < balanced.expectedEndToEndMs);
		ok(balanced.expectedEndToEndMs < deep.expectedEndToEndMs);
		const fastMeasured = estimateRoute(
			Array.from({ length: 100 }, () => observation({ completedEndToEndMs: 5000 })),
			routePriorForLatencyClass("fast"),
		);
		const deepMeasured = estimateRoute(
			Array.from({ length: 100 }, () => observation({ completedEndToEndMs: 5000 })),
			routePriorForLatencyClass("deep"),
		);
		ok(Math.abs(fastMeasured.expectedEndToEndMs - deepMeasured.expectedEndToEndMs) < 13_000);
	});

	it("universe overflow fails explicitly rather than truncating", () => {
		throws(
			() =>
				resolveJointRoute(
					resolverInput({
						targets: [target("a"), target("b")],
						nodes: [{ nodeId: "n1" }, { nodeId: "n2" }],
						universeLimit: 3,
					}),
				),
			/joint route universe overflow \(4\/3\)/,
		);
	});

	it("decision p95 remains below 10 ms for the maximum supported universe", () => {
		const targets = Array.from({ length: 16 }, (_, index) => target(`t${index}`));
		const nodes = Array.from({ length: JOINT_ROUTE_UNIVERSE_LIMIT / targets.length }, (_, index) => ({
			nodeId: `n${index}`,
		}));
		const input = resolverInput({ targets, nodes, observations: () => [] });
		// This is a routing-readiness contract, not a throughput benchmark: an
		// active route is ineligible when its measured decision p95 exceeds the
		// same 10 ms bound. Warm the JIT and allocations before sampling, and use
		// process CPU time so unrelated host load cannot turn release correctness
		// red merely because this process was descheduled.
		for (let index = 0; index < 100; index += 1) resolveJointRoute(input);
		const durations: number[] = [];
		for (let index = 0; index < 200; index += 1) {
			const started = process.cpuUsage();
			resolveJointRoute(input);
			const elapsed = process.cpuUsage(started);
			durations.push((elapsed.user + elapsed.system) / 1_000);
		}
		durations.sort((left, right) => left - right);
		const p95 = durations[Math.ceil(durations.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
		ok(p95 < 10, `decision p95 ${p95.toFixed(3)} ms exceeded 10 ms`);
	});

	it("fallback bounding occurs after hard filters and ranking", () => {
		const targets = [target("a"), target("b"), target("c"), target("d"), target("e")];
		const decision = resolveJointRoute(
			resolverInput({
				targets,
				nodes: [{ nodeId: "local" }],
				posture: "economy",
				filter: (targetDimension) => (targetDimension.targetId === "a" ? "not admissible" : null),
				observations: (targetDimension) =>
					Array.from({ length: 6 }, () =>
						observation({ completedCostUsd: targets.findIndex((entry) => entry.targetId === targetDimension.targetId) + 1 }),
					),
			}),
		).decision;
		strictEqual(decision.candidateEvaluations.length, 5);
		strictEqual(decision.selected.targetId, "b");
		strictEqual(decision.approvedFallbacks.length, JOINT_ROUTE_FALLBACK_LIMIT);
		ok(decision.approvedFallbacks.every((route) => route.targetId !== "a"));
	});
});
