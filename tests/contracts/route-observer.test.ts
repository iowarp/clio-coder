import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { RouteCandidate } from "../../src/domains/dispatch/route-decision.js";
import { classifyRouteIntent, createRouteObserver, recommendAgent } from "../../src/domains/dispatch/route-observer.js";
import type { SpawnedWorker } from "../../src/domains/dispatch/worker-spawn.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

function okWorker(): SpawnedWorker {
	const events = (async function* () {
		yield { type: "message_end", message: { role: "assistant", content: "done", usage: { input: 1, output: 1 } } };
	})();
	return {
		pid: 400,
		promise: Promise.resolve({ exitCode: 0, signal: null }),
		events,
		abort: () => {},
		heartbeatAt: { current: Date.now() },
	};
}

function observationsPath(): string {
	const stateDir = process.env.CLIO_STATE_DIR;
	ok(stateDir, "isolated state dir set");
	return join(stateDir ?? "", "route-decisions", "observations.jsonl");
}

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

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 8000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(message);
}

describe("route intent and agent recommendation", () => {
	it("classifies task type, complexity, and decomposability from rules alone", () => {
		const testIntent = classifyRouteIntent("add unit tests for the parser");
		strictEqual(testIntent.taskType, "test");
		strictEqual(testIntent.complexity, "trivial");
		strictEqual(testIntent.decomposable, false);

		const decomposed = classifyRouteIntent(
			["Do the following:", "1. refactor the config loader", "2. update the docs", "3. add coverage"].join("\n"),
		);
		ok(decomposed.decomposable);
		strictEqual(decomposed.estimatedSubtasks, 3);

		strictEqual(classifyRouteIntent("investigate why auth tokens leak").domain, "security");
		strictEqual(classifyRouteIntent("zzzzz").taskType, "unknown");
	});

	it("recommends with priority-ordered rules: requested, task-type hint, description, default", () => {
		const agents = [
			{ id: "coder", description: "general coding agent" },
			{ id: "reviewer", description: "reviews diffs" },
		];
		const intent = classifyRouteIntent("review the diff");
		strictEqual(recommendAgent({ intent, requestedAgentId: "coder", agents }).reason, "requested");
		const hinted = recommendAgent({ intent, requestedAgentId: undefined, agents });
		strictEqual(hinted.agentId, "reviewer");
		strictEqual(hinted.reason, "task_type_match");
		const fallback = recommendAgent({
			intent: classifyRouteIntent("zzzzz"),
			requestedAgentId: undefined,
			agents,
		});
		strictEqual(fallback.agentId, "coder");
		strictEqual(fallback.reason, "default");
	});
});

