/**
 * `clio-coder fleet view <fleetRootId>`.
 *
 * `fleet run` advertises a `fleet-<hex>` root id and the viewer only understood
 * the 12-character run id of a single dispatched step, so the one identifier the
 * command prints was rejected as an unknown run. A root has no ledger row,
 * receipt, or journal of its own; what it has is the durable fleet-run record,
 * which is enough to index its steps and name the run id to view for each.
 *
 * These assert the reduction from that record plus the ledger to a pure render,
 * on the same terms as fleet-view-data.test.ts: the strings are what an operator
 * sees.
 */

import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { loadFleetRunViewModel, renderFleetRunView, resolveFleetRootId } from "../../src/cli/fleet-view.js";
import type { ExecutionStepResult } from "../../src/domains/dispatch/execution-scheduler.js";
import { type FleetRunRecord, openLedger, writeFleetRun } from "../../src/domains/dispatch/state.js";
import type { RunLineage } from "../../src/domains/dispatch/types.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

const lineage: RunLineage = { parentRunId: null, rootRunId: "fleet-root", attempt: 0, depth: 0 };
const identity = { host: "fleet-host", user: "fleet-user", hpc: null };

/** One finalized ledger row standing in for a dispatched fleet step. */
async function seedStepRun(agentId: string, outcome: "succeeded" | "failed"): Promise<string> {
	const ledger = openLedger({ maxRuns: 20 });
	const run = ledger.create({
		agentId,
		executionRole: "builder",
		task: `${agentId} step`,
		targetId: "blade-gateway",
		wireModelId: "judge",
		runtimeId: "openai",
		runtimeKind: "http",
		sessionId: null,
		cwd: "/tmp/fleet-view-root",
	});
	ledger.update(run.id, {
		status: "completed",
		outcome,
		outcomeDetail: null,
		lineage,
		identity,
		startedAt: "2026-08-30T10:00:00.000Z",
		endedAt: "2026-08-30T10:01:00.000Z",
		exitCode: outcome === "succeeded" ? 0 : 1,
	});
	await ledger.persist();
	return run.id;
}

function stepResult(
	stepId: string,
	terminalRunId: string,
	succeeded: boolean,
	failureReason?: string,
): ExecutionStepResult {
	return {
		stepId,
		assignmentId: `assignment-${stepId}`,
		terminalRunId,
		receiptDigest: `digest-${stepId}`,
		output: `${stepId} output`,
		succeeded,
		integrityValid: true,
		...(failureReason === undefined ? {} : { failureReason }),
	};
}

function fleetRecord(overrides: Partial<FleetRunRecord> = {}): FleetRunRecord {
	return {
		version: 1,
		id: "fleet-345ea2e6c1ad",
		fleet: "build-review",
		planHash: "plan-hash",
		stepIds: [],
		planSteps: [],
		vars: {},
		startedAt: "2026-08-30T10:00:00.000Z",
		endedAt: "2026-08-30T10:03:37.000Z",
		resumedFrom: null,
		steps: [],
		...overrides,
	};
}

function line(lines: ReadonlyArray<string>, prefix: string): string {
	const found = lines.find((candidate) => candidate.startsWith(prefix));
	ok(found !== undefined, `no rendered line starting with ${JSON.stringify(prefix)}`);
	return found;
}

