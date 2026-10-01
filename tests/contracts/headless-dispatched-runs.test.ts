import { deepStrictEqual, doesNotMatch, match } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	describeRuns,
	projectDispatchedRunOutcome,
	settleDispatchedRuns,
} from "../../src/cli/modes/headless-dispatched-runs.js";
import { mergeWithheldDetail } from "../../src/domains/dispatch/merge-gate.js";
import type { RunEnvelope, RunOutcome } from "../../src/domains/dispatch/types.js";

const ROOT = "root-run";

function run(id: string, outcome: RunOutcome | null, attempt = 0, parentRunId: string | null = ROOT): RunEnvelope {
	return {
		id,
		agentId: "coder",
		status: outcome === null ? "running" : outcome === "succeeded" ? "completed" : "failed",
		outcome,
		endedAt: outcome === null ? null : "2026-09-30T00:00:00.000Z",
		lineage: { parentRunId, rootRunId: ROOT, attempt, depth: 1 },
	} as unknown as RunEnvelope;
}

describe("headless dispatched runs", () => {
	it("reports a withheld merge with its preserved branch and recovery command", async () => {
		const withheld = {
			...run("withheld", "failed"),
			outcomeCode: "merge_withheld" as const,
			outcomeDetail: mergeWithheldDetail({
				quality: "fail",
				hostStatus: undefined,
				contract: null,
				output: null,
				branch: "clio-coder/task/withheld",
			}),
		};
		const settlement = await settleDispatchedRuns({ listRuns: () => [withheld] }, ROOT, () => false);
		const description = describeRuns(settlement.undelivered);
		match(description, /withheld \(coder, merge_withheld\)/u);
		match(description, /preserved branch clio-coder\/task\/withheld/u);
		match(description, /git merge clio-coder\/task\/withheld/u);
		doesNotMatch(describeRuns([{ ...withheld, outcomeDetail: "the operator discarded the branch" }]), /git merge/u);
	});
	it("reports unretried failures as undelivered and names runs still live at shutdown", async () => {
		const runs = [
			run("retried-failure", "failed"),
			run("retry", "succeeded", 1, "retried-failure"),
			run("unretried-failure", "failed"),
			run("live", null),
		];
		let polls = 0;
		const settlement = await settleDispatchedRuns({ listRuns: () => runs }, ROOT, () => {
			polls += 1;
			return polls > 1;
		});
		deepStrictEqual(
			settlement.undelivered.map((entry) => entry.id),
			["unretried-failure"],
		);
		deepStrictEqual(
			settlement.live.map((entry) => entry.id),
			["live"],
		);
	});
});

it("reports the no-work reason on the headless failure line", () => {
	match(
		describeRuns([
			{
				...run("idle", "failed"),
				outcomeCode: "worker_no_work",
				outcomeDetail: "worker executed no tools, so it did none of its assignment",
			},
		]),
		/idle \(coder, worker_no_work\): worker executed no tools/u,
	);
});

it("reports the outcome code and bounded detail for any failed run", () => {
	const description = describeRuns([
		{
			...run("rejected", "failed"),
			outcomeCode: "host_verification_rejected",
			outcomeDetail: `host verification check 'test' rejected with exit code 1; ${"x".repeat(2000)}`,
		},
		run("plain", "failed"),
	]);
	match(description, /rejected \(coder, host_verification_rejected\): host verification check 'test' rejected/u);
	match(description, /…, plain \(coder, failed\)$/u);
});

it("carries a bounded structured reason for the JSON settlement", () => {
	const projected = projectDispatchedRunOutcome({
		...run("idle", "failed"),
		outcomeCode: "worker_no_work",
		outcomeDetail: "worker executed no tools",
	});
	deepStrictEqual(projected, {
		runId: "idle",
		agentId: "coder",
		outcome: "failed",
		outcomeCode: "worker_no_work",
		outcomeDetail: "worker executed no tools",
	});
});
