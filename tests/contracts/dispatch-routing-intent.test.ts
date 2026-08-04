import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	decideRoute,
	type RouteCandidate,
	type RouteCandidateInput,
	type RouteDecisionInput,
} from "../../src/domains/dispatch/route-decision.js";
import { DEFAULT_ROUTE_PRIOR, estimateRoute } from "../../src/domains/dispatch/route-policy.js";
import type { RouteReadinessReport } from "../../src/domains/dispatch/route-readiness.js";
import {
	explainRouteDecision,
	parseRoutingIntent,
	preferLocalTie,
	ROUTE_EXPLANATION_MAX_BYTES,
	routingIntentRejection,
} from "../../src/domains/dispatch/routing-intent.js";

const READY: RouteReadinessReport = { ready: true, gaps: [], labelsNeeded: 0 };

const candidate = (nodeId = "local", targetId = "target"): RouteCandidate => ({
	agentId: "coder",
	specFingerprint: "spec",
	executionRole: "builder",
	targetId,
	modelId: "model",
	runtimeId: "openai",
	nodeId,
	toolSignature: "tools",
	promptCompositionHash: "prompt",
	endpointIdentityHash: "endpoint",
	settingsFingerprint: "settings",
});
const intent = () => {
	const parsed = parseRoutingIntent(undefined);
	if (!parsed.ok) throw new Error(parsed.errors.join("; "));
	return parsed.intent;
};
const explicitAgentSelection = (
	executed: RouteCandidate,
	candidates: ReadonlyArray<RouteCandidateInput>,
): RouteDecisionInput["agentSelection"] => ({
	request: "explicit",
	baselineAgentId: executed.agentId,
	evaluations: [
		{
			agentId: executed.agentId,
			specFingerprint: executed.specFingerprint,
			executionRole: executed.executionRole,
			authority: "workspace-edit",
			rejections: [],
			coldPrior: DEFAULT_ROUTE_PRIOR,
			priorReasons: [],
		},
	],
	readiness: [
		{
			agentId: executed.agentId,
			specFingerprint: executed.specFingerprint,
			executionRole: executed.executionRole,
			ready: candidates.some((entry) => entry.activeReadiness.ready),
			candidateCount: candidates.length,
			readyCandidateCount: candidates.filter((entry) => entry.activeReadiness.ready).length,
			routes: candidates.map((entry) => ({ candidate: entry.candidate, report: entry.activeReadiness })),
		},
	],
	authorityBasis: null,
});
const decision = (executed = candidate()) =>
	decideRoute({
		mode: "shadow",
		posture: "balanced",
		executedRoute: executed,
		candidates: [{ candidate: executed, estimate: estimateRoute([]), activeReadiness: READY, rejection: null }],
		independenceSubject: null,
		hardConstraints: ["authority"],
		maxFallbacks: 3,
		decisionDurationMs: 1,
		agentSelection: explicitAgentSelection(executed, [
			{ candidate: executed, estimate: estimateRoute([]), activeReadiness: READY, rejection: null },
		]),
	});

