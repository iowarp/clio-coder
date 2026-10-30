import { deepStrictEqual, match, strictEqual, throws } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { executeTaskLand, planTaskLand } from "../../src/tools/task-land.js";
import { applyTaskWorktree, createTaskWorktree, settleTaskWorktree } from "../../src/tools/task-worktree.js";

describe("fleet land", () => {
	let root: string;

	function git(cwd: string, ...args: string[]): string {
		return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
	}

	/** A finished run that kept its worktree, as a withheld merge or apply mode preserve leaves it. */
	function keptTask(runId: string, file: string, text: string, commit = true) {
		const task = createTaskWorktree(root, runId, undefined, "preserve");
		writeFileSync(join(task.path, file), text);
		if (commit) applyTaskWorktree({ worktree: task, apply: "preserve", commitMessage: `edit ${file}` });
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
});
