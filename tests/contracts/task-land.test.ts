import { deepStrictEqual, match, strictEqual, throws } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resolveReviewSubject, taskBranchRefusal } from "../../src/cli/run-review.js";
import { executeTaskLand, heldLandCardPin, landHeldTaskBranch, planTaskLand } from "../../src/tools/task-land.js";
import {
	applyTaskWorktree,
	createTaskWorktree,
	previewTaskWorktree,
	settleTaskWorktree,
} from "../../src/tools/task-worktree.js";

describe("fleet land", () => {
	let root: string;

	function git(cwd: string, ...args: string[]): string {
		return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
	}

	/** A finished run that kept its worktree, as a withheld merge or apply mode preserve leaves it. */
	function keptTask(runId: string, file: string, text: string, commit = true) {
		const task = createTaskWorktree(root, runId, undefined, "preserve");
		writeFileSync(join(task.path, file), text);
		if (commit)
			applyTaskWorktree({
				worktree: task,
				apply: "preserve",
				commitMessage: `edit ${file}`,
				authoredPaths: [join(task.path, file)],
			});
		settleTaskWorktree(task);
		return task;
	}

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-task-land-")));
		git(root, "init", "-q", "-b", "main");
		git(root, "config", "user.email", "t@local");
		git(root, "config", "user.name", "t");
		writeFileSync(join(root, ".gitignore"), ".clio-coder/\n");
		writeFileSync(join(root, "a.txt"), "a\n");
		writeFileSync(join(root, "b.txt"), "b\n");
		git(root, "add", ".");
		git(root, "commit", "-q", "-m", "init");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("merges a kept branch onto a moved destination and releases it, carrying unrelated local edits", () => {
		const task = keptTask("t1", "a.txt", "task\n");
		writeFileSync(join(root, "b.txt"), "operator\n");
		git(root, "commit", "-q", "-am", "operator commit");
		writeFileSync(join(root, "b.txt"), "uncommitted\n");
		const plan = planTaskLand({ root, ref: "clio-coder/task/t1", mode: "merge" });
		strictEqual(plan.refusal, null);
		strictEqual(plan.fastForward, false);
		const result = executeTaskLand(plan);
		strictEqual(git(root, "rev-parse", "HEAD"), result.landed);
		strictEqual(git(root, "show", "HEAD:a.txt"), "task");
		strictEqual(git(root, "rev-list", "--parents", "-1", "HEAD").split(" ").length, 3);
		strictEqual(git(root, "status", "--porcelain"), "M b.txt");
		strictEqual(existsSync(task.path), false);
		deepStrictEqual(git(root, "branch", "--list", "clio-coder/task/*"), "");
	});

	it("lands a held branch for the operator's Land card only on what the card showed", () => {
		const task = keptTask("t9", "a.txt", "task\n");
		const cardFor = (tip: string) => {
			const preview = previewTaskWorktree(task, tip);
			settleTaskWorktree(task, preview);
			const shown = heldLandCardPin(root, tip);
			if (shown === null) throw new Error("no pin");
			return { worktree: task, preview, shown, protectedPaths: [] };
		};
		const first = cardFor(git(root, "rev-parse", task.branch));
		writeFileSync(join(task.path, "a.txt"), "after the card\n");
		git(task.path, "commit", "-q", "-am", "moved after the card");
		throws(() => landHeldTaskBranch(first), /is now at/u);
		const tip = git(root, "rev-parse", task.branch);
		writeFileSync(join(task.path, "notes.txt"), "previewed\n");
		const card = cardFor(tip);
		git(root, "checkout", "-q", "-b", "twin");
		throws(() => landHeldTaskBranch(card), /on twin, not main/u);
		git(root, "checkout", "-q", "main");
		throws(
			() => landHeldTaskBranch({ ...card, protectedPaths: [join(root, "a.txt")] }),
			/changes protected path a\.txt/u,
		);
		rmSync(join(task.path, "notes.txt"));
		throws(() => landHeldTaskBranch(card), /since the card showed it/u);
		strictEqual(git(root, "show", "HEAD:a.txt"), "a");
		writeFileSync(join(task.path, "notes.txt"), "kept out\n");
		const landed = landHeldTaskBranch(cardFor(tip));
		deepStrictEqual(landed, { landed: git(root, "rev-parse", "HEAD"), destination: "main" });
		strictEqual(git(root, "show", "HEAD:a.txt"), "after the card");
		strictEqual(git(root, "ls-tree", "--name-only", "HEAD", "notes.txt"), "");
	});

	it("refuses a conflicting branch before changing the checkout", () => {
		keptTask("t2", "a.txt", "task\n");
		writeFileSync(join(root, "a.txt"), "operator\n");
		git(root, "commit", "-q", "-am", "operator rewrites a");
		const head = git(root, "rev-parse", "HEAD");
		const plan = planTaskLand({ root, ref: "t2", mode: "merge" });
		match(plan.refusal ?? "", /conflicts with main in a\.txt/u);
		throws(() => executeTaskLand(plan), /conflicts/u);
		strictEqual(git(root, "rev-parse", "HEAD"), head);
		strictEqual(git(root, "status", "--porcelain"), "");
	});

	it("squashes uncommitted work a kept worktree still holds, only when landing", () => {
		const task = keptTask("t3", "c.txt", "crashed run\n", false);
		const plan = planTaskLand({ root, ref: "t3", mode: "squash" });
		strictEqual(plan.uncommitted, 1);
		strictEqual(git(task.path, "status", "--porcelain"), "?? c.txt");
		executeTaskLand(plan, { message: "land the crashed run" });
		strictEqual(git(root, "log", "-1", "--format=%s"), "land the crashed run");
		strictEqual(git(root, "rev-list", "--count", "HEAD"), "2");
		strictEqual(git(root, "show", "HEAD:c.txt"), "crashed run");
	});

	it("lands a same-size edit made in the second the worktree's index was written", () => {
		// Fixed stamps make the entry racily clean: its mtime equals the index's, and ctime is not compared.
		git(root, "config", "core.trustctime", "false");
		const task = keptTask("t6", "a.txt", "a\n", false);
		const file = join(task.path, "a.txt");
		const stamp = 1_700_000_000;
		utimesSync(file, stamp, stamp);
		git(task.path, "update-index", "--refresh");
		utimesSync(git(task.path, "rev-parse", "--path-format=absolute", "--git-path", "index"), stamp, stamp);
		writeFileSync(file, "z\n");
		utimesSync(file, stamp, stamp);
		const plan = planTaskLand({ root, ref: "t6", mode: "squash" });
		strictEqual(plan.uncommitted, 1);
		strictEqual(plan.changed, "1 file changed, 1 insertion(+), 1 deletion(-)");
		executeTaskLand(plan, { message: "land the racy edit" });
		strictEqual(git(root, "show", "HEAD:a.txt"), "z");
	});

	it("resolves a kept task branch for run --review in its worktree and refuses a branch the reviewer cannot see", () => {
		const base = git(root, "rev-parse", "HEAD");
		const task = keptTask("t4", "a.txt", "task\n");
		const subject = resolveReviewSubject({ root, ref: "clio-coder/task/t4", agentId: "reviewer" });
		if ("refusal" in subject) throw new Error(subject.refusal);
		strictEqual(subject.worktree, task.path);
		match(subject.task, /task branch clio-coder\/task\/t4 of run t4/u);
		match(subject.task, new RegExp(`Base: ${base}`, "u"));
		match(subject.task, /Destination: main/u);
		match(subject.task, /edit a\.txt/u);
		git(root, "branch", "clio-coder/task/t5");
		const gone = resolveReviewSubject({ root, ref: "t5", agentId: "reviewer" });
		match("refusal" in gone ? gone.refusal : "", /no kept worktree.*git worktree add/u);
		match(taskBranchRefusal("review clio-coder/task/t4 against main", root, "reviewer") ?? "", /--review t4 /u);
		strictEqual(taskBranchRefusal("review clio-coder/task/t4.", task.path, "reviewer"), null);
	});
});
