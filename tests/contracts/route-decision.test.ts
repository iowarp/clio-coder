import { deepStrictEqual, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import type { DispatchNodePlacement } from "../../src/domains/dispatch/extension.js";
import {
	type CandidateEvaluation,
	decideRoute,
	type RouteCandidate,
	type RouteCandidateInput,
	type RouteDecisionInput,
	type RouteDecisionV1,
	routeCandidateKey,
	routeConstraintValidity,
	routePredictionCalibration,
	routeRegret,
} from "../../src/domains/dispatch/route-decision.js";
import {
	clearsPostureFloors,
	dominatesRoute,
	estimateRoute,
	ROUTE_POLICY_VERSION,
	type RouteEstimate,
	type RouteObservation,
} from "../../src/domains/dispatch/route-policy.js";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import type { SpawnedWorker } from "../../src/domains/dispatch/worker-spawn.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

const TARGET = "primary";
const ALT = "alt";
const MODEL = "model-a";

function candidate(overrides: Partial<RouteCandidate> = {}): RouteCandidate {
	return {
		agentId: "coder",
		specFingerprint: "spec-a",
		executionRole: "builder",
		targetId: TARGET,
		modelId: MODEL,
		runtimeId: "openai",
		nodeId: "local",
		toolSignature: "tools-a",
		promptCompositionHash: "prompt-a",
		...overrides,
	};
}

function sample(overrides: Partial<RouteObservation> = {}): RouteObservation {
	return {
		verified: true,
		firstPass: true,
		costUsd: 0.1,
		endToEndMs: 10_000,
		succeeded: true,
		cacheRead: false,
		queueWaitMs: 0,
		...overrides,
	};
}

function warm(count: number, overrides: Partial<RouteObservation> = {}): RouteEstimate {
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

function okWorker(text = "done"): SpawnedWorker {
	const events = (async function* () {
		yield { type: "message_end", message: { role: "assistant", content: text, usage: { input: 1, output: 1 } } };
	})();
	return {
		pid: 500,
		promise: Promise.resolve({ exitCode: 0, signal: null }),
		events,
		abort: () => {},
		heartbeatAt: { current: Date.now() },
	};
}

function failingWorker(stderrTail: string): SpawnedWorker {
	return {
		pid: 501,
		promise: Promise.resolve({ exitCode: 1, signal: null, stderrTail }),
		events: (async function* () {})(),
		abort: () => {},
		heartbeatAt: { current: Date.now() },
	};
}

/** The route a receipt actually executed, read back the way an offline reader would. */
function executedFromReceipt(receipt: RunReceipt): { targetId: string; nodeId: string } {
	return { targetId: receipt.targetId, nodeId: receipt.node?.id ?? "local" };
}

describe("route policy", () => {
	it("holds candidates to the posture floors it names", () => {
		const strong = warm(20);
		const weak = warm(20, { verified: false, succeeded: false });
		strictEqual(clearsPostureFloors(strong, "quality"), true);
		strictEqual(clearsPostureFloors(weak, "quality"), false);
		strictEqual(clearsPostureFloors(weak, "economy"), false);
		// manual names an exact route, so it imposes no floor to fail.
		strictEqual(clearsPostureFloors(weak, "manual"), true);
	});

	it("treats a strictly better candidate as dominating and equal ones as neither", () => {
		const cheap = warm(20, { costUsd: 0.1, endToEndMs: 1_000 });
		const dear = warm(20, { costUsd: 5, endToEndMs: 90_000 });
		strictEqual(dominatesRoute(cheap, dear), true);
		strictEqual(dominatesRoute(dear, cheap), false);
		strictEqual(dominatesRoute(cheap, cheap), false);
	});

	it("does not let a fast failure make a route look fast or cheap", () => {
		// A target that answers 503 in eight milliseconds is unreliable, not fast.
		// Folding its failures into the latency mean would rank it ahead of the
		// route that actually did the work, which is the implementation artifact
		// the estimator must refuse to optimize.
		const failsFast = estimateRoute([
			sample({ succeeded: false, verified: false, firstPass: false, endToEndMs: 8, costUsd: 0 }),
		]);
		const slowerButWorks = estimateRoute([sample({ endToEndMs: 10_000, costUsd: 0 })]);
		ok(
			slowerButWorks.expectedEndToEndMs < failsFast.expectedEndToEndMs,
			`working route ${slowerButWorks.expectedEndToEndMs}ms did not beat failing route ${failsFast.expectedEndToEndMs}ms`,
		);
		ok(slowerButWorks.expectedCostUsd < failsFast.expectedCostUsd);
		ok(slowerButWorks.reliability > failsFast.reliability);
		// The failure is still counted where it carries signal.
		strictEqual(failsFast.sampleCount, 1);
		// With no completed run, cost and latency fall back to the prior.
		strictEqual(failsFast.expectedEndToEndMs, 120_000);
		strictEqual(failsFast.expectedCostUsd, 1);
	});

	it("shrinks a cold route toward the conservative prior rather than toward free", () => {
		const cold = estimateRoute([]);
		strictEqual(cold.sampleCount, 0);
		strictEqual(cold.confidence, 0);
		strictEqual(cold.expectedCostUsd, 1);
		strictEqual(cold.verifiedSuccessProbability, 0.5);
		// A measured cheap route moves toward its measurement as evidence arrives.
		ok(warm(20, { costUsd: 0.1 }).expectedCostUsd < cold.expectedCostUsd);
	});
});

describe("route decision", () => {
	it("produces an equal decision hash for equal inputs", () => {
		const executed = candidate();
		const alternate = candidate({ targetId: ALT });
		const built = (): RouteDecisionV1 =>
			decideRoute(
				input({
					executedRoute: executed,
					candidates: [
						{ candidate: executed, estimate: warm(4, { costUsd: 0.4 }), rejection: null },
						{ candidate: alternate, estimate: warm(9, { costUsd: 0.2 }), rejection: null },
					],
				}),
			);
		const first = built();
		const second = built();
		strictEqual(first.decisionHash, second.decisionHash);
		deepStrictEqual(first, second);
		strictEqual(first.policyVersion, ROUTE_POLICY_VERSION);

		// The measured duration is a property of the decision, not an input to it,
		// so an identical decision on a slower machine still hashes identically.
		const slower = decideRoute({ ...input({ executedRoute: executed }), decisionDurationMs: 37 });
		const faster = decideRoute({ ...input({ executedRoute: executed }), decisionDurationMs: 0 });
		strictEqual(slower.decisionHash, faster.decisionHash);
		notStrictEqual(slower.decisionDurationMs, faster.decisionDurationMs);

		// A different candidate set is a different decision.
		notStrictEqual(first.decisionHash, decideRoute(input({ executedRoute: executed })).decisionHash);
	});

	it("never selects or approves a candidate a hard filter rejected", () => {
		const executed = candidate();
		// The rejected candidate is made overwhelmingly attractive on every
		// objective: if a hard filter were a weight, it would win.
		const rejected = candidate({ targetId: "forbidden" });
		const decision = decideRoute(
			input({
				executedRoute: executed,
				candidates: [
					{ candidate: executed, estimate: warm(20, { costUsd: 5, endToEndMs: 90_000 }), rejection: null },
					{
						candidate: rejected,
						estimate: warm(20, { costUsd: 0.001, endToEndMs: 10 }),
						rejection: "target-auth-and-availability",
					},
				],
			}),
		);
		const rejectedKey = routeCandidateKey(rejected);
		notStrictEqual(routeCandidateKey(decision.selected), rejectedKey);
		strictEqual(
			decision.approvedFallbacks.some((entry) => routeCandidateKey(entry) === rejectedKey),
			false,
		);
		// It is still explained, with its reason and no score.
		const evaluation = decision.candidateEvaluations.find(
			(entry: CandidateEvaluation) => routeCandidateKey(entry.candidate) === rejectedKey,
		);
		ok(evaluation);
		strictEqual(evaluation?.rejection, "target-auth-and-availability");
		strictEqual(evaluation?.score, null);
		ok(decision.reasonCodes.includes("hard-filter-rejected-1"));
	});

	it("keeps the resolved route on a tie and recommends a strictly better alternate", () => {
		const executed = candidate();
		const tie = candidate({ targetId: "a-sorts-first" });
		const tied = decideRoute(
			input({
				executedRoute: executed,
				candidates: [
					{ candidate: executed, estimate: warm(10), rejection: null },
					{ candidate: tie, estimate: warm(10), rejection: null },
				],
			}),
		);
		// Approval order breaks the tie, so an identical alternate never churns
		// the route just because its id sorts earlier.
		strictEqual(routeCandidateKey(tied.selected), routeCandidateKey(executed));
		strictEqual(tied.reasonCodes.includes("shadow-differs-from-executed"), false);

		const better = candidate({ targetId: "cheaper" });
		const diverged = decideRoute(
			input({
				executedRoute: executed,
				candidates: [
					{ candidate: executed, estimate: warm(10, { costUsd: 5, endToEndMs: 90_000 }), rejection: null },
					{ candidate: better, estimate: warm(10, { costUsd: 0.01, endToEndMs: 500 }), rejection: null },
				],
			}),
		);
		strictEqual(routeCandidateKey(diverged.selected), routeCandidateKey(better));
		ok(diverged.reasonCodes.includes("shadow-differs-from-executed"));
		ok(diverged.reasonCodes.includes("shadow-advisory-only"));
	});

	it("keeps the operator's exact route at manual posture", () => {
		const executed = candidate();
		const better = candidate({ targetId: "cheaper" });
		const decision = decideRoute(
			input({
				posture: "manual",
				executedRoute: executed,
				candidates: [
					{ candidate: executed, estimate: warm(10, { costUsd: 5 }), rejection: null },
					{ candidate: better, estimate: warm(10, { costUsd: 0.01 }), rejection: null },
				],
			}),
		);
		strictEqual(routeCandidateKey(decision.selected), routeCandidateKey(executed));
		deepStrictEqual(decision.approvedFallbacks, []);
		ok(decision.reasonCodes.includes("manual-posture-exact-route"));
	});

	it("computes regret, validity, and calibration from the stored decision alone", () => {
		const executed = candidate();
		const better = candidate({ targetId: "cheaper" });
		const decision = decideRoute(
			input({
				executedRoute: executed,
				candidates: [
					{ candidate: executed, estimate: warm(10, { costUsd: 5, endToEndMs: 90_000 }), rejection: null },
					{ candidate: better, estimate: warm(10, { costUsd: 0.01, endToEndMs: 500 }), rejection: null },
				],
			}),
		);
		const realized = {
			route: executed,
			outcome: "succeeded",
			verified: true,
			firstPass: true,
			attempt: 0,
			costUsd: 4.5,
			endToEndMs: 88_000,
		};

		// Offline replay: everything below reads a decision that has been through
		// JSON, exactly as a stored receipt would be read back.
		const replayed = JSON.parse(JSON.stringify(decision)) as RouteDecisionV1;
		deepStrictEqual(routeRegret(replayed), routeRegret(decision));
		deepStrictEqual(routePredictionCalibration(replayed, realized), routePredictionCalibration(decision, realized));

		const regret = routeRegret(replayed);
		ok(regret.score > 0, "the policy's pick scored better than the route that ran");
		ok(regret.expectedCostUsd < 0, "the policy's pick was cheaper than the route that ran");
		strictEqual(regret.routeDiffered, true);
		strictEqual(regret.executedOffFrontier, true);
		deepStrictEqual(routeConstraintValidity(replayed), {
			selectedAdmissible: true,
			executedAdmissible: true,
			fallbacksAdmissible: true,
			valid: true,
		});
		const calibration = routePredictionCalibration(replayed, realized);
		strictEqual(calibration.sampleCount, 10);
		ok(calibration.verifiedSuccessBrier < 0.1, "a warm verified route predicted its own success well");
	});
});

describe("shadow mode never changes the executed route", () => {
	beforeEach(isolateDispatchState);
	afterEach(restoreDispatchState);

	function twoTargetSettings(): typeof DEFAULT_SETTINGS {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.targets = [
			{ id: TARGET, runtime: "openai", defaultModel: MODEL },
			{ id: ALT, runtime: "openai", defaultModel: MODEL },
		];
		settings.workers.default = { target: TARGET, model: MODEL, thinkingLevel: "off" };
		return settings;
	}

	it("runs a success on the same route with the observer on and off", async () => {
		const routes: Array<{ observer: boolean; route: { targetId: string; nodeId: string } }> = [];
		for (const observerOn of [true, false]) {
			const bundle = makeDispatchBundle(dispatchStubContext({ settings: twoTargetSettings() }), {
				resilienceCooldownMs: 0,
				spawnWorker: () => okWorker(),
				...(observerOn ? {} : { routeObserver: false }),
			});
			await bundle.extension.start();
			try {
				const handle = await bundle.contract.dispatch({ agentId: "coder", task: "write the parser" });
				const receipt = await handle.finalPromise;
				strictEqual(receipt.outcome, "succeeded");
				routes.push({ observer: observerOn, route: executedFromReceipt(receipt) });
				if (observerOn) {
					// The sealed decision names the route that ran, whatever it would
					// have recommended.
					ok(receipt.routeDecision);
					strictEqual(receipt.routeDecision?.executedRoute.targetId, receipt.targetId);
					strictEqual(receipt.routeDecision?.mode, "shadow");
				}
			} finally {
				await bundle.extension.stop?.();
			}
		}
		deepStrictEqual(routes[0]?.route, routes[1]?.route);
	});

	it("takes the same target failover with the observer on and off", async () => {
		const attempts: Array<string[]> = [];
		for (const observerOn of [true, false]) {
			const settings = twoTargetSettings();
			settings.workers.maxRetries = 1;
			const spawned: string[] = [];
			let spawns = 0;
			const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
				resilienceCooldownMs: 0,
				spawnWorker: (spec) => {
					spawned.push(spec.target.id);
					spawns += 1;
					return spawns === 1 ? failingWorker("HTTP 503 Service Unavailable") : okWorker("recovered");
				},
				...(observerOn ? {} : { routeObserver: false }),
			});
			await bundle.extension.start();
			try {
				const handle = await bundle.contract.dispatch({
					agentId: "coder",
					task: "write the parser",
					failover: "automatic",
					target: TARGET,
					model: MODEL,
				});
				strictEqual((await handle.finalPromise).outcome, "succeeded");
				attempts.push(spawned);
			} finally {
				await bundle.extension.stop?.();
			}
		}
		deepStrictEqual(attempts[0], [TARGET, ALT]);
		deepStrictEqual(attempts[0], attempts[1]);
	});

	it("takes the same node failover with the observer on and off", async () => {
		const placements: Array<string[]> = [];
		for (const observerOn of [true, false]) {
			const settings = twoTargetSettings();
			settings.workers.maxRetries = 1;
			const nodes: string[] = [];
			let attempt = 0;
			const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
				resilienceCooldownMs: 0,
				resolveNode: (req): DispatchNodePlacement => {
					const node =
						req.lineage !== undefined && req.lineage.attempt > 0
							? ({ id: "local", kind: "local" } as const)
							: ({ id: "blade", kind: "ssh", host: "blade.test" } as const);
					nodes.push(node.id);
					return {
						node,
						spawn: () => {
							attempt += 1;
							// exit 255 is a node-channel failure, which excludes the node.
							return attempt === 1
								? { ...failingWorker("ssh: connection lost"), promise: Promise.resolve({ exitCode: 255, signal: null }) }
								: okWorker("recovered on local");
						},
					};
				},
				...(observerOn ? {} : { routeObserver: false }),
			});
			await bundle.extension.start();
			try {
				const handle = await bundle.contract.dispatch({ agentId: "coder", task: "write the parser" });
				const receipt = await handle.finalPromise;
				strictEqual(receipt.outcome, "succeeded");
				strictEqual(receipt.node?.id, "local");
				placements.push(nodes);
			} finally {
				await bundle.extension.stop?.();
			}
		}
		deepStrictEqual(placements[0], ["blade", "local"]);
		deepStrictEqual(placements[0], placements[1]);
	});
});
