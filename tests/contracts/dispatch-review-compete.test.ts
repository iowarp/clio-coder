import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { verifyReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import type { RunReceipt } from "../../src/domains/dispatch/types.js";
import type { SpawnedWorker } from "../../src/domains/dispatch/worker-spawn.js";
import { mapAutonomy } from "../../src/domains/safety/autonomy.js";
import { createDispatchTool, parseJudgeWinner, parseReviewVerdict } from "../../src/tools/dispatch.js";
import { describeDispatchPlan, isPlanScaleDispatchArgs } from "../../src/tools/dispatch-plan.js";
import type { WorkerSpec } from "../../src/worker/spec-contract.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

type ToolRunResult =
	| { kind: "ok"; output: string; details?: Record<string, unknown> }
	| { kind: "error"; message: string; details?: Record<string, unknown> };

interface SpawnRecord {
	spec: WorkerSpec;
	cwd: string | undefined;
}

/**
 * Scripted fake worker fabric. Roles are recognized from the task text the
 * dispatch tool composes: reviewer tasks start with "Review the work of
 * builder run", judge tasks with "Rank". Reviewer/judge answers pop from
 * queues; builders answer with a fixed text and optionally write a file into
 * their cwd (which is the candidate worktree under compete).
 */
function scriptedFabric(script: {
	builderText?: string;
	builderWritesFile?: string;
	reviewerAnswers?: string[];
	judgeAnswers?: string[];
}): { spawn: (spec: WorkerSpec, opts?: { cwd?: string }) => SpawnedWorker; spawns: SpawnRecord[] } {
	const spawns: SpawnRecord[] = [];
	const reviewerAnswers = [...(script.reviewerAnswers ?? [])];
	const judgeAnswers = [...(script.judgeAnswers ?? [])];
	const spawn = (spec: WorkerSpec, opts?: { cwd?: string }): SpawnedWorker => {
		spawns.push({ spec, cwd: opts?.cwd });
		let text: string;
		if (spec.task.startsWith("Review the work of builder run")) {
			text = reviewerAnswers.shift() ?? "VERDICT: pass";
		} else if (spec.task.startsWith("Rank ")) {
			text = judgeAnswers.shift() ?? "WINNER: 1";
		} else {
			text = script.builderText ?? "built it";
			if (script.builderWritesFile !== undefined && opts?.cwd !== undefined) {
				writeFileSync(join(opts.cwd, script.builderWritesFile), `work in ${opts.cwd}\n`);
			}
		}
		const events = (async function* () {
			yield { type: "message_end", message: { role: "assistant", content: text, usage: { input: 1, output: 1 } } };
		})();
		return {
			pid: 300 + spawns.length,
			promise: Promise.resolve({ exitCode: 0, signal: null }),
			events,
			abort: () => {},
			heartbeatAt: { current: Date.now() },
		};
	};
	return { spawn, spawns };
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

	it("parses gate verdicts and judge winners from the last matching line", () => {
		strictEqual(parseReviewVerdict("findings...\nVERDICT: revise\nmore\nVERDICT: pass"), "pass");
		strictEqual(parseReviewVerdict("no verdict here"), null);
		strictEqual(parseJudgeWinner("reasons\nWINNER: 2", 3), 2);
		strictEqual(parseJudgeWinner("WINNER: 9", 3), null);
	});
});

