import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	decideRoute,
	type RouteCandidate,
	type RouteCandidateInput,
	type RouteDecisionInput,
	routeCandidateKey,
	routeConstraintValidity,
	routeDecisionHash,
} from "../../src/domains/dispatch/route-decision.js";
import {
	clearsPostureFloors,
	DEFAULT_ROUTE_PRIOR,
	estimateRoute,
	type RouteObservation,
	wilsonLowerBound,
} from "../../src/domains/dispatch/route-policy.js";
import type { RouteReadinessReport } from "../../src/domains/dispatch/route-readiness.js";

const READY: RouteReadinessReport = { ready: true, gaps: [], labelsNeeded: 0 };

function candidate(overrides: Partial<RouteCandidate> = {}): RouteCandidate {
	return {
		agentId: "coder",
		specFingerprint: "spec-a",
		executionRole: "builder",
		targetId: "primary",
		modelId: "model-a",
		runtimeId: "openai",
		nodeId: "local",
		toolSignature: "tools-a",
		promptCompositionHash: "prompt-a",
		endpointIdentityHash: "endpoint-a",
		settingsFingerprint: "settings-a",
		...overrides,
	};
}

function sample(overrides: Partial<RouteObservation> = {}): RouteObservation {
	return {
		qualityLabel: "pass",
		reliability: "success",
		firstPass: true,
		completedCostUsd: 0.1,
		completedEndToEndMs: 10_000,
		cacheRead: false,
		queueWaitMs: 0,
		...overrides,
	};
}

function estimate(count: number, overrides: Partial<RouteObservation> = {}) {
	return estimateRoute(Array.from({ length: count }, () => sample(overrides)));
}

function explicitAgentSelection(
	executedRoute: RouteCandidate,
	candidates: ReadonlyArray<RouteCandidateInput>,
): RouteDecisionInput["agentSelection"] {
	const groups = new Map<string, RouteCandidateInput[]>();
	for (const entry of candidates) {
		const key = `${entry.candidate.agentId}\u0000${entry.candidate.specFingerprint}\u0000${entry.candidate.executionRole}`;
		const group = groups.get(key) ?? [];
		group.push(entry);
		groups.set(key, group);
	}
	return {
		request: "explicit",
		baselineAgentId: executedRoute.agentId,
		evaluations: [...groups.values()].map(([entry]) => ({
			agentId: entry?.candidate.agentId ?? executedRoute.agentId,
			specFingerprint: entry?.candidate.specFingerprint ?? executedRoute.specFingerprint,
			executionRole: entry?.candidate.executionRole ?? executedRoute.executionRole,
			authority: "workspace-edit",
			rejections: [],
			coldPrior: DEFAULT_ROUTE_PRIOR,
			priorReasons: [],
		})),
		readiness: [...groups.values()].map((entries) => ({
			agentId: entries[0]?.candidate.agentId ?? executedRoute.agentId,
			specFingerprint: entries[0]?.candidate.specFingerprint ?? executedRoute.specFingerprint,
			executionRole: entries[0]?.candidate.executionRole ?? executedRoute.executionRole,
			ready: entries.some((entry) => entry.activeReadiness.ready),
			candidateCount: entries.length,
			readyCandidateCount: entries.filter((entry) => entry.activeReadiness.ready).length,
			routes: entries.map((entry) => ({ candidate: entry.candidate, report: entry.activeReadiness })),
		})),
		authorityBasis: null,
	};
}

function input(overrides: Partial<RouteDecisionInput> = {}): RouteDecisionInput {
	const executedRoute = overrides.executedRoute ?? candidate();
	const candidates: ReadonlyArray<RouteCandidateInput> = overrides.candidates ?? [
		{ candidate: executedRoute, estimate: estimateRoute([]), activeReadiness: READY, rejection: null },
	];
	return {
		mode: "shadow",
		posture: "balanced",
		executedRoute,
		candidates,
		independenceSubject: null,
		hardConstraints: ["target-auth-and-availability"],
		maxFallbacks: 2,
		decisionDurationMs: 0,
		agentSelection: overrides.agentSelection ?? explicitAgentSelection(executedRoute, candidates),
		...overrides,
	};
}

