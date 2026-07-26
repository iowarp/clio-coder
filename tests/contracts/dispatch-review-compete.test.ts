import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { ToolNames } from "../../src/core/tool-names.js";
import type { DispatchContract } from "../../src/domains/dispatch/contract.js";
import {
	DEFAULT_GATE_DECIDER_AGENT_ID,
	gateRouteCorrelation,
	preferIndependentRoute,
} from "../../src/domains/dispatch/execution-role.js";
import {
	parseCompeteGateResult,
	readGateDecisionArtifacts,
	readPendingGateDecisions,
	stagePendingGateOutput,
	verifyGateDecisionArtifact,
} from "../../src/domains/dispatch/gate-decisions.js";
import { JUDGE_GATE_PROMPT, REVIEWER_GATE_PROMPT } from "../../src/domains/dispatch/gate-role-prompts.js";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import { mapAutonomy } from "../../src/domains/safety/autonomy.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import {
	claimCompeteGroup,
	cleanupCompeteGroup,
	createCandidateWorktree,
	isCanonicalPathInside,
	loadCompeteGroup,
	markCompeteGroupCleanupReady,
	mergeWinnerBranch,
	recoverCleanupReadyCompeteGroups,
} from "../../src/tools/compete-worktrees.js";
import { createDispatchTool } from "../../src/tools/dispatch.js";
import { describeDispatchPlan, isPlanScaleDispatchArgs } from "../../src/tools/dispatch-plan.js";
import { createRegistry } from "../../src/tools/registry.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { judgeReport, reviewReport, scriptedGateFabric } from "../harness/gate-fabric.js";

type ToolRunResult =
	| { kind: "ok"; output: string; details?: Record<string, unknown> }
	| { kind: "error"; message: string; details?: Record<string, unknown> };

function approvedDispatchOptions(requestId = "apr-test-dispatch") {
	return { approval: { requestId, requestedBy: "test-operator", actionClass: "dispatch" as const } };
}

function assertPidExited(pid: number): void {
	const deadline = Date.now() + 2_000;
	const sleeper = new Int32Array(new SharedArrayBuffer(4));
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0);
			try {
				const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
				const state = stat
					.slice(stat.lastIndexOf(")") + 1)
					.trim()
					.split(/\s+/u)[0];
				if (state === "Z") return;
			} catch {
				// Non-procfs host: the liveness probe below remains authoritative.
			}
		} catch {
			return;
		}
		Atomics.wait(sleeper, 0, 0, 25);
	}
	throw new Error(`worker pid ${pid} remained live after compete restart recovery`);
}

/**
 * A narrow dispatch fake for the partial-admission transaction tests. The
 * second candidate is rejected at a simulated global capacity gate while the
 * third admission returns one turn later. Accepted runs settle only after an
 * abort attempt, making cleanup-before-settlement directly observable.
 */
function rejectingAdmissionContract(options: { abortThrowsFor?: string } = {}): {
	contract: DispatchContract;
	accepted: string[];
	abortAttempts: string[];
	settled: string[];
	pathPresentAtSettlement: boolean[];
} {
	const accepted: string[] = [];
	const abortAttempts: string[] = [];
	const settled: string[] = [];
	const pathPresentAtSettlement: boolean[] = [];
	const settleByRun = new Map<string, () => void>();
	const contract: DispatchContract = {
		async dispatch(request) {
			const cycle = request.gate?.role === "candidate" ? request.gate.cycle : 0;
			if (cycle === 2) throw new Error("dispatch: admission denied");
			if (cycle === 3) await new Promise<void>((resolve) => setImmediate(resolve));
			const runId = `candidate-run-${cycle}`;
			accepted.push(runId);
			let resolveDone: (() => void) | null = null;
			let isSettled = false;
			const done = new Promise<void>((resolve) => {
				resolveDone = resolve;
			});
			const settle = (): void => {
				if (isSettled) return;
				isSettled = true;
				settled.push(runId);
				pathPresentAtSettlement.push(request.cwd !== undefined && existsSync(request.cwd));
				resolveDone?.();
			};
			settleByRun.set(runId, settle);
			const events = (async function* () {
				await done;
				yield* [];
			})();
			return {
				runId,
				events,
				finalPromise: done.then(() => ({ runId, agentId: request.agentId, exitCode: 1 }) as unknown as RunReceipt),
			};
		},
		async dispatchBatch() {
			throw new Error("not used");
		},
		listRuns: () => [],
		getRun: () => null,
		abort(runId) {
			abortAttempts.push(runId);
			const settle = settleByRun.get(runId);
			if (settle !== undefined) queueMicrotask(settle);
			if (runId === options.abortThrowsFor) throw new Error(`injected abort failure for ${runId}`);
		},
		steer: () => {
			throw new Error("not used");
		},
		snapshot: () => ({
			generatedAt: new Date(0).toISOString(),
			running: [],
			retrying: [],
			totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0, runtimeSeconds: 0 },
		}),
		async drain() {
			for (const settle of settleByRun.values()) settle();
		},
	};
	return { contract, accepted, abortAttempts, settled, pathPresentAtSettlement };
}

function receiptsByRole(
	details: Record<string, unknown> | undefined,
	dispatchContract: {
		getRun(runId: string): { receiptPath: string | null } | null;
	},
): Map<string, RunReceipt[]> {
	const byRole = new Map<string, RunReceipt[]>();
	const runs = (details?.runs ?? []) as Array<{ runId: string }>;
	for (const run of runs) {
		const path = dispatchContract.getRun(run.runId)?.receiptPath;
		if (!path) continue;
		const receipt = JSON.parse(readFileSync(path, "utf8")) as RunReceipt;
		const role = receipt.gate?.role ?? "none";
		byRole.set(role, [...(byRole.get(role) ?? []), receipt]);
	}
	return byRole;
}

function decisionOutcomes(group: string): string[] {
	return readGateDecisionArtifacts(group)
		.map(({ artifact }) => {
			deepStrictEqual(verifyGateDecisionArtifact(artifact), { ok: true });
			return artifact.outcome;
		})
		.sort();
}

/** A throwaway git repository with one commit, as compete requires. */
function makeCompeteRepo(): string {
	const repo = mkdtempSync(join(tmpdir(), "clio-compete-repo-"));
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
	git("init", "-b", "main");
	git("config", "user.name", "test");
	git("config", "user.email", "test@local");
	writeFileSync(join(repo, "README.md"), "hello\n");
	git("add", "-A");
	git("commit", "-m", "init");
	return repo;
}

function subjectRefForTest(receipt: RunReceipt): { runId: string; digest: string } {
	const digest = receipt.integrity?.digest;
	if (digest === undefined) throw new Error(`receipt ${receipt.runId} has no integrity digest`);
	return { runId: receipt.runId, digest };
}