describe("reviewer-gated dispatch", () => {
	beforeEach(() => {
		isolateDispatchState();
	});
	after(() => {
		restoreDispatchState();
	});

	it("passes on the first cycle with chained receipts and a read-only reviewer", async () => {
		const fabric = scriptedFabric({ reviewerAnswers: ["looks correct\nVERDICT: pass"] });
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: fabric.spawn });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract });
			const result = (await tool.run({ tasks: ["fix the build"], review: true }, {})) as ToolRunResult;
			strictEqual(result.kind, "ok");
			ok(result.kind === "ok");
			match(result.output, /review gate passed after 1 cycle/);
			const gate = result.details?.gate as { verdict: string; cycles: number };
			strictEqual(gate.verdict, "pass");

			const byRole = receiptsByRole(result.details, bundle.contract);
			const builder = byRole.get("builder")?.[0];
			const reviewer = byRole.get("reviewer")?.[0];
			ok(builder && reviewer, "builder and reviewer receipts sealed");
			strictEqual(builder?.gate?.group, reviewer?.gate?.group);
			deepStrictEqual(reviewer?.gate?.subjects, [{ runId: builder?.runId, digest: builder?.integrity.digest }]);
			// The reviewer ran read-only regardless of the session level.
			const reviewerSpawn = fabric.spawns.find((entry) => entry.spec.task.startsWith("Review the work"));
			strictEqual(reviewerSpawn?.spec.autonomy, "read-only");
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

	it("threads revise findings into the builder rerun and records the verdict on its receipt", async () => {
		const fabric = scriptedFabric({
			reviewerAnswers: ["missing tests\nVERDICT: revise", "VERDICT: pass"],
		});
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: fabric.spawn });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract });
			const result = (await tool.run({ tasks: ["fix the build"], review: { max_cycles: 2 } }, {})) as ToolRunResult;
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
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("surfaces exhaustion as a needs-decision error, never a silent failure", async () => {
		const fabric = scriptedFabric({ reviewerAnswers: ["still wrong\nVERDICT: revise"] });
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: fabric.spawn });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract });
			const result = (await tool.run({ tasks: ["fix the build"], review: { max_cycles: 1 } }, {})) as ToolRunResult;
			strictEqual(result.kind, "error");
			ok(result.kind === "error");
			match(result.message, /review gate needs an operator decision/);
			match(result.message, /exhausted after 1 cycle/);
			const gate = result.details?.gate as { verdict: string | null; needsDecision?: string };
			strictEqual(gate.verdict, null);
			ok(gate.needsDecision);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("reports a fail verdict as gate failure", async () => {
		const fabric = scriptedFabric({ reviewerAnswers: ["wrong approach\nVERDICT: fail"] });
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: fabric.spawn });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract });
			const result = (await tool.run({ tasks: ["fix the build"], review: true }, {})) as ToolRunResult;
			strictEqual(result.kind, "error");
			ok(result.kind === "error");
			match(result.message, /review gate failed/);
		} finally {
			await bundle.extension.stop?.();
		}
	});

	it("seals plan provenance onto every run of a plan-scale dispatch", async () => {
		const fabric = scriptedFabric({});
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: fabric.spawn });
		await bundle.extension.start();
		try {
			const args = { tasks: ["one", "two"] };
			const tool = createDispatchTool({ dispatch: bundle.contract, getAutonomy: () => "full-auto" });
			const result = (await tool.run(args, {})) as ToolRunResult;
			strictEqual(result.kind, "ok");
			const expected = describeDispatchPlan(args);
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
});

describe("compete dispatch", () => {
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

	it("full-auto applies the judge's pick and cleans every worktree and branch", async () => {
		const fabric = scriptedFabric({ builderWritesFile: "answer.txt", judgeAnswers: ["reasons\nWINNER: 2"] });
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: fabric.spawn });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract, getAutonomy: () => "full-auto" });
			const result = (await tool.run(
				{ tasks: [{ task: "improve the readme", cwd: repo }], mode: "compete", candidates: 2 },
				{},
			)) as ToolRunResult;
			strictEqual(result.kind, "ok");
			ok(result.kind === "ok");
			match(result.output, /compete winner candidate 2 applied/);
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
		} finally {
			await bundle.extension.stop?.();
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("supervised keeps the winner for confirmation; apply_winner merges and cleans up", async () => {
		const fabric = scriptedFabric({ builderWritesFile: "answer.txt", judgeAnswers: ["WINNER: 1"] });
		const bundle = makeDispatchBundle(dispatchStubContext(), { spawnWorker: fabric.spawn });
		await bundle.extension.start();
		try {
			const tool = createDispatchTool({ dispatch: bundle.contract, getAutonomy: () => "auto-edit" });
			const result = (await tool.run(
				{ tasks: [{ task: "improve the readme", cwd: repo }], mode: "compete", candidates: 2 },
				{},
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
			const applied = (await tool.run(
				{ apply_winner: { branch: compete.winner.branch, cwd: repo } },
				{},
			)) as ToolRunResult;
			strictEqual(applied.kind, "ok");
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

	it("cleans all candidates when the judge picks nothing and reports needs-decision", async () => {
		const fabric = scriptedFabric({ builderWritesFile: "answer.txt", judgeAnswers: ["I cannot decide"] });
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