describe("route decision", () => {
	it("decision hash covers route estimates readiness and agent evidence", () => {
		const baseline = input();
		const route = baseline.candidates[0];
		const evaluation = baseline.agentSelection.evaluations[0];
		const readiness = baseline.agentSelection.readiness[0];
		if (route === undefined || evaluation === undefined || readiness === undefined) throw new Error("missing fixture");
		const notReady = {
			ready: false,
			gaps: ["insufficient-quality-labels" as const],
			labelsNeeded: 1,
		};
		const variants: RouteDecisionInput[] = [
			{
				...baseline,
				candidates: [{ ...route, candidate: { ...route.candidate, nodeId: "alternate" } }],
			},
			{
				...baseline,
				candidates: [{ ...route, estimate: { ...route.estimate, expectedCostUsd: 2 } }],
			},
			{
				...baseline,
				candidates: [{ ...route, activeReadiness: notReady }],
			},
			{
				...baseline,
				agentSelection: {
					...baseline.agentSelection,
					evaluations: [{ ...evaluation, coldPrior: { ...evaluation.coldPrior, expectedEndToEndMs: 1 } }],
				},
			},
			{
				...baseline,
				agentSelection: {
					...baseline.agentSelection,
					readiness: [
						{
							...readiness,
							ready: false,
							readyCandidateCount: 0,
							routes: [{ candidate: readiness.routes[0]?.candidate ?? route.candidate, report: notReady }],
						},
					],
				},
			},
		];
		strictEqual(new Set([routeDecisionHash(baseline), ...variants.map(routeDecisionHash)]).size, variants.length + 1);
	});

	it("never selects a hard-rejected candidate", () => {
		const executed = candidate();
		const rejected = candidate({ targetId: "forbidden" });
		const decision = decideRoute(
			input({
				candidates: [
					{ candidate: executed, estimate: estimate(6, { completedCostUsd: 5 }), activeReadiness: READY, rejection: null },
					{
						candidate: rejected,
						estimate: estimate(6, { completedCostUsd: 0.001 }),
						activeReadiness: READY,
						rejection: "target-auth",
					},
				],
			}),
		);
		strictEqual(routeCandidateKey(decision.selected), routeCandidateKey(executed));
		strictEqual(decision.candidateEvaluations[1]?.score, null);
		deepStrictEqual(routeConstraintValidity(decision), {
			selectedAdmissible: true,
			executedAdmissible: true,
			fallbacksAdmissible: true,
			valid: true,
		});
	});

	it("uses a conservative Wilson lower bound and six labels for posture floors", () => {
		const fivePasses = estimate(5);
		const sixPasses = estimate(6);
		strictEqual(fivePasses.qualityLabeledCount, 5);
		strictEqual(clearsPostureFloors(fivePasses, "balanced"), false);
		strictEqual(sixPasses.qualityLowerBound, wilsonLowerBound(6, 6));
		strictEqual(sixPasses.qualityLowerBound > 0.6, true);
		strictEqual(clearsPostureFloors(sixPasses, "balanced"), true);
	});

	it("does not let fast failures improve completed cost or latency", () => {
		const failed = estimateRoute([
			sample({
				qualityLabel: "fail",
				reliability: "failure",
				firstPass: false,
				completedCostUsd: null,
				completedEndToEndMs: null,
			}),
		]);
		strictEqual(failed.expectedCostUsd, 1);
		strictEqual(failed.expectedEndToEndMs, 120_000);
		strictEqual(failed.reliability < 0.5, true);
	});

	it("reports posture-floors-unsatisfiable in shadow mode", () => {
		const executed = candidate();
		const decision = decideRoute(
			input({
				executedRoute: executed,
				candidates: [{ candidate: executed, estimate: estimateRoute([]), activeReadiness: READY, rejection: null }],
			}),
		);
		ok(decision.reasonCodes.includes("posture-floors-unsatisfiable"));
		strictEqual(routeCandidateKey(decision.selected), routeCandidateKey(executed));
	});

	it("active mode refuses unsatisfiable posture floors", () => {
		const executed = candidate();
		throws(
			() =>
				decideRoute(
					input({
						mode: "active",
						executedRoute: executed,
						candidates: [{ candidate: executed, estimate: estimateRoute([]), activeReadiness: READY, rejection: null }],
					}),
				),
			/posture-floors-unsatisfiable/,
		);
	});

	it("shadow success target failover and node failover preserve executed route bytes", () => {
		const executed = candidate();
		const executedBytes = JSON.stringify(executed);
		for (const alternate of [
			candidate({ targetId: "fallback-target", endpointIdentityHash: "endpoint-b" }),
			candidate({ nodeId: "fallback-node" }),
		]) {
			const decision = decideRoute(
				input({
					executedRoute: executed,
					candidates: [
						{
							candidate: executed,
							estimate: estimate(6, { completedCostUsd: 5 }),
							activeReadiness: READY,
							rejection: null,
						},
						{
							candidate: alternate,
							estimate: estimate(6, { completedCostUsd: 0.01 }),
							activeReadiness: READY,
							rejection: null,
						},
					],
				}),
			);
			strictEqual(JSON.stringify(decision.executedRoute), executedBytes);
			strictEqual(routeCandidateKey(decision.selected), routeCandidateKey(alternate));
		}
	});

	it("keeps route identity and statistics separated by execution role", () => {
		const builder = candidate({ executionRole: "builder" });
		const roles = ["reviewer", "judge", "researcher", "verifier", "recovery"] as const;
		const keys = new Set([
			routeCandidateKey(builder),
			...roles.map((role) => routeCandidateKey(candidate({ executionRole: role }))),
		]);
		// Same agent, target, model, runtime, and node; six distinct route identities.
		strictEqual(keys.size, 6, "each execution role is its own route identity");

		// A role cannot be dropped from the identity by omission: it is required.
		const decision = decideRoute(
			input({
				executedRoute: builder,
				candidates: [
					{
						candidate: builder,
						estimate: estimateRoute(Array.from({ length: 6 }, () => sample())),
						activeReadiness: READY,
						rejection: null,
					},
					{
						candidate: candidate({ executionRole: "recovery" }),
						estimate: estimateRoute(Array.from({ length: 6 }, () => sample())),
						activeReadiness: READY,
						rejection: null,
					},
				],
				hardConstraints: ["agent"],
				decisionDurationMs: 1,
			}),
		);
		strictEqual(decision.selected.executionRole, "builder", "the executed role is preserved in the decision");
		deepStrictEqual(
			decision.candidateEvaluations.map((evaluation) => evaluation.candidate.executionRole),
			["builder", "recovery"],
		);
		// Recovery evidence is a separate candidate, so it can never be folded into
		// the builder sample by the decision artifact.
		strictEqual(
			new Set(decision.candidateEvaluations.map((evaluation) => routeCandidateKey(evaluation.candidate))).size,
			2,
		);
	});
});