describe("dispatch plan detection", () => {
	it("classifies plan-scale calls and hashes deterministically", () => {
		strictEqual(isPlanScaleDispatchArgs({ tasks: ["one"] }), false);
		strictEqual(isPlanScaleDispatchArgs({ tasks: ["one", "two"] }), true);
		strictEqual(isPlanScaleDispatchArgs({ tasks: ["one"], mode: "compete" }), true);
		strictEqual(isPlanScaleDispatchArgs({ tasks: ["one"], node: "blade" }), true);
		strictEqual(isPlanScaleDispatchArgs({ tasks: ["one"], node: "local" }), false);
		strictEqual(isPlanScaleDispatchArgs({ apply_winner: { branch: "clio/compete/x/1" } }), true);
		strictEqual(isPlanScaleDispatchArgs({ tasks: ["one"], list: true }), false);
		const a = describeDispatchPlan({ tasks: ["one", "two"], agent: "coder" });
		const b = describeDispatchPlan({ tasks: ["one", "two"], agent: "coder" });
		strictEqual(a.hash, b.hash);
		match(a.text, /topology=parallel tasks=2/);
	});

	it("routes plan-scale dispatch through one approval per autonomy level", () => {
		strictEqual(mapAutonomy("auto-edit", "dispatch", { dispatchPlanScale: true }), "ask");
		strictEqual(mapAutonomy("auto-edit", "dispatch", {}), "allow");
		strictEqual(mapAutonomy("full-auto", "dispatch", { dispatchPlanScale: true }), "allow");
		strictEqual(mapAutonomy("suggest", "dispatch", { dispatchPlanScale: true }), "ask");
		strictEqual(mapAutonomy("read-only", "dispatch", { dispatchPlanScale: true }), "deny");
	});
});