describe("route observer metrics", () => {
	beforeEach(isolateDispatchState);
	after(restoreDispatchState);

	it("aggregates regret, validity, calibration, and outcome instead of agent match", () => {
		const observer = createRouteObserver({
			getAgents: () => [{ id: "coder", description: "coding" }],
			logDir: join(process.env.CLIO_STATE_DIR ?? "/tmp", "route-unit"),
		});
		const executed = candidate();
		const alternate = candidate({ targetId: "cheap", modelId: "model-b" });
		const handle = observer.observe({
			task: "implement a thing",
			requestedAgentId: "coder",
			executedRoute: executed,
			candidates: [
				{ candidate: executed, rejection: null },
				{ candidate: alternate, rejection: null },
			],
			hardConstraints: ["target-auth-and-availability"],
			maxFallbacks: 2,
		});
		ok(handle);
		if (!handle) return;
		observer.recordOutcome(handle.id, {
			route: executed,
			outcome: "succeeded",
			verified: true,
			firstPass: true,
			attempt: 0,
			costUsd: 0.5,
			endToEndMs: 60_000,
		});
		const summary = observer.summary();
		strictEqual(summary.totalObservations, 1);
		strictEqual(summary.recordedOutcomes, 1);
		// Every candidate is cold, so their estimates are the identical prior and
		// the policy's pick is the executed route: no regret, nothing off-frontier.
		strictEqual(summary.meanScoreRegret, 0);
		strictEqual(summary.offFrontierRate, 0);
		strictEqual(summary.shadowDivergenceRate, 0);
		strictEqual(summary.constraintValidityRate, 1);
		strictEqual(summary.verifiedRate, 1);
		strictEqual(summary.firstPassRate, 1);
		strictEqual(summary.escalationRate, 0);
		// The cold prior puts verified success at 0.5 and the run verified.
		strictEqual(summary.meanVerifiedSuccessBrier, 0.25);
		ok(!("agentMatchRate" in summary), "the tautological agent-match metric is gone");
	});

	it("reports a constraint violation when the executed route was rejected by a hard filter", () => {
		const observer = createRouteObserver({
			getAgents: () => [{ id: "coder", description: "coding" }],
			logDir: join(process.env.CLIO_STATE_DIR ?? "/tmp", "route-unit-invalid"),
		});
		const executed = candidate();
		const alternate = candidate({ targetId: "alt" });
		const handle = observer.observe({
			task: "implement a thing",
			requestedAgentId: "coder",
			executedRoute: executed,
			candidates: [
				{ candidate: executed, rejection: "node-eligibility" },
				{ candidate: alternate, rejection: null },
			],
			hardConstraints: ["node-eligibility"],
			maxFallbacks: 2,
		});
		ok(handle);
		if (!handle) return;
		strictEqual(handle.decision.reasonCodes.includes("executed-route-not-admissible"), true);
		observer.recordOutcome(handle.id, {
			route: executed,
			outcome: "failed",
			verified: false,
			firstPass: false,
			attempt: 1,
			costUsd: 0.1,
			endToEndMs: 1_000,
		});
		const summary = observer.summary();
		strictEqual(summary.constraintValidityRate, 0);
		strictEqual(summary.escalationRate, 1);
		strictEqual(summary.verifiedRate, 0);
	});
});

describe("route observer (shadow mode)", () => {
	beforeEach(() => {
		isolateDispatchState();
	});
	after(() => {
		restoreDispatchState();
	});

	it("records a decision and an outcome for every dispatch without touching behavior", async () => {
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: () => okWorker() });
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({ agentId: "coder", task: "write the parser" });
			for await (const _ of handle.events) {
				// drain
			}
			const receipt = await handle.finalPromise;
			strictEqual(receipt.outcome, "succeeded");
			await waitFor(() => {
				if (!existsSync(observationsPath())) return false;
				return readFileSync(observationsPath(), "utf8").includes('"kind":"outcome"');
			}, "observation log written");
			const lines = readFileSync(observationsPath(), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as Record<string, unknown>);
			const decision = lines.find((line) => line.kind === "decision");
			const outcome = lines.find((line) => line.kind === "outcome");
			ok(decision, "decision record written");
			ok(outcome, "outcome record written");
			strictEqual(decision?.mode, "shadow");
			strictEqual(decision?.policyVersion, "route-policy/1");
			ok(typeof decision?.decisionHash === "string");
			// Shadow is advisory: the run executed the route dispatch resolved.
			strictEqual(decision?.selected, decision?.executed);

			// The same decision is sealed on the receipt, which is what makes an
			// offline regret replay possible without the deciding process.
			ok(receipt.routeDecision, "receipt sealed the route decision");
			strictEqual(receipt.routeDecision?.decisionHash, decision?.decisionHash);
			strictEqual(receipt.routeDecision?.mode, "shadow");
			const envelope = bundle.contract.getRun(receipt.runId);
			ok(envelope);
			if (envelope) deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: true });
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("disabled observer changes nothing about the dispatch and writes nothing", async () => {
		const bundle = makeDispatchBundle(dispatchStubContext(), {
			spawnWorker: () => okWorker(),
			routeObserver: false,
		});
		await bundle.extension.start();
		try {
			const handle = await bundle.contract.dispatch({ agentId: "coder", task: "write the parser" });
			for await (const _ of handle.events) {
				// drain
			}
			const receipt = await handle.finalPromise;
			strictEqual(receipt.outcome, "succeeded");
			strictEqual(receipt.exitCode, 0);
			strictEqual(receipt.routeDecision, undefined);
			const envelope = bundle.contract.getRun(receipt.runId);
			ok(envelope);
			if (envelope) deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: true });
			strictEqual(existsSync(observationsPath()), false);
		} finally {
			await bundle.extension.stop?.();
		}
	});
});
