import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import {
	classifySpeculationIntent,
	createSpeculationObserver,
	solveSpeculationPlan,
} from "../../src/domains/dispatch/speculation.js";
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
	return join(stateDir ?? "", "speculation", "observations.jsonl");
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 8000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(message);
}

describe("speculation rule pipeline", () => {
	it("classifies task type, complexity, and decomposability from rules alone", () => {
		const testIntent = classifySpeculationIntent("add unit tests for the parser");
		strictEqual(testIntent.taskType, "test");
		strictEqual(testIntent.complexity, "trivial");
		strictEqual(testIntent.decomposable, false);

		const decomposed = classifySpeculationIntent(
			["Do the following:", "1. refactor the config loader", "2. update the docs", "3. add coverage"].join("\n"),
		);
		ok(decomposed.decomposable);
		strictEqual(decomposed.estimatedSubtasks, 3);

		strictEqual(classifySpeculationIntent("investigate why auth tokens leak").domain, "security");
		strictEqual(classifySpeculationIntent("zzzzz").taskType, "unknown");
	});

	it("solves with priority-ordered rules: requested, task-type hint, description, default", () => {
		const agents = [
			{ id: "coder", description: "general coding agent" },
			{ id: "reviewer", description: "reviews diffs" },
		];
		const base = { task: "review the diff", agents, availableCapacity: 2 };
		const requested = solveSpeculationPlan({
			...base,
			intent: classifySpeculationIntent(base.task),
			requestedAgentId: "coder",
		});
		strictEqual(requested.agentId, "coder");
		strictEqual(requested.reason, "requested");

		const hinted = solveSpeculationPlan({
			...base,
			intent: classifySpeculationIntent(base.task),
			requestedAgentId: undefined,
		});
		strictEqual(hinted.agentId, "reviewer");
		strictEqual(hinted.reason, "task_type_match");

		const fallback = solveSpeculationPlan({
			intent: classifySpeculationIntent("zzzzz"),
			task: "zzzzz",
			requestedAgentId: undefined,
			agents,
			availableCapacity: 1,
		});
		strictEqual(fallback.agentId, "coder");
		strictEqual(fallback.reason, "default");
	});

	it("aggregates plan-versus-actual accuracy in the learner summary", () => {
		const observer = createSpeculationObserver({
			getAgents: () => [{ id: "coder", description: "coding" }],
			logDir: join(process.env.CLIO_STATE_DIR ?? "/tmp", "speculation-unit"),
		});
		const first = observer.observe({ task: "implement a thing", requestedAgentId: "coder" });
		const second = observer.observe({ task: "implement another thing", requestedAgentId: "coder" });
		ok(first !== null && second !== null);
		if (first !== null)
			observer.recordOutcome(first, { agentId: "coder", outcome: "succeeded", latencyMs: 5, tokens: 10 });
		if (second !== null)
			observer.recordOutcome(second, { agentId: "verifier", outcome: "succeeded", latencyMs: 5, tokens: 10 });
		const summary = observer.summary();
		strictEqual(summary.totalObservations, 2);
		strictEqual(summary.recordedOutcomes, 2);
		strictEqual(summary.agentMatchRate, 0.5);
	});
});

describe("speculation observer (shadow mode)", () => {
	beforeEach(() => {
		isolateDispatchState();
	});
	after(() => {
		restoreDispatchState();
	});

	it("records a plan and an outcome for every dispatch without touching behavior", async () => {
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
			const plan = lines.find((line) => line.kind === "plan");
			const outcome = lines.find((line) => line.kind === "outcome");
			ok(plan, "plan record written");
			ok(outcome, "outcome record written");
			strictEqual(plan?.agentId, "coder");
			deepStrictEqual((outcome?.comparison as { agentMatch: boolean }).agentMatch, true);
			strictEqual((outcome?.actual as { agentId: string }).agentId, "coder");
			// The would-be plan was computed on the synchronous rule path.
			ok(typeof plan?.computeTimeUs === "number");
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("disabled observer changes nothing about the dispatch and writes nothing", async () => {
		const bundle = makeDispatchBundle(dispatchStubContext(), {
			spawnWorker: () => okWorker(),
			speculation: false,
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
			const envelope = bundle.contract.getRun(receipt.runId);
			ok(envelope);
			if (envelope) deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: true });
			strictEqual(existsSync(observationsPath()), false);
		} finally {
			await bundle.extension.stop?.();
		}
	});
});