describe("reviewer-gated dispatch", () => {
	beforeEach(() => {
		isolateDispatchState();
	});
	after(() => {
		restoreDispatchState();
	});

	it("a retried reviewer resolves its staged output against the terminal attempt", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 1;
		const fabric = scriptedGateFabric({
			reviewerFailures: 1,
			reviewerAnswers: [reviewReport("pass", "retry verified the work")],
		});
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			resilienceCooldownMs: 0,
			spawnWorker: fabric.spawn,
		});
		await bundle.extension.start();
		try {
			const result = (await createDispatchTool({ dispatch: bundle.contract }).run(
				{ tasks: ["fix after reviewer retry"], review: true },
				approvedDispatchOptions(),
			)) as ToolRunResult;
			strictEqual(result.kind, "ok", result.kind === "error" ? result.message : "");
			const artifacts = readGateDecisionArtifacts();
			const passed = artifacts.find(({ artifact }) => artifact.topology === "review" && artifact.outcome === "pass");
			ok(passed?.artifact.decider);
			const reviewerReceipt = receiptsByRole(result.details, bundle.contract).get("reviewer")?.[0];
			strictEqual(passed.artifact.decider.runId, reviewerReceipt?.runId);
			ok(reviewerReceipt?.lineage);
			notStrictEqual(passed.artifact.decider.runId, reviewerReceipt.lineage.rootRunId);
			deepStrictEqual(readPendingGateDecisions(), { records: [], errors: [] });
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("crash recovery rebuilds a retried decider decision from verified receipts", async () => {
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 1;
		const fabric = scriptedGateFabric({ reviewerFailures: 1 });
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			resilienceCooldownMs: 0,
			spawnWorker: fabric.spawn,
		});
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract });
			const subjectResult = (await tool.run({ tasks: ["recovery subject"] }, approvedDispatchOptions())) as ToolRunResult;
			strictEqual(subjectResult.kind, "ok");
			const subject = receiptsByRole(subjectResult.details, bundle.contract).get("none")?.[0];
			ok(subject);
			const group = "retried-reviewer-recovery";
			const handle = await bundle.contract.dispatch({
				agentId: DEFAULT_GATE_DECIDER_AGENT_ID,
				executionRole: "reviewer",
				task: `Review the work of builder run ${subject.runId}`,
				gate: { role: "reviewer", group, cycle: 1, subjects: [subjectRefForTest(subject)] },
			});
			for await (const _event of handle.events) {
				// Simulate the coordinator draining and durably staging terminal output.
			}
			const terminal = await handle.finalPromise;
			ok(terminal.lineage);
			notStrictEqual(terminal.runId, terminal.lineage.rootRunId);
			stagePendingGateOutput({
				group,
				topology: "review",
				cycle: 1,
				subjects: [subjectRefForTest(subject)],
				deciderRunId: terminal.runId,
				finalOutput: reviewReport("pass", "recovered terminal retry"),
			});

			const trigger = (await tool.run({ tasks: ["trigger recovery"] }, approvedDispatchOptions())) as ToolRunResult;
			strictEqual(trigger.kind, "ok", trigger.kind === "error" ? trigger.message : "");
			const recovered = readGateDecisionArtifacts(group).find(({ artifact }) => artifact.outcome === "pass");
			strictEqual(recovered?.artifact.decider?.runId, terminal.runId);
			deepStrictEqual(readPendingGateDecisions(), { records: [], errors: [] });
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("passes on the first cycle with chained receipts and a read-only reviewer", async () => {
		const fabric = scriptedGateFabric({ reviewerAnswers: [reviewReport("pass", "build and tests are green")] });
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: fabric.spawn });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract });
			const result = (await tool.run(
				{ tasks: ["fix the build"], review: true },
				approvedDispatchOptions(),
			)) as ToolRunResult;
			strictEqual(result.kind, "ok", result.kind === "error" ? result.message : "");
			ok(result.kind === "ok");
			match(result.output, /review gate passed after 1 cycle/);
			const gate = result.details?.gate as { verdict: string; cycles: number };
			strictEqual(gate.verdict, "pass");

			const byRole = receiptsByRole(result.details, bundle.contract);
			const builder = byRole.get("builder")?.[0];
			const reviewer = byRole.get("reviewer")?.[0];
			ok(builder && reviewer, "builder and reviewer receipts sealed");
			strictEqual(builder?.gate?.group, reviewer?.gate?.group);
			ok(builder?.gate?.group);
			deepStrictEqual(decisionOutcomes(builder?.gate?.group ?? ""), ["pass"]);
			deepStrictEqual(reviewer?.gate?.subjects, [{ runId: builder?.runId, digest: builder?.integrity.digest }]);
			// The reviewer ran read-only regardless of the session level.
			const reviewerSpawn = fabric.spawns.find((entry) => entry.spec.task.startsWith("Review the work"));
			strictEqual(reviewerSpawn?.spec.autonomy, "read-only");
			ok(reviewerSpawn?.spec.systemPrompt.startsWith("# Identity\n\nYou are Clio"));
			ok(reviewerSpawn?.spec.systemPrompt.endsWith(REVIEWER_GATE_PROMPT));
			match(reviewerSpawn?.spec.task ?? "", new RegExp(builder?.runId ?? "missing-builder-run"));
			strictEqual(reviewerSpawn?.spec.task.includes("plan-builder-"), false);
			// Both receipts still verify against their ledger rows.
			for (const receipt of [builder, reviewer]) {
				ok(receipt);
				const envelope = bundle.contract.getRun(receipt.runId);
				ok(envelope);
				if (receipt && envelope) deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: true });
			}
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("reconstructs staged reviewer output from verified receipts on the next dispatch", async () => {
		const fabric = scriptedGateFabric({ reviewerAnswers: [reviewReport("pass")] });
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: fabric.spawn });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract });
			const first = (await tool.run(
				{ tasks: ["produce receipt fixtures"], review: true },
				approvedDispatchOptions(),
			)) as ToolRunResult;
			strictEqual(first.kind, "ok");
			const byRole = receiptsByRole(first.details, bundle.contract);
			const builder = byRole.get("builder")?.[0];
			const reviewer = byRole.get("reviewer")?.[0];
			ok(builder && reviewer);
			if (builder === undefined || reviewer === undefined) throw new Error("receipt fixtures missing");

			// A failure with cycles left replays as revise, the same failure at the
			// bound replays as the terminal fail, and an answer that does not satisfy
			// the contract replays as a broken gate rather than a free extra cycle.
			stagePendingGateOutput({
				group: "restart-review-revise",
				topology: "review",
				cycle: 1,
				subjects: [subjectRefForTest(builder)],
				deciderRunId: reviewer.runId,
				finalOutput: reviewReport("fail", "recovered findings"),
			});
			stagePendingGateOutput({
				group: "restart-review-fail",
				topology: "review",
				cycle: 1,
				subjects: [subjectRefForTest(builder)],
				deciderRunId: reviewer.runId,
				finalOutput: reviewReport("fail", "still wrong"),
				terminalCycle: true,
			});
			stagePendingGateOutput({
				group: "restart-review-broken",
				topology: "review",
				cycle: 1,
				subjects: [subjectRefForTest(builder)],
				deciderRunId: reviewer.runId,
				finalOutput: "VERDICT: pass",
				terminalCycle: true,
			});

			const trigger = (await tool.run({ tasks: ["trigger gate recovery"] }, {})) as ToolRunResult;
			strictEqual(trigger.kind, "ok");
			deepStrictEqual(decisionOutcomes("restart-review-revise"), ["revise"]);
			deepStrictEqual(decisionOutcomes("restart-review-fail"), ["fail"]);
			deepStrictEqual(decisionOutcomes("restart-review-broken"), ["exhausted"]);
			deepStrictEqual(readPendingGateDecisions(), { records: [], errors: [] });
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("threads revise findings into the builder rerun and records the verdict on its receipt", async () => {
		const fabric = scriptedGateFabric({
			reviewerAnswers: [reviewReport("fail", "missing tests"), reviewReport("pass")],
		});
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: fabric.spawn });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract });
			const result = (await tool.run(
				{ tasks: ["fix the build"], review: { max_cycles: 2 } },
				approvedDispatchOptions(),
			)) as ToolRunResult;
			strictEqual(result.kind, "ok");
			ok(result.kind === "ok");
			match(result.output, /review gate passed after 2 cycle/);

			const byRole = receiptsByRole(result.details, bundle.contract);
			const builders = byRole.get("builder") ?? [];
			const reviewers = byRole.get("reviewer") ?? [];
			strictEqual(builders.length, 2);
			strictEqual(reviewers.length, 2);
			const firstReviewer = reviewers.find((receipt) => receipt.gate?.cycle === 1);
			const secondBuilder = builders.find((receipt) => receipt.gate?.cycle === 2);
			ok(firstReviewer && secondBuilder);
			strictEqual(secondBuilder?.gate?.verdict, "revise");
			deepStrictEqual(secondBuilder?.gate?.subjects, [
				{ runId: firstReviewer?.runId, digest: firstReviewer?.integrity.digest },
			]);
			// The findings crossed as threaded input data (pipeline provenance).
			notStrictEqual(secondBuilder?.pipeline, undefined);
			strictEqual(secondBuilder?.pipeline?.fromRunId, firstReviewer?.runId);
			ok(firstReviewer?.gate?.group);
			deepStrictEqual(decisionOutcomes(firstReviewer?.gate?.group ?? ""), ["pass", "revise"]);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("surfaces exhaustion as a needs-decision error, never a silent failure", async () => {
		// A reviewer that cannot produce its declared contract graded nothing, so the
		// gate fails closed to the operator instead of burning another cycle.
		const fabric = scriptedGateFabric({ reviewerAnswers: ["findings...\nVERDICT: revise"] });
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: fabric.spawn });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract });
			const result = (await tool.run(
				{ tasks: ["fix the build"], review: { max_cycles: 1 } },
				approvedDispatchOptions(),
			)) as ToolRunResult;
			strictEqual(result.kind, "error");
			ok(result.kind === "error");
			match(result.message, /review gate needs an operator decision/);
			match(result.message, /no structured verdict in cycle 1/);
			const gate = result.details?.gate as { verdict: string | null; needsDecision?: string };
			strictEqual(gate.verdict, null);
			ok(gate.needsDecision);
			const group = receiptsByRole(result.details, bundle.contract).get("reviewer")?.[0]?.gate?.group;
			ok(group);
			deepStrictEqual(decisionOutcomes(group ?? ""), ["exhausted"]);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("reports a fail verdict as gate failure", async () => {
		const fabric = scriptedGateFabric({ reviewerAnswers: [reviewReport("fail", "wrong approach")] });
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: fabric.spawn });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract });
			const result = (await tool.run(
				{ tasks: ["fix the build"], review: { max_cycles: 1 } },
				approvedDispatchOptions(),
			)) as ToolRunResult;
			strictEqual(result.kind, "error");
			ok(result.kind === "error");
			match(result.message, /review gate failed/);
			const group = receiptsByRole(result.details, bundle.contract).get("reviewer")?.[0]?.gate?.group;
			ok(group);
			deepStrictEqual(decisionOutcomes(group ?? ""), ["fail"]);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("seals plan provenance onto every run of a plan-scale dispatch", async () => {
		const fabric = scriptedGateFabric({});
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: fabric.spawn });
		await bundle.extension.start();
		try {
			const args = { tasks: ["one", "two"] };
			const tool = createDispatchTool({ dispatch: bundle.contract, getAutonomy: () => "full-auto" });
			const prepared = tool.prepareAdmissionArguments?.(args) ?? args;
			const expected = describeDispatchPlan(prepared);
			const result = (await tool.run(prepared, {})) as ToolRunResult;
			strictEqual(result.kind, "ok");
			const runs = (result.details?.runs ?? []) as Array<{ runId: string }>;
			strictEqual(runs.length, 2);
			for (const run of runs) {
				const envelope = bundle.contract.getRun(run.runId);
				ok(envelope?.receiptPath);
				const receipt = JSON.parse(readFileSync(envelope?.receiptPath ?? "", "utf8")) as RunReceipt;
				strictEqual(receipt.plan?.hash, expected.hash);
				strictEqual(receipt.plan?.approval, "full-auto");
				strictEqual(receipt.plan?.topology, "parallel");
				strictEqual(receipt.plan?.taskCount, 2);
				if (envelope) deepStrictEqual(verifyReceiptIntegrity(receipt, envelope), { ok: true });
			}
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("executes every review cycle on its own approved role placement", async () => {
		const fabric = scriptedGateFabric({ reviewerAnswers: [reviewReport("fail"), reviewReport("pass")] });
		const placements: string[] = [];
		const nodeFor = (role: string | undefined, cycle: number | undefined) => `${role ?? "task"}-${cycle ?? 1}`;
		const bundle = makeDispatchBundle(dispatchStubContext(), {
			spawnWorker: fabric.spawn,
			previewNode: (request) => {
				const id = nodeFor(request.gate?.role, request.gate?.cycle);
				return { node: { id, kind: "ssh", host: `${id}.example.test` } };
			},
			resolveNode: (request) => {
				const id = request.node ?? "missing";
				placements.push(id);
				return { node: { id, kind: "ssh", host: `${id}.example.test` }, spawn: fabric.spawn, release: () => {} };
			},
		});
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract, getAutonomy: () => "full-auto" });
			const result = (await tool.run({ tasks: ["review twice"], review: { max_cycles: 2 } }, {})) as ToolRunResult;
			strictEqual(result.kind, "ok");
			deepStrictEqual(placements, ["builder-1", "reviewer-1", "builder-2", "reviewer-2"]);
		} finally {
			await bundle.extension.stop?.();
		}
	});
});