describe("fleet view root index", () => {
	it("resolves a fleet root to its step runs and indexes them one line each", async () => {
		const isolated = await isolateClioEnv("clio-fleet-view-root-");
		try {
			const buildRunId = await seedStepRun("coder", "succeeded");
			const reviewRunId = await seedStepRun("debugger", "failed");
			await writeFleetRun(
				fleetRecord({
					stepIds: ["build", "review", "apply"],
					steps: [
						{ stepId: "build", result: stepResult("build", buildRunId, true) },
						{
							stepId: "review",
							result: stepResult("review", reviewRunId, false, "review gate produced no structured verdict"),
						},
					],
				}),
			);

			const model = loadFleetRunViewModel("fleet-345ea2e6c1ad");
			ok(model !== null, "the root resolved from its durable fleet-run record");
			strictEqual(model.fleet, "build-review");
			strictEqual(model.plannedSteps, 3);
			strictEqual(model.recordedSteps, 2);
			strictEqual(model.running, false);
			deepStrictEqual(
				model.steps.map((step) => [step.stepId, step.runId, step.outcome, step.agentId]),
				[
					["build", buildRunId, "succeeded", "coder"],
					["review", reviewRunId, "failed", "debugger"],
					// Planned but never reached: on the index, without a run id.
					["apply", null, "not run", null],
				],
			);

			const rendered = renderFleetRunView(model, 120);
			strictEqual(line(rendered, "fleet "), "fleet build-review  root fleet-345ea2e6c1ad");
			match(line(rendered, "started "), /^started 2026-08-30T10:00:00\.000Z {2}elapsed 3m37s {2}2 of 3 steps recorded$/);
			match(line(rendered, "build "), new RegExp(`^build {3}${buildRunId} {2}succeeded {2}coder$`));
			match(
				line(rendered, "review"),
				new RegExp(`^review {2}${reviewRunId} {2}failed {5}debugger: review gate produced no structured verdict$`),
			);
			match(line(rendered, "apply"), /^apply {3}- {13}not run$/);
			// The index points at the per-run view rather than pretending to be one.
			strictEqual(rendered.at(-1), "clio-coder fleet view <run id> for one step's transcript, receipt, and ledger entry");
			// It is an index, not a combined transcript: no step's events appear.
			ok(!rendered.some((text) => text.includes("message_end")));
		} finally {
			isolated.restore();
		}
	});

	it("resolves an exact root id and a unique prefix, and refuses an ambiguous one", async () => {
		const isolated = await isolateClioEnv("clio-fleet-view-root-resolve-");
		try {
			await writeFleetRun(fleetRecord({ id: "fleet-aaaa11112222" }));
			await writeFleetRun(fleetRecord({ id: "fleet-aaaa33334444" }));

			const exact = resolveFleetRootId("fleet-aaaa11112222");
			ok("rootId" in exact);
			strictEqual(exact.rootId, "fleet-aaaa11112222");

			const prefix = resolveFleetRootId("fleet-aaaa1111");
			ok("rootId" in prefix);
			strictEqual(prefix.rootId, "fleet-aaaa11112222");

			const ambiguous = resolveFleetRootId("fleet-aaaa");
			ok("candidates" in ambiguous);
			strictEqual(ambiguous.candidates.length, 2);

			const unknown = resolveFleetRootId("fleet-zzzz");
			ok("candidates" in unknown);
			strictEqual(unknown.candidates.length, 0);
			strictEqual(loadFleetRunViewModel("fleet-zzzz"), null);
		} finally {
			isolated.restore();
		}
	});

	it("indexes a fleet run still in flight, and one whose steps all failed to record", async () => {
		const isolated = await isolateClioEnv("clio-fleet-view-root-running-");
		try {
			await writeFleetRun(
				fleetRecord({
					id: "fleet-bbbb11112222",
					endedAt: null,
					stepIds: ["plan", "build"],
					steps: [],
				}),
			);
			const model = loadFleetRunViewModel("fleet-bbbb11112222", { now: () => Date.parse("2026-08-30T10:00:45.000Z") });
			ok(model !== null);
			strictEqual(model.running, true);
			strictEqual(model.recordedSteps, 0);
			const rendered = renderFleetRunView(model, 120);
			match(line(rendered, "started "), /0 of 2 steps recorded {2}\(running\)$/);
			deepStrictEqual(
				model.steps.map((step) => step.outcome),
				["not run", "not run"],
			);
		} finally {
			isolated.restore();
		}
	});
});
