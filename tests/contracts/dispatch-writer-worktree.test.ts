import { deepStrictEqual, match, ok, rejects, strictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { processBirthToken } from "../../src/core/process-identity.js";
import { acquireCheckoutWriterLease } from "../../src/domains/dispatch/checkout-writer-lease.js";
import { compileExecutionPlan } from "../../src/domains/dispatch/execution-plan.js";
import { type ExecutionSchedulerAdapter, executePlan } from "../../src/domains/dispatch/execution-scheduler.js";
import { applyTaskWorktree, cleanupTaskWorktree, createTaskWorktree } from "../../src/tools/task-worktree.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function git(root: string, ...args: string[]): string {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function repository(): string {
	const root = mkdtempSync(join(tmpdir(), "clio-task-worktree-"));
	git(root, "init");
	git(root, "config", "user.name", "Contract Test");
	git(root, "config", "user.email", "contract@example.invalid");
	writeFileSync(join(root, "value.txt"), "base\n");
	git(root, "add", "value.txt");
	git(root, "commit", "-m", "base");
	return root;
}

describe("single writer dispatch", () => {
	it("serializes writers in plan order while readers overlap", async () => {
		const plan = compileExecutionPlan({
			topology: "parallel",
			rootTask: "writer token",
			maxWorkers: 4,
			writers: 1,
			onFailure: "continue",
			steps: [
				{
					id: "writer-a",
					agentId: "coder",
					executionRole: "builder",
					scope: "workspace",
					expectedResultContract: "mutation-report",
					requestedAuthority: "workspace-edit",
					approvedAuthority: "workspace-edit",
					dependencies: [],
					task: "a",
				},
				{
					id: "reader-a",
					agentId: "scout",
					executionRole: "researcher",
					scope: "readonly",
					expectedResultContract: "scout-report",
					requestedAuthority: "read-only",
					approvedAuthority: "read-only",
					dependencies: [],
					task: "read a",
				},
				{
					id: "writer-b",
					agentId: "coder",
					executionRole: "builder",
					scope: "workspace",
					expectedResultContract: "mutation-report",
					requestedAuthority: "workspace-edit",
					approvedAuthority: "workspace-edit",
					dependencies: [],
					task: "b",
				},
				{
					id: "reader-b",
					agentId: "scout",
					executionRole: "researcher",
					scope: "readonly",
					expectedResultContract: "scout-report",
					requestedAuthority: "read-only",
					approvedAuthority: "read-only",
					dependencies: [],
					task: "read b",
				},
			],
		});
		let activeWriters = 0;
		let activeReaders = 0;
		let maxWriters = 0;
		let maxReaders = 0;
		const writerStarts: string[] = [];
		const adapter: ExecutionSchedulerAdapter = {
			preflight: (step) => ({ step, costUpperBoundUsd: 0, nodeId: "local" }),
			reserve: () => ({ ownerId: "owner" }),
			async run(step) {
				const writer = step.scope === "workspace";
				if (writer) {
					activeWriters += 1;
					maxWriters = Math.max(maxWriters, activeWriters);
					writerStarts.push(step.id);
				} else {
					activeReaders += 1;
					maxReaders = Math.max(maxReaders, activeReaders);
				}
				return {
					assignmentId: step.id,
					result: new Promise((resolve) =>
						setTimeout(
							() => {
								if (writer) activeWriters -= 1;
								else activeReaders -= 1;
								resolve({
									stepId: step.id,
									assignmentId: step.id,
									terminalRunId: step.id,
									receiptDigest: "a".repeat(64),
									output: "ok",
									succeeded: true,
									integrityValid: true,
								});
							},
							writer ? 15 : 40,
						),
					),
				};
			},
			cancel() {},
			release() {},
			releaseUnconsumed() {},
		};
		await executePlan(plan, adapter);
		strictEqual(maxWriters, 1);
		strictEqual(maxReaders, 2);
		deepStrictEqual(writerStarts, ["writer-a", "writer-b"]);
	});

	it("refuses a live sibling lease and reclaims a dead owner", async () => {
		const isolated = await isolateClioEnv("clio-writer-lease-");
		const root = repository();
		try {
			const first = acquireCheckoutWriterLease({ checkout: root });
			const token = processBirthToken(process.pid);
			ok(token !== null);
			await rejects(
				async () =>
					acquireCheckoutWriterLease({
						checkout: root,
						pid: process.pid + 1000,
						processBirthToken: "other",
						probe: { birthToken: () => token },
					}),
				/checkout_writer_lease_held.*pid/,
			);
			first.release();
			acquireCheckoutWriterLease({
				checkout: root,
				pid: 999_999,
				processBirthToken: "dead",
				probe: { birthToken: () => null },
			});
			const reclaimed = acquireCheckoutWriterLease({ checkout: root, probe: { birthToken: () => null } });
			reclaimed.release();
		} finally {
			await isolated.restore();
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("task worktrees", () => {
	it("merges a successful task and returns its diff hash", () => {
		const root = repository();
		try {
			const task = createTaskWorktree(root, "merge-task");
			writeFileSync(join(task.path, "value.txt"), "merged\n");
			const receipt = applyTaskWorktree({ worktree: task, apply: "merge" });
			strictEqual(receipt.applied, true);
			strictEqual(receipt.branch, "clio/task/merge-task");
			match(receipt.diffHash, /^[0-9a-f]{64}$/u);
			strictEqual(readFileSync(join(root, "value.txt"), "utf8"), "merged\n");
			cleanupTaskWorktree(task, true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves without merging and leaves conflicts in place", () => {
		const root = repository();
		try {
			const preserved = createTaskWorktree(root, "preserve-task");
			writeFileSync(join(preserved.path, "value.txt"), "preserved\n");
			const preserveReceipt = applyTaskWorktree({ worktree: preserved, apply: "preserve" });
			strictEqual(preserveReceipt.applied, false);
			strictEqual(readFileSync(join(root, "value.txt"), "utf8"), "base\n");

			const conflict = createTaskWorktree(root, "conflict-task");
			writeFileSync(join(conflict.path, "value.txt"), "task\n");
			writeFileSync(join(root, "value.txt"), "parent\n");
			git(root, "add", "value.txt");
			git(root, "commit", "-m", "parent change");
			const conflictReceipt = applyTaskWorktree({ worktree: conflict, apply: "merge" });
			strictEqual(conflictReceipt.applied, false);
			strictEqual(conflictReceipt.reason, "worktree_merge_conflict");
			ok(git(root, "branch", "--list", conflict.branch).includes(conflict.branch));
			ok(readFileSync(join(conflict.path, "value.txt"), "utf8").includes("task"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