describe("compete dispatch", () => {
	it("a retried judge resolves its staged output against the terminal attempt", async () => {
		const repo = makeCompeteRepo();
		const settings = structuredClone(DEFAULT_SETTINGS);
		settings.workers.maxRetries = 1;
		const fabric = scriptedGateFabric({ judgeFailures: 1, judgeAnswers: [judgeReport(2, "retry chose two")] });
		const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
			resilienceCooldownMs: 0,
			spawnWorker: fabric.spawn,
		});
		await bundle.extension.start();
		try {
			const result = (await createDispatchTool({ dispatch: bundle.contract, getAutonomy: () => "full-auto" }).run(
				{ tasks: [{ task: "retry the judge", cwd: repo }], mode: "compete", candidates: 2 },
				{},
			)) as ToolRunResult;
			strictEqual(result.kind, "ok", result.kind === "error" ? result.message : "");
			const winner = readGateDecisionArtifacts().find(({ artifact }) => artifact.outcome === "winner");
			ok(winner?.artifact.decider);
			const judge = receiptsByRole(result.details, bundle.contract).get("judge")?.[0];
			strictEqual(winner.artifact.decider.runId, judge?.runId);
			deepStrictEqual(readPendingGateDecisions(), { records: [], errors: [] });
		} finally {
			await bundle.extension.stop?.();
			rmSync(repo, { recursive: true, force: true });
		}
	});
	let repo = "";
	beforeEach(() => {
		isolateDispatchState();
		repo = mkdtempSync(join(tmpdir(), "clio-compete-repo-"));
		const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
		git("init", "-b", "main");
		git("config", "user.name", "test");
		git("config", "user.email", "test@local");
		writeFileSync(join(repo, "README.md"), "hello\n");
		git("add", "-A");
		git("commit", "-m", "init");
	});
	after(() => {
		restoreDispatchState();
	});

	function branches(): string[] {
		return execFileSync("git", ["-C", repo, "branch", "--format=%(refname:short)"], { encoding: "utf8" })
			.split("\n")
			.filter((line) => line.length > 0);
	}

	it("rolls back every branch and worktree when candidate N creation fails after mutating git", async () => {
		const fabric = scriptedGateFabric({});
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: fabric.spawn });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({
				dispatch: bundle.contract,
				getAutonomy: () => "full-auto",
				competeWorktrees: {
					createCandidate(ownership, index) {
						const worktree = createCandidateWorktree(ownership, index);
						if (index === 2) throw new Error("injected candidate 2 creation failure");
						return worktree;
					},
				},
			});
			const result = (await tool.run(
				{ tasks: [{ task: "improve the readme", cwd: repo }], mode: "compete", candidates: 3 },
				{},
			)) as ToolRunResult;
			strictEqual(result.kind, "error");
			ok(result.kind === "error");
			match(result.message, /injected candidate 2 creation failure/);
			strictEqual(fabric.spawns.length, 0);
			strictEqual(existsSync(join(repo, ".clio", "worktrees")), false);
			deepStrictEqual(
				branches().filter((branch) => branch.startsWith("clio/compete/")),
				[],
			);
		} finally {
			await bundle.extension.stop?.();
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("aborts and settles accepted candidates when capacity rejects one admission and a sibling arrives late", async () => {
		const fake = rejectingAdmissionContract();
		try {
			const tool = createDispatchTool({ dispatch: fake.contract, getAutonomy: () => "full-auto" });
			const result = (await tool.run(
				{ tasks: [{ task: "improve the readme", cwd: repo }], mode: "compete", candidates: 3 },
				{},
			)) as ToolRunResult;
			strictEqual(result.kind, "error");
			ok(result.kind === "error");
			match(result.message, /candidate admission failed/);
			match(result.message, /admission denied/);
			deepStrictEqual(fake.accepted, ["candidate-run-1", "candidate-run-3"]);
			deepStrictEqual(fake.abortAttempts, ["candidate-run-1", "candidate-run-3"]);
			deepStrictEqual(fake.settled, ["candidate-run-1", "candidate-run-3"]);
			deepStrictEqual(fake.pathPresentAtSettlement, [true, true]);
			strictEqual(existsSync(join(repo, ".clio", "worktrees")), false);
			deepStrictEqual(
				branches().filter((branch) => branch.startsWith("clio/compete/")),
				[],
			);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("still awaits every worker and surfaces an abort failure before cleaning paths", async () => {
		const fake = rejectingAdmissionContract({ abortThrowsFor: "candidate-run-1" });
		try {
			const tool = createDispatchTool({ dispatch: fake.contract, getAutonomy: () => "full-auto" });
			const result = (await tool.run(
				{ tasks: [{ task: "improve the readme", cwd: repo }], mode: "compete", candidates: 3 },
				{},
			)) as ToolRunResult;
			strictEqual(result.kind, "error");
			ok(result.kind === "error");
			match(result.message, /injected abort failure for candidate-run-1/);
			deepStrictEqual(fake.abortAttempts, ["candidate-run-1", "candidate-run-3"]);
			deepStrictEqual(fake.settled, ["candidate-run-1", "candidate-run-3"]);
			deepStrictEqual(fake.pathPresentAtSettlement, [true, true]);
			strictEqual(existsSync(join(repo, ".clio", "worktrees")), false);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("records cleanup-ready before cleanup and recovers an injected cleanup crash on the next startup", async () => {
		const fabric = scriptedGateFabric({ builderWritesFile: "answer.txt", judgeAnswers: ["no winner"] });
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: fabric.spawn });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({
				dispatch: bundle.contract,
				getAutonomy: () => "full-auto",
				competeWorktrees: {
					cleanupGroup() {
						throw new Error("injected cleanup crash");
					},
				},
			});
			const result = (await tool.run(
				{ tasks: [{ task: "improve the readme", cwd: repo }], mode: "compete", candidates: 2 },
				approvedDispatchOptions("apr-test-compete"),
			)) as ToolRunResult;
			strictEqual(result.kind, "error");
			ok(result.kind === "error");
			match(result.message, /injected cleanup crash/);

			const parent = join(repo, ".clio", "worktrees");
			const groups = readdirSync(parent);
			strictEqual(groups.length, 1);
			const group = groups[0];
			ok(group);
			strictEqual(loadCompeteGroup(repo, group)?.state, "cleanup-ready");

			const recovery = recoverCleanupReadyCompeteGroups(repo);
			deepStrictEqual(recovery.cleaned, [group]);
			deepStrictEqual(recovery.failed, []);
			strictEqual(existsSync(parent), false);
			deepStrictEqual(
				branches().filter((branch) => branch.startsWith("clio/compete/")),
				[],
			);
		} finally {
			await bundle.extension.stop?.();
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("uses segment-safe ownership so colliding group names cannot cross-delete", () => {
		let short = claimCompeteGroup(repo, "collision");
		let longer = claimCompeteGroup(repo, "collision-extra");
		const shortCandidate = createCandidateWorktree(short, 1);
		const longerCandidate = createCandidateWorktree(longer, 1);
		try {
			strictEqual(isCanonicalPathInside(short.directory, longerCandidate.path), false);
			short = markCompeteGroupCleanupReady(short);
			cleanupCompeteGroup(short);

			strictEqual(existsSync(shortCandidate.path), false);
			strictEqual(existsSync(longerCandidate.path), true);
			strictEqual(loadCompeteGroup(repo, longer.group)?.state, "active");
			deepStrictEqual(
				branches().filter((branch) => branch.startsWith("clio/compete/")),
				[longerCandidate.branch],
			);

			longer = markCompeteGroupCleanupReady(longer);
			cleanupCompeteGroup(longer);
			strictEqual(existsSync(join(repo, ".clio", "worktrees")), false);
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("recovers only proven cleanup-ready crash leftovers and preserves active or unproven groups", () => {
		let cleanupReady = claimCompeteGroup(repo, "crashed-after-settlement");
		createCandidateWorktree(cleanupReady, 1);
		cleanupReady = markCompeteGroupCleanupReady(cleanupReady);
		let active = claimCompeteGroup(repo, "crashed-while-active");
		const activeCandidate = createCandidateWorktree(active, 1);
		const unproven = join(repo, ".clio", "worktrees", "missing-manifest");
		mkdirSync(unproven);
		try {
			const recovery = recoverCleanupReadyCompeteGroups(repo);
			deepStrictEqual(recovery.cleaned, [cleanupReady.group]);
			ok(recovery.preserved.includes(active.group));
			ok(recovery.preserved.includes("missing-manifest"));
			deepStrictEqual(recovery.failed, []);
			strictEqual(existsSync(cleanupReady.directory), false);
			strictEqual(existsSync(activeCandidate.path), true);
			strictEqual(existsSync(unproven), true);

			active = markCompeteGroupCleanupReady(active);
			cleanupCompeteGroup(active);
			rmSync(unproven, { recursive: true, force: true });
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("terminates a hard-crash worker lease and removes its active group on restart", () => {
		const script = `
			import { spawn } from "node:child_process";
			import {
				claimCompeteGroup,
				createCandidateWorktree,
				registerCompeteGroupRun,
			} from "./src/tools/compete-worktrees.ts";
			const root = process.env.CLIO_TEST_COMPETE_ROOT;
			if (!root) throw new Error("missing recovery root");
			const ownership = claimCompeteGroup(root, "hard-crash-active");
			createCandidateWorktree(ownership, 1);
			const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
				detached: true,
				stdio: "ignore",
			});
			if (!worker.pid) throw new Error("worker did not start");
			worker.unref();
			registerCompeteGroupRun(ownership, {
				runId: "crashed-run",
				pid: worker.pid,
				runtimeKind: "acp-delegation",
			});
			process.stdout.write(JSON.stringify({ pid: worker.pid, group: ownership.group }));
		`;
		let workerPid: number | null = null;
		try {
			const raw = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
				cwd: process.cwd(),
				encoding: "utf8",
				env: { ...process.env, CLIO_TEST_COMPETE_ROOT: repo },
				timeout: 15_000,
			});
			const claimed = JSON.parse(raw) as { pid: number; group: string };
			workerPid = claimed.pid;
			process.kill(workerPid, 0);

			const recovery = recoverCleanupReadyCompeteGroups(repo);
			deepStrictEqual(recovery.cleaned, [claimed.group]);
			deepStrictEqual(recovery.failed, []);
			strictEqual(existsSync(join(repo, ".clio", "worktrees")), false);
			deepStrictEqual(
				branches().filter((branch) => branch.startsWith("clio/compete/")),
				[],
			);
			assertPidExited(workerPid);
		} finally {
			if (workerPid !== null) {
				try {
					process.kill(-workerPid, "SIGKILL");
				} catch {
					// Recovery already terminated the detached process group.
				}
			}
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("reconstructs a staged judge winner and preserves only that crash-leftover branch", async () => {
		const fabric = scriptedGateFabric({});
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: fabric.spawn });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract, getAutonomy: () => "full-auto" });
			const candidateResult = (await tool.run({ tasks: [{ task: "candidate receipt", cwd: repo }] }, {})) as ToolRunResult;
			const judgeResult = (await tool.run({ tasks: [{ task: "judge receipt", cwd: repo }] }, {})) as ToolRunResult;
			strictEqual(candidateResult.kind, "ok");
			strictEqual(judgeResult.kind, "ok");
			const receiptFor = (result: ToolRunResult): RunReceipt => {
				const runId = (result.details?.runs as Array<{ runId: string }> | undefined)?.[0]?.runId;
				if (runId === undefined) throw new Error("fixture run id missing");
				const path = bundle.contract.getRun(runId)?.receiptPath;
				if (path === null || path === undefined) throw new Error("fixture receipt path missing");
				return JSON.parse(readFileSync(path, "utf8")) as RunReceipt;
			};
			const candidate = receiptFor(candidateResult);
			const judge = receiptFor(judgeResult);

			const script = `
				import {
					claimCompeteGroup,
					createCandidateWorktree,
				} from "./src/tools/compete-worktrees.ts";
				const root = process.env.CLIO_TEST_COMPETE_ROOT;
				if (!root) throw new Error("missing recovery root");
				const ownership = claimCompeteGroup(root, "restart-judge-winner");
				createCandidateWorktree(ownership, 1);
				createCandidateWorktree(ownership, 2);
				process.stdout.write(JSON.stringify({ group: ownership.group }));
			`;
			const claimed = JSON.parse(
				execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
					cwd: process.cwd(),
					encoding: "utf8",
					env: { ...process.env, CLIO_TEST_COMPETE_ROOT: repo },
					timeout: 15_000,
				}),
			) as { group: string };
			stagePendingGateOutput({
				group: claimed.group,
				topology: "compete",
				cycle: 1,
				subjects: [subjectRefForTest(candidate)],
				deciderRunId: judge.runId,
				finalOutput: judgeReport(1, "recovered ranking"),
				resourceRoot: repo,
			});

			const trigger = (await tool.run({ tasks: [{ task: "trigger judge recovery", cwd: repo }] }, {})) as ToolRunResult;
			strictEqual(trigger.kind, "ok");
			const recovered = loadCompeteGroup(repo, claimed.group);
			strictEqual(recovered?.state, "winner-preserved");
			strictEqual(recovered?.winnerIndex, 1);
			strictEqual(existsSync(join(recovered?.directory ?? "", "candidate-1")), true);
			strictEqual(existsSync(join(recovered?.directory ?? "", "candidate-2")), false);
			deepStrictEqual(decisionOutcomes(claimed.group), ["winner"]);
			deepStrictEqual(readPendingGateDecisions(), { records: [], errors: [] });

			if (recovered !== null) cleanupCompeteGroup(markCompeteGroupCleanupReady(recovered));
		} finally {
			await bundle.extension.stop?.();
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("fails closed without deleting a pending compete group whose decider receipt is absent", async () => {
		const script = `
			import {
				claimCompeteGroup,
				createCandidateWorktree,
			} from "./src/tools/compete-worktrees.ts";
			const root = process.env.CLIO_TEST_COMPETE_ROOT;
			if (!root) throw new Error("missing recovery root");
			const ownership = claimCompeteGroup(root, "restart-missing-receipt");
			createCandidateWorktree(ownership, 1);
			createCandidateWorktree(ownership, 2);
			process.stdout.write(JSON.stringify({ group: ownership.group }));
		`;
		const claimed = JSON.parse(
			execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
				cwd: process.cwd(),
				encoding: "utf8",
				env: { ...process.env, CLIO_TEST_COMPETE_ROOT: repo },
				timeout: 15_000,
			}),
		) as { group: string };
		stagePendingGateOutput({
			group: claimed.group,
			topology: "compete",
			cycle: 1,
			subjects: [{ runId: "missing-candidate", digest: "a".repeat(64) }],
			deciderRunId: "missing-judge",
			finalOutput: judgeReport(1),
			resourceRoot: repo,
		});
		const fabric = scriptedGateFabric({});
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: fabric.spawn });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract, getAutonomy: () => "full-auto" });
			const result = (await tool.run({ tasks: [{ task: "must not start", cwd: repo }] }, {})) as ToolRunResult;
			strictEqual(result.kind, "error");
			if (result.kind === "error") match(result.message, /failed closed.*no verified decider receipt/);
			strictEqual(fabric.spawns.length, 0);
			const preserved = loadCompeteGroup(repo, claimed.group);
			strictEqual(preserved?.state, "active");
			strictEqual(existsSync(join(preserved?.directory ?? "", "candidate-1")), true);
			strictEqual(existsSync(join(preserved?.directory ?? "", "candidate-2")), true);
			strictEqual(readPendingGateDecisions().records.length, 1);
			if (preserved !== null) cleanupCompeteGroup(markCompeteGroupCleanupReady(preserved));
		} finally {
			await bundle.extension.stop?.();
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("full-auto applies the judge's pick and cleans every worktree and branch", async () => {
		const fabric = scriptedGateFabric({
			builderWritesFile: "answer.txt",
			judgeAnswers: [judgeReport(2, "candidate 2 is more complete")],
		});
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: fabric.spawn });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract, getAutonomy: () => "full-auto" });
			const result = (await tool.run(
				{ tasks: [{ task: "improve the readme", cwd: repo }], mode: "compete", candidates: 2 },
				{},
			)) as ToolRunResult;
			strictEqual(result.kind, "ok", result.kind === "error" ? result.message : "");
			ok(result.kind === "ok");
			match(result.output, /compete winner candidate 2 applied/);
			const judgeSpawn = fabric.spawns.find((entry) => entry.spec.task.startsWith("Rank "));
			ok(judgeSpawn, "judge receives the runtime ranking task");
			strictEqual(judgeSpawn?.spec.autonomy, "read-only");
			ok(judgeSpawn?.spec.systemPrompt.startsWith("# Identity\n\nYou are Clio"));
			ok(judgeSpawn?.spec.systemPrompt.endsWith(JUDGE_GATE_PROMPT));
			strictEqual(judgeSpawn?.spec.task.includes("Plan-time capability check"), false);
			// The winner's work landed in the repository working tree.
			const applied = readFileSync(join(repo, "answer.txt"), "utf8");
			match(applied, /candidate-2/);
			// Losers and winner scaffolding are both gone after an applied pick.
			strictEqual(existsSync(join(repo, ".clio", "worktrees")), false);
			deepStrictEqual(
				branches().filter((branch) => branch.startsWith("clio/compete/")),
				[],
			);
			// The judge receipt references every candidate's digest.
			const byRole = receiptsByRole(result.details, bundle.contract);
			const judge = byRole.get("judge")?.[0];
			const candidates = byRole.get("candidate") ?? [];
			strictEqual(candidates.length, 2);
			strictEqual(judge?.gate?.subjects?.length, 2);
			for (const candidate of candidates) {
				ok(judge?.gate?.subjects?.some((subject) => subject.runId === candidate.runId));
				const envelope = bundle.contract.getRun(candidate.runId);
				ok(envelope);
				if (envelope) deepStrictEqual(verifyReceiptIntegrity(candidate, envelope), { ok: true });
			}
			// Compete runs carry plan provenance (compete is plan-scale).
			strictEqual(candidates[0]?.plan?.topology, "compete");
			strictEqual(candidates[0]?.plan?.approval, "full-auto");
			ok(judge?.gate?.group);
			deepStrictEqual(decisionOutcomes(judge?.gate?.group ?? ""), ["full-auto-applied", "winner"]);
		} finally {
			await bundle.extension.stop?.();
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("executes every compete role on its own approved placement", async () => {
		const fabric = scriptedGateFabric({ builderWritesFile: "answer.txt", judgeAnswers: [judgeReport(1)] });
		const placements: string[] = [];
		const nodeFor = (role: string | undefined, cycle: number | undefined) => `${role ?? "task"}-${cycle ?? 1}`;
		const bundle = makeDispatchBundle(dispatchStubContext(), {
			spawnWorker: fabric.spawn,
			previewNode: (request) => {
				const id = nodeFor(request.gate?.role, request.gate?.cycle);
				return { node: { id, kind: "ssh", host: `${id}.example.test` } };
			},
			resolveNode: (request) => {
				const id = request.node ?? "missing";
				placements.push(id);
				return { node: { id, kind: "ssh", host: `${id}.example.test` }, spawn: fabric.spawn, release: () => {} };
			},
		});
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract, getAutonomy: () => "full-auto" });
			const result = (await tool.run(
				{ tasks: [{ task: "compete with distinct pins", cwd: repo }], mode: "compete", candidates: 2 },
				{},
			)) as ToolRunResult;
			strictEqual(result.kind, "ok");
			deepStrictEqual(placements, ["candidate-1", "candidate-2", "judge-1"]);
		} finally {
			await bundle.extension.stop?.();
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("blocks a compete winner that changes a parent-session protected artifact", async () => {
		writeFileSync(join(repo, "README.md"), "protected baseline\n");
		execFileSync("git", ["-C", repo, "add", "README.md"]);
		execFileSync("git", ["-C", repo, "commit", "-m", "protected baseline"]);
		const protectedAt = new Date(0).toISOString();
		const fabric = scriptedGateFabric({ builderWritesFile: "README.md", judgeAnswers: [judgeReport(1)] });
		const bundle = makeDispatchBundle(dispatchStubContext(), {
			spawnWorker: fabric.spawn,
			getProtectedArtifactState: () => ({
				artifacts: [
					{
						path: join(repo, "README.md"),
						protectedAt,
						reason: "validated release artifact",
						source: "user",
					},
				],
			}),
		});
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract, getAutonomy: () => "full-auto" });
			const result = (await tool.run(
				{ tasks: [{ task: "change the protected readme", cwd: repo }], mode: "compete", candidates: 2 },
				{},
			)) as ToolRunResult;
			strictEqual(result.kind, "error");
			if (result.kind === "error") match(result.message, /changes protected artifact/);
			strictEqual(readFileSync(join(repo, "README.md"), "utf8"), "protected baseline\n");
			const candidateSpawns = fabric.spawns.filter((spawn) => !spawn.spec.task.startsWith("Rank "));
			strictEqual(candidateSpawns.length, 2);
			for (const spawn of candidateSpawns) {
				const paths = spawn.spec.protectedArtifactState?.artifacts.map((artifact) => artifact.path) ?? [];
				ok(paths.includes(join(repo, "README.md")), "parent absolute path remains protected");
				ok(paths.includes(join(spawn.cwd ?? "", "README.md")), "candidate worktree mirror is protected");
			}
			deepStrictEqual(
				branches().filter((branch) => branch.startsWith("clio/compete/")),
				[],
			);
		} finally {
			await bundle.extension.stop?.();
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("rechecks protected artifacts when a preserved winner is modified before supervised apply", async () => {
		writeFileSync(join(repo, "README.md"), "protected baseline\n");
		execFileSync("git", ["-C", repo, "add", "README.md"]);
		execFileSync("git", ["-C", repo, "commit", "-m", "protected baseline"]);
		const fabric = scriptedGateFabric({ builderWritesFile: "answer.txt", judgeAnswers: [judgeReport(1)] });
		const bundle = makeDispatchBundle(dispatchStubContext(), {
			spawnWorker: fabric.spawn,
			getProtectedArtifactState: () => ({
				artifacts: [
					{
						path: join(repo, "README.md"),
						protectedAt: new Date(0).toISOString(),
						reason: "validated release artifact",
						source: "user",
					},
				],
			}),
		});
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract, getAutonomy: () => "auto-edit" });
			const result = (await tool.run(
				{ tasks: [{ task: "build a safe candidate", cwd: repo }], mode: "compete", candidates: 2 },
				approvedDispatchOptions("apr-protected-compete"),
			)) as ToolRunResult;
			strictEqual(result.kind, "ok");
			const compete = result.details?.compete as { winner: { branch: string } };
			const winnerWorktree = fabric.spawns.find((spawn) => spawn.cwd?.endsWith("candidate-1"))?.cwd;
			if (winnerWorktree === undefined) throw new Error("winner worktree fixture missing");
			writeFileSync(join(winnerWorktree, "README.md"), "tampered after judging\n");
			execFileSync("git", ["-C", winnerWorktree, "add", "README.md"]);
			execFileSync("git", ["-C", winnerWorktree, "commit", "-m", "tamper protected path"]);

			const applied = (await tool.run(
				{ apply_winner: { branch: compete.winner.branch, cwd: repo } },
				approvedDispatchOptions("apr-protected-apply"),
			)) as ToolRunResult;
			strictEqual(applied.kind, "error");
			if (applied.kind === "error") match(applied.message, /changes protected artifact/);
			strictEqual(readFileSync(join(repo, "README.md"), "utf8"), "protected baseline\n");
			ok(branches().includes(compete.winner.branch), "blocked winner stays preserved for operator inspection");
		} finally {
			await bundle.extension.stop?.();
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("supervised keeps the winner for confirmation; apply_winner merges and cleans up", async () => {
		const fabric = scriptedGateFabric({ builderWritesFile: "answer.txt", judgeAnswers: [judgeReport(1)] });
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: fabric.spawn });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract, getAutonomy: () => "auto-edit" });
			const result = (await tool.run(
				{ tasks: [{ task: "improve the readme", cwd: repo }], mode: "compete", candidates: 2 },
				approvedDispatchOptions("apr-test-compete"),
			)) as ToolRunResult;
			strictEqual(result.kind, "ok");
			ok(result.kind === "ok");
			match(result.output, /preserved for confirmation at autonomy auto-edit/);
			const compete = result.details?.compete as { winner: { branch: string; applied: boolean } };
			strictEqual(compete.winner.applied, false);
			// The pick is not applied yet and the loser is gone.
			strictEqual(existsSync(join(repo, "answer.txt")), false);
			const competeBranches = branches().filter((branch) => branch.startsWith("clio/compete/"));
			deepStrictEqual(competeBranches, [compete.winner.branch]);

			// Winner confirmation: the apply_winner call (parked for approval at
			// supervised levels by the registry) merges the branch and cleans up.
			const registry = createRegistry({
				safety: createWorkerSafety({ cwd: repo }),
				autonomy: () => "auto-edit",
			});
			registry.register(tool);
			const approvals: Array<{ requestId: string; plan: ReturnType<typeof describeDispatchPlan> }> = [];
			registry.onPermissionRequired((call, _decision, meta) => {
				approvals.push({ requestId: meta.requestId, plan: describeDispatchPlan(call.args) });
			});
			const pendingApply = registry.invoke({
				tool: ToolNames.Dispatch,
				args: { apply_winner: { branch: compete.winner.branch, cwd: repo } },
			});
			await Promise.resolve();
			strictEqual(approvals.length, 1);
			const approval = approvals[0];
			if (approval === undefined) throw new Error("winner approval was not requested");
			strictEqual(approval.plan.confirmation?.branch, compete.winner.branch);
			strictEqual(approval.plan.costCeilingUsd, 5);
			await registry.resumeParkedCalls({
				actionClass: "dispatch",
				requestId: approval.requestId,
				requestedBy: "test-operator",
			});
			const applyVerdict = await pendingApply;
			strictEqual(applyVerdict.kind, "ok");
			if (applyVerdict.kind !== "ok") throw new Error("winner application did not execute");
			const applied = applyVerdict.result as ToolRunResult;
			strictEqual(applied.kind, "ok");
			const group = /clio\/compete\/([^/]+)\//.exec(compete.winner.branch)?.[1];
			ok(group);
			deepStrictEqual(decisionOutcomes(group ?? ""), ["operator-confirmed", "winner"]);
			match(readFileSync(join(repo, "answer.txt"), "utf8"), /candidate-1/);
			deepStrictEqual(
				branches().filter((branch) => branch.startsWith("clio/compete/")),
				[],
			);
			strictEqual(existsSync(join(repo, ".clio", "worktrees")), false);
		} finally {
			await bundle.extension.stop?.();
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("distinguishes a full-auto retry application from an operator confirmation", async () => {
		const fabric = scriptedGateFabric({ builderWritesFile: "answer.txt", judgeAnswers: [judgeReport(1)] });
		let injectMergeFailure = true;
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: fabric.spawn });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({
				dispatch: bundle.contract,
				getAutonomy: () => "full-auto",
				competeWorktrees: {
					mergeWinner(root, branch) {
						if (injectMergeFailure) return { ok: false, reason: "injected merge conflict" };
						return mergeWinnerBranch(root, branch);
					},
				},
			});
			const first = (await tool.run(
				{ tasks: [{ task: "improve the readme", cwd: repo }], mode: "compete", candidates: 2 },
				{},
			)) as ToolRunResult;
			strictEqual(first.kind, "error");
			const compete = first.details?.compete as { group: string; winner: { branch: string; applied: boolean } };
			strictEqual(compete.winner.applied, false);
			const failedApply = (await tool.run(
				{ apply_winner: { branch: compete.winner.branch, cwd: repo } },
				{},
			)) as ToolRunResult;
			strictEqual(failedApply.kind, "error");
			deepStrictEqual(
				decisionOutcomes(compete.group),
				["winner"],
				"a failed merge must not leave full-auto-applied evidence",
			);
			injectMergeFailure = false;
			const applied = (await tool.run(
				{ apply_winner: { branch: compete.winner.branch, cwd: repo } },
				{},
			)) as ToolRunResult;
			strictEqual(applied.kind, "ok");
			deepStrictEqual(decisionOutcomes(compete.group), ["full-auto-applied", "winner"]);
		} finally {
			await bundle.extension.stop?.();
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("cleans all candidates when the judge picks nothing and reports needs-decision", async () => {
		const fabric = scriptedGateFabric({ builderWritesFile: "answer.txt", judgeAnswers: ["I cannot decide"] });
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: fabric.spawn });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract, getAutonomy: () => "full-auto" });
			const result = (await tool.run(
				{ tasks: [{ task: "improve the readme", cwd: repo }], mode: "compete", candidates: 2 },
				{},
			)) as ToolRunResult;
			strictEqual(result.kind, "error");
			ok(result.kind === "error");
			match(result.message, /compete needs an operator decision/);
			const compete = result.details?.compete as { group: string };
			deepStrictEqual(decisionOutcomes(compete.group), ["no-winner"]);
			strictEqual(existsSync(join(repo, ".clio", "worktrees")), false);
			deepStrictEqual(
				branches().filter((branch) => branch.startsWith("clio/compete/")),
				[],
			);
		} finally {
			await bundle.extension.stop?.();
			rmSync(repo, { recursive: true, force: true });
		}
	});
});