describe("dispatch routing intent", () => {
	it("routing intent rejects unknown keys and invalid bounds", () => {
		const parsed = parseRoutingIntent({ surprise: true, maxCostUsd: 0, deadlineMs: 1.2, minimumQuality: 2 });
		strictEqual(parsed.ok, false);
		if (!parsed.ok) match(parsed.errors.join(" "), /unknown key.*maxCostUsd.*deadlineMs.*minimumQuality/);
	});

	it("manual pins fail closed and imply no adaptive fallback", () => {
		strictEqual(parseRoutingIntent({ posture: "balanced" }, { target: "pinned" }).ok, false);
		strictEqual(parseRoutingIntent({ posture: "manual", failover: "approved" }, { model: "pinned" }).ok, false);
		const parsed = parseRoutingIntent(undefined, { node: "mini" });
		ok(parsed.ok);
		if (parsed.ok) deepStrictEqual([parsed.intent.posture, parsed.intent.failover], ["manual", "none"]);
	});

	it("minimum quality cost deadline and local-only are hard filters", () => {
		const parsed = parseRoutingIntent({ minimumQuality: 0.8, maxCostUsd: 1, deadlineMs: 100, locality: "local-only" });
		ok(parsed.ok);
		if (!parsed.ok) return;
		const base = {
			intent: parsed.intent,
			candidate: candidate(),
			qualityLowerBound: 0.9,
			costUpperBoundUsd: 0.5,
			endToEndUpperBoundMs: 50,
			capabilities: [],
		};
		strictEqual(routingIntentRejection({ ...base, qualityLowerBound: 0.7 }), "minimum-quality");
		strictEqual(routingIntentRejection({ ...base, costUpperBoundUsd: 2 }), "max-cost");
		strictEqual(routingIntentRejection({ ...base, endToEndUpperBoundMs: 101 }), "deadline");
		strictEqual(routingIntentRejection({ ...base, candidate: candidate("mini") }), "local-only");
	});

	it("prefer-local affects only an otherwise admissible tie", () => {
		const parsed = parseRoutingIntent({ locality: "prefer-local" });
		ok(parsed.ok);
		if (!parsed.ok) return;
		const facts = {
			intent: parsed.intent,
			qualityLowerBound: 0,
			costUpperBoundUsd: 999,
			endToEndUpperBoundMs: 999,
			capabilities: [],
		};
		const local = candidate("local");
		const remote = candidate("mini");
		strictEqual(routingIntentRejection({ ...facts, candidate: local }), null);
		strictEqual(routingIntentRejection({ ...facts, candidate: remote }), null);
		strictEqual(preferLocalTie(remote, local, parsed.intent.locality), local);
		strictEqual(preferLocalTie(remote, local, "any"), null);
	});

	it("model-authored candidate envelopes are not trusted", () => {
		const parsed = parseRoutingIntent({ allowedCandidates: [candidate()] });
		strictEqual(parsed.ok, false);
	});

	it("shadow posture leaves the executed route byte-identical", () => {
		const executed = candidate("local", "fixed");
		const alternate = candidate("mini", "recommended");
		const candidates: RouteCandidateInput[] = [
			{ candidate: executed, estimate: estimateRoute([]), activeReadiness: READY, rejection: null },
			{
				candidate: alternate,
				estimate: { ...estimateRoute([]), expectedCostUsd: 0 },
				activeReadiness: READY,
				rejection: null,
			},
		];
		const routeDecision = decideRoute({
			mode: "shadow",
			posture: "economy",
			executedRoute: executed,
			candidates,
			independenceSubject: null,
			hardConstraints: [],
			maxFallbacks: 1,
			decisionDurationMs: 1,
			agentSelection: explicitAgentSelection(executed, candidates),
		});
		deepStrictEqual(routeDecision.executedRoute, executed);
	});

	it("tool explanation matches the receipt decision hash", () => {
		const sealed = decision();
		strictEqual(explainRouteDecision(sealed, intent()).decisionHash, sealed.decisionHash);
	});

	it("route explanations are bounded and redact endpoint secrets", () => {
		const sealed = decision(candidate("local", `https://user:password@example.test/${"x".repeat(10_000)}`));
		const template = sealed.agentSelection.evaluations[0];
		if (template === undefined) throw new Error("missing agent evaluation");
		sealed.agentSelection.evaluations.push(
			...Array.from({ length: 32 }, (_, index) => ({
				...template,
				agentId: `https://password.example/${index}/${"agent".repeat(80)}`,
				rejections: Array.from({ length: 8 }, () => `required-tool:${"x".repeat(128)}`),
			})),
		);
		const explanation = explainRouteDecision(sealed, intent());
		const encoded = JSON.stringify(explanation);
		ok(Buffer.byteLength(encoded, "utf8") <= ROUTE_EXPLANATION_MAX_BYTES);
		strictEqual(encoded.includes("password"), false);
		strictEqual(encoded.includes("https://"), false);
	});
});
