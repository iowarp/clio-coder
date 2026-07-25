import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	decideRoute,
	type RouteCandidate,
	type RouteCandidateInput,
	type RouteDecisionInput,
	routeCandidateKey,
	routeConstraintValidity,
} from "../../src/domains/dispatch/route-decision.js";
import {
	clearsPostureFloors,
	estimateRoute,
	type RouteObservation,
	wilsonLowerBound,
} from "../../src/domains/dispatch/route-policy.js";

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

function input(overrides: Partial<RouteDecisionInput> = {}): RouteDecisionInput {
	const executedRoute = overrides.executedRoute ?? candidate();
	const candidates: ReadonlyArray<RouteCandidateInput> = overrides.candidates ?? [
		{ candidate: executedRoute, estimate: estimateRoute([]), rejection: null },
	];
	return {
		mode: "shadow",
		posture: "balanced",
		executedRoute,
		candidates,
		hardConstraints: ["target-auth-and-availability"],
		maxFallbacks: 2,
		decisionDurationMs: 0,
		...overrides,
	};
}

describe("route decision", () => {
	it("never selects a hard-rejected candidate", () => {
		const executed = candidate();
		const rejected = candidate({ targetId: "forbidden" });
		const decision = decideRoute(
			input({
				candidates: [
					{ candidate: executed, estimate: estimate(6, { completedCostUsd: 5 }), rejection: null },
					{ candidate: rejected, estimate: estimate(6, { completedCostUsd: 0.001 }), rejection: "target-auth" },
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
				candidates: [{ candidate: executed, estimate: estimateRoute([]), rejection: null }],
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
						candidates: [{ candidate: executed, estimate: estimateRoute([]), rejection: null }],
					}),
				),
			/posture-floors-unsatisfiable/,
		);
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
		const decision = decideRoute({
			mode: "shadow",
			posture: "balanced",
			executedRoute: builder,
			candidates: [
				{ candidate: builder, estimate: estimateRoute(Array.from({ length: 6 }, () => sample())), rejection: null },
				{
					candidate: candidate({ executionRole: "recovery" }),
					estimate: estimateRoute(Array.from({ length: 6 }, () => sample())),
					rejection: null,
				},
			],
			hardConstraints: ["agent"],
			maxFallbacks: 2,
			decisionDurationMs: 1,
		});
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