describe("Slice 3 gate role defaults and independence", () => {
	beforeEach(() => {
		isolateDispatchState();
	});
	after(() => {
		restoreDispatchState();
	});

	it("review defaults to verifier and never to the builder", async () => {
		const fabric = scriptedGateFabric({});
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: fabric.spawn });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract });
			const result = (await tool.run(
				{ agent: "coder", tasks: ["fix the build"], review: true },
				approvedDispatchOptions("apr-review-default"),
			)) as ToolRunResult;
			strictEqual(result.kind, "ok", result.kind === "error" ? result.message : "");
			const byRole = receiptsByRole(result.details, bundle.contract);
			const builder = byRole.get("builder")?.[0];
			const reviewer = byRole.get("reviewer")?.[0];
			ok(builder && reviewer, "builder and reviewer receipts sealed");
			strictEqual(builder?.agentId, "coder");
			strictEqual(reviewer?.agentId, DEFAULT_GATE_DECIDER_AGENT_ID);
			notStrictEqual(reviewer?.agentId, builder?.agentId, "an omitted reviewer never routes back to the builder");
			strictEqual(reviewer?.executionRole, "reviewer");
			strictEqual(builder?.executionRole, "builder");
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("compete defaults to verifier and never to the builder", async () => {
		const repo = makeCompeteRepo();
		const fabric = scriptedGateFabric({ builderWritesFile: "answer.txt" });
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: fabric.spawn });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract, getAutonomy: () => "full-auto" });
			const result = (await tool.run(
				{ agent: "coder", tasks: [{ task: "improve the readme", cwd: repo }], mode: "compete", candidates: 2 },
				{},
			)) as ToolRunResult;
			strictEqual(result.kind, "ok", result.kind === "error" ? result.message : "");
			const byRole = receiptsByRole(result.details, bundle.contract);
			const candidates = byRole.get("candidate") ?? [];
			const judge = byRole.get("judge")?.[0];
			strictEqual(candidates.length, 2);
			ok(judge, "judge receipt sealed");
			strictEqual(judge?.agentId, DEFAULT_GATE_DECIDER_AGENT_ID);
			for (const candidate of candidates) {
				strictEqual(candidate.agentId, "coder");
				notStrictEqual(judge?.agentId, candidate.agentId, "an omitted judge never routes back to the builder");
				// Compete candidates are ordinary builder evidence regardless of ordinal.
				strictEqual(candidate.executionRole, "builder");
			}
			strictEqual(judge?.executionRole, "judge");
		} finally {
			await bundle.extension.stop?.();
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("structured gate results replace trailing prose verdicts", async () => {
		// The old protocol is now just malformed text: it proves nothing and the
		// gate fails closed instead of reading a verdict out of prose.
		for (const [answer, expected] of [
			["findings...\nVERDICT: pass", "exhausted"],
			[reviewReport("pass"), "pass"],
		] as const) {
			const fabric = scriptedGateFabric({ reviewerAnswers: [answer] });
			const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: fabric.spawn });
			await bundle.extension.start();
			try {
				const tool = createDispatchTool({ dispatch: bundle.contract });
				const result = (await tool.run(
					{ tasks: ["fix the build"], review: { max_cycles: 1 } },
					approvedDispatchOptions("apr-structured-gate"),
				)) as ToolRunResult;
				const group = receiptsByRole(result.details, bundle.contract).get("reviewer")?.[0]?.gate?.group;
				ok(group);
				deepStrictEqual(decisionOutcomes(group ?? ""), [expected]);
			} finally {
				await bundle.extension.stop?.();
				isolateDispatchState();
			}
		}
		// The judge protocol is structured for the same reason.
		strictEqual(parseCompeteGateResult("reasons\nWINNER: 2", 3).ok, false);
		const judged = parseCompeteGateResult(judgeReport(2), 3);
		ok(judged.ok && judged.result.winner === 2);
		strictEqual(parseCompeteGateResult(judgeReport(9), 3).ok, false, "the winner must name an enumerated candidate");
	});

	it("correlated quality routes are recorded rather than hidden", async () => {
		// Pinning the reviewer to the builder agent is the correlated case a small
		// fleet hits. The gate still runs and its decision still records the
		// correlation, so the evidence is visible instead of silently trusted.
		const fabric = scriptedGateFabric({});
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: fabric.spawn });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract });
			const result = (await tool.run(
				{ agent: "coder", tasks: ["fix the build"], review: { reviewer: "coder" } },
				approvedDispatchOptions("apr-correlated"),
			)) as ToolRunResult;
			strictEqual(result.kind, "ok", result.kind === "error" ? result.message : "");
			const byRole = receiptsByRole(result.details, bundle.contract);
			const group = byRole.get("reviewer")?.[0]?.gate?.group;
			ok(group);
			const decisions = readGateDecisionArtifacts(group ?? "");
			strictEqual(decisions.length, 1);
			const artifact = decisions[0]?.artifact;
			ok(artifact, "the correlated gate is recorded, not dropped");
			deepStrictEqual(verifyGateDecisionArtifact(artifact ?? ({} as never)), { ok: true });
			strictEqual(artifact?.outcome, "pass");
			// Every dimension is sealed, and a shared agent makes it non-independent.
			strictEqual(artifact?.correlation?.agent, true);
			strictEqual(artifact?.correlation?.modelFamily, true);
			strictEqual(artifact?.correlation?.target, true);
			strictEqual(artifact?.correlation?.runtime, true);
			strictEqual(artifact?.correlation?.node, true);
			strictEqual(artifact?.correlation?.independent, false);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("independence preference cannot select a hard-rejected route", () => {
		const subject = {
			agentId: "coder",
			targetId: "primary",
			wireModelId: "model-a",
			runtimeId: "openai",
			nodeId: "local",
		};
		const correlated = { ...subject, agentId: "coder" };
		const independent = { ...subject, agentId: "verifier", wireModelId: "model-b" };

		// Given both, the preference is soft but deterministic: it picks the
		// independent route out of the eligible set.
		strictEqual(
			preferIndependentRoute([correlated, independent], subject, (route) => route),
			independent,
		);
		strictEqual(
			preferIndependentRoute([independent, correlated], subject, (route) => route),
			independent,
		);

		// The caller passes only routes that already cleared every hard filter and
		// quality floor. A rejected route is simply absent, so the preference can
		// never resurrect it: it returns an input or nothing at all.
		const eligibleAfterHardFilters = [correlated];
		strictEqual(
			preferIndependentRoute(eligibleAfterHardFilters, subject, (route) => route),
			correlated,
			"a single-target fleet still runs its gate and reports the correlation",
		);
		ok(!eligibleAfterHardFilters.includes(independent), "the hard-rejected route was never eligible");
		strictEqual(
			preferIndependentRoute([], subject, (route) => route),
			null,
			"nothing eligible selects nothing",
		);
		// Independence is measured, not assumed.
		strictEqual(gateRouteCorrelation(subject, correlated).independent, false);
		strictEqual(gateRouteCorrelation(subject, independent).independent, true);
	});
});
