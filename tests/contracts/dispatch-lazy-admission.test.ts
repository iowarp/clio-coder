import { match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import type { DispatchExecutionSnapshot } from "../../src/tools/dispatch-types.js";

const unavailableDispatch = {} as DispatchContract;

describe("lazy dispatch admission authority", () => {
	it("does not load the runner when canonical admission already rejected the call", async () => {
		let loads = 0;
		const tool = createDispatchTool(
			{ dispatch: unavailableDispatch, getAgentSpecs: () => [] },
			{
				loadRunner: async () => {
					loads += 1;
					throw new Error("runner must remain absent");
				},
			},
		);

		const result = await tool.run({ tasks: ["one", "two"], review: true });
		strictEqual(result.kind, "error");
		if (result.kind === "error") match(result.message, /review supports exactly one task/);
		strictEqual(loads, 0);

		const winner = await tool.run({
			apply_winner: { branch: "clio/compete/admitted-group/1", cwd: "/approved/repository" },
		});
		strictEqual(winner.kind, "error");
		if (winner.kind === "error") match(winner.message, /scheduling cost ceiling is unavailable/);
		strictEqual(loads, 0, "an authority artifact failure is known before importing the runner");
	});

	it("executes from a frozen snapshot when nested parked arguments are mutated", async () => {
		const snapshots: DispatchExecutionSnapshot[] = [];
		const loadRunner = async () => ({
			async runDispatchTool(
				_deps: unknown,
				state: {
					trustedExecutionSnapshots: WeakMap<Record<string, unknown>, DispatchExecutionSnapshot>;
				},
				args: Record<string, unknown>,
			) {
				const snapshot = state.trustedExecutionSnapshots.get(args);
				if (snapshot === undefined) throw new Error("missing trusted snapshot");
				snapshots.push(snapshot);
				return { kind: "ok" as const, output: "captured" };
			},
		});
		const tool = createDispatchTool({ dispatch: unavailableDispatch, getAgentSpecs: () => [] }, { loadRunner });

		const reviewArgs = tool.prepareAdmissionArguments?.({
			tasks: [{ task: "approved review task", briefing: "approved briefing" }],
			mode: "parallel",
			review: { reviewer: "reviewer", max_cycles: 2 },
			timeout_ms: 1_500,
			max_output_bytes: 4_096,
		});
		ok(reviewArgs);
		const reviewTasks = reviewArgs.tasks as Array<Record<string, unknown>>;
		const reviewSettings = reviewArgs.review as Record<string, unknown>;
		const parkedReviewTask = reviewTasks[0];
		ok(parkedReviewTask);
		parkedReviewTask.task = "nested task substitution";
		parkedReviewTask.briefing = "nested briefing substitution";
		reviewSettings.reviewer = "attacker";
		reviewSettings.max_cycles = 4;
		reviewArgs.mode = "compete";
		reviewArgs.candidates = 4;
		reviewArgs.detach = true;
		reviewArgs.timeout_ms = 1;
		reviewArgs.max_output_bytes = 1;
		strictEqual((await tool.run(reviewArgs)).kind, "ok");

		const reviewSnapshot = snapshots[0];
		ok(reviewSnapshot);
		strictEqual(reviewSnapshot.kind, "dispatch");
		if (reviewSnapshot.kind !== "dispatch") throw new Error("expected a dispatch snapshot");
		strictEqual(reviewSnapshot.planView.topology, "review");
		match(reviewSnapshot.planView.text, /approved review task/);
		ok(!reviewSnapshot.planView.text.includes("nested task substitution"));
		strictEqual(Object.isFrozen(reviewSnapshot), true);
		strictEqual(Object.isFrozen(reviewSnapshot.requests), true);
		strictEqual(Object.isFrozen(reviewSnapshot.requests[0]), true);
		strictEqual(reviewSnapshot.mode, "parallel");
		strictEqual(reviewSnapshot.requests[0]?.task, "approved review task");
		strictEqual(reviewSnapshot.requests[0]?.briefing, "approved briefing");
		strictEqual(reviewSnapshot.review?.reviewer, "reviewer");
		strictEqual(reviewSnapshot.review?.maxCycles, 2);
		strictEqual(reviewSnapshot.compete, undefined);
		strictEqual(reviewSnapshot.detach, false);
		strictEqual(reviewSnapshot.timeoutMs, 1_500);
		strictEqual(reviewSnapshot.maxOutputBytes, 4_096);

		const competeArgs = tool.prepareAdmissionArguments?.({
			task: "approved compete task",
			mode: "compete",
			candidates: 3,
			judge: { agent: "judge", model: "approved-model" },
		});
		ok(competeArgs);
		const judge = competeArgs.judge as Record<string, unknown>;
		competeArgs.task = "top-level task substitution";
		competeArgs.candidates = 2;
		judge.agent = "attacker";
		judge.model = "substituted-model";
		strictEqual((await tool.run(competeArgs)).kind, "ok");

		const competeSnapshot = snapshots[1];
		ok(competeSnapshot);
		strictEqual(competeSnapshot.kind, "dispatch");
		if (competeSnapshot.kind !== "dispatch") throw new Error("expected a dispatch snapshot");
		strictEqual(competeSnapshot.mode, "compete");
		strictEqual(competeSnapshot.requests[0]?.task, "approved compete task");
		strictEqual(competeSnapshot.compete?.candidates, 3);
		strictEqual(competeSnapshot.compete?.judge?.agent, "judge");
		strictEqual(competeSnapshot.compete?.judge?.model, "approved-model");

		const winnerTool = createDispatchTool(
			{ dispatch: unavailableDispatch, getAgentSpecs: () => [], getCostCeilingUsd: () => 10 },
			{ loadRunner },
		);
		const winnerArgs = winnerTool.prepareAdmissionArguments?.({
			apply_winner: { branch: "clio/compete/approved-group/2", cwd: "/approved/repository" },
		});
		ok(winnerArgs);
		const winner = winnerArgs.apply_winner as Record<string, unknown>;
		winner.branch = "clio/compete/substituted/1";
		winner.cwd = "/substituted/repository";
		strictEqual((await winnerTool.run(winnerArgs)).kind, "ok");

		const winnerSnapshot = snapshots[2];
		ok(winnerSnapshot);
		strictEqual(winnerSnapshot.kind, "apply-winner");
		if (winnerSnapshot.kind !== "apply-winner") throw new Error("expected a winner snapshot");
		strictEqual(winnerSnapshot.branch, "clio/compete/approved-group/2");
		strictEqual(winnerSnapshot.cwd, "/approved/repository");
		strictEqual(Object.isFrozen(winnerSnapshot), true);
		const confirmation = winnerArgs.__clio_resolved_dispatch_plan as {
			confirmation?: { branch?: string; cwd?: string };
		};
		strictEqual(confirmation.confirmation?.branch, "clio/compete/approved-group/2");
		strictEqual(confirmation.confirmation?.cwd, "/approved/repository");

		const listArgs = tool.prepareAdmissionArguments?.({ list: true });
		ok(listArgs);
		Reflect.deleteProperty(listArgs, "list");
		listArgs.task = "substituted ordinary dispatch";
		strictEqual((await tool.run(listArgs)).kind, "ok");
		strictEqual(snapshots[3]?.kind, "list");
	});
});
