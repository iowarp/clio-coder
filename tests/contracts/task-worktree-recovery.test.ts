import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { taskWorktreeFindings } from "../../src/cli/doctor-task-worktrees.js";
import {
	applyTaskWorktree,
	createTaskWorktree,
	listPreservedTaskWorktrees,
	recoverTaskWorktrees,
	settleTaskWorktree,
	type TaskWorktree,
} from "../../src/tools/task-worktree.js";

/**
 * Restart recovery for `worktree: true` dispatch. A crash is simulated by
 * rewriting the claim's owner lease: a PID that has exited, or this process's
 * PID under a birth token it never had (the PID was reused).
 */
describe("task worktree restart recovery", () => {
	let root: string;

	function git(cwd: string, ...args: string[]): string {
		return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
	}

	function markerPath(task: TaskWorktree): string {
		return `${task.path}.task-owner.json`;
	}

	function readMarker(task: TaskWorktree): Record<string, unknown> {
		return JSON.parse(readFileSync(markerPath(task), "utf8")) as Record<string, unknown>;
	}

	function exitedPid(): number {
		const child = spawnSync(process.execPath, ["-e", ""]);
		strictEqual(child.status, 0);
		return child.pid;
	}

	function crash(task: TaskWorktree, owner?: { pid: number; birthToken: string | null }): void {
		const marker = readMarker(task);
		const lease = marker.owner as { host: string };
		const dead = owner ?? { pid: exitedPid(), birthToken: "linux:1" };
		writeFileSync(markerPath(task), `${JSON.stringify({ ...marker, owner: { host: lease.host, ...dead } }, null, 2)}\n`);
	}

	function branches(): string[] {
		return git(root, "branch", "--list", "clio-coder/task/*", "--format=%(refname:short)").split("\n").filter(Boolean);
	}

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-task-recovery-")));
		git(root, "init", "-q", "-b", "main");
		git(root, "config", "user.email", "t@local");
		git(root, "config", "user.name", "t");
		writeFileSync(join(root, ".gitignore"), ".clio-coder/\n");
		writeFileSync(join(root, "a.txt"), "a\n");
		git(root, "add", ".");
		git(root, "commit", "-q", "-m", "init");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("records the owner lease, the apply mode, and an active state on the claim", () => {
		const task = createTaskWorktree(root, "run-claim", undefined, "preserve");
		const marker = readMarker(task);
		strictEqual(marker.version, 2);
		strictEqual(marker.state, "active");
		strictEqual(marker.apply, "preserve");
		strictEqual((marker.owner as { pid: number }).pid, process.pid);
		ok(!Number.isNaN(Date.parse(marker.createdAt as string)));
	});

	it("removes a dead owner's worktree, branch, and claim when it holds no work", () => {
		const task = createTaskWorktree(root, "run-clean");
		crash(task);
		const result = recoverTaskWorktrees(root);
		deepStrictEqual(result, { removed: ["run-clean"], preserved: [], failed: [] });
		strictEqual(existsSync(task.path), false);
		strictEqual(existsSync(markerPath(task)), false);
		deepStrictEqual(branches(), []);
		strictEqual(git(root, "worktree", "list", "--porcelain").includes("run-clean"), false);
	});

	it("preserves a dead owner's uncommitted files, names them once, and never merges", () => {
		const task = createTaskWorktree(root, "run-dirty");
		writeFileSync(join(task.path, "new.txt"), "work\n");
		crash(task);
		const result = recoverTaskWorktrees(root);
		deepStrictEqual(result.removed, []);
		strictEqual(result.preserved.length, 1);
		strictEqual(result.preserved[0]?.state, "abandoned");
		match(result.preserved[0]?.reason ?? "", /1 uncommitted path/u);
		strictEqual(readFileSync(join(task.path, "new.txt"), "utf8"), "work\n");
		strictEqual(existsSync(join(root, "new.txt")), false);
		deepStrictEqual(branches(), ["clio-coder/task/run-dirty"]);
		// The second start finds it already reported and stays quiet.
		deepStrictEqual(recoverTaskWorktrees(root), { removed: [], preserved: [], failed: [] });
		strictEqual(existsSync(task.path), true);
	});

	it("preserves a dead owner's commits", () => {
		const task = createTaskWorktree(root, "run-committed");
		writeFileSync(join(task.path, "a.txt"), "changed\n");
		git(task.path, "-c", "user.name=w", "-c", "user.email=w@local", "commit", "-qam", "work");
		crash(task);
		const result = recoverTaskWorktrees(root);
		match(result.preserved[0]?.reason ?? "", /1 commit\(s\) beyond its base/u);
		strictEqual(readFileSync(join(root, "a.txt"), "utf8"), "a\n");
		deepStrictEqual(branches(), ["clio-coder/task/run-committed"]);
	});

	it("never touches a live owner", () => {
		const task = createTaskWorktree(root, "run-live");
		deepStrictEqual(recoverTaskWorktrees(root), { removed: [], preserved: [], failed: [] });
		strictEqual(existsSync(task.path), true);
		strictEqual(readMarker(task).state, "active");
		deepStrictEqual(listPreservedTaskWorktrees(root), []);
	});

	it("reads a live PID under another birth token as a reused PID, so the owner is gone", () => {
		const task = createTaskWorktree(root, "run-reused");
		crash(task, { pid: process.pid, birthToken: "linux:1" });
		deepStrictEqual(recoverTaskWorktrees(root).removed, ["run-reused"]);
	});

	it("fails closed: an owner on another host, a claim without a lease, and a foreign claim all stay", () => {
		const remote = createTaskWorktree(root, "run-remote");
		const remoteMarker = readMarker(remote);
		writeFileSync(
			markerPath(remote),
			JSON.stringify({ ...remoteMarker, owner: { host: "elsewhere.invalid", pid: exitedPid(), birthToken: "linux:1" } }),
		);
		const legacy = createTaskWorktree(root, "run-legacy");
		const { owner: _owner, state: _state, ...v1 } = readMarker(legacy);
		writeFileSync(markerPath(legacy), JSON.stringify({ ...v1, version: 1 }));
		const foreign = createTaskWorktree(root, "run-foreign");
		crash(foreign);
		writeFileSync(markerPath(foreign), JSON.stringify({ ...readMarker(foreign), root: "/somewhere/else" }));

		deepStrictEqual(recoverTaskWorktrees(root), { removed: [], preserved: [], failed: [] });
		for (const task of [remote, legacy, foreign]) strictEqual(existsSync(task.path), true, task.runId);
		deepStrictEqual(
			listPreservedTaskWorktrees(root).map((entry) => entry.runId),
			["run-legacy"],
		);
	});

	it("leaves a settled worktree alone after its owner exits, and doctor lists it with the commands to drop it", () => {
		const task = createTaskWorktree(root, "run-settled", undefined, "preserve");
		writeFileSync(join(task.path, "kept.txt"), "kept\n");
		strictEqual(applyTaskWorktree({ worktree: task, apply: "preserve" }).applied, false);
		settleTaskWorktree(task);
		crash(task);
		strictEqual(readMarker(task).state, "settled");
		deepStrictEqual(recoverTaskWorktrees(root), { removed: [], preserved: [], failed: [] });

		const abandoned = createTaskWorktree(root, "run-abandoned");
		writeFileSync(join(abandoned.path, "x.txt"), "x\n");
		crash(abandoned);
		recoverTaskWorktrees(root);

		mkdirSync(join(root, "sub"));
		const findings = taskWorktreeFindings(
			join(root, "sub"),
			Date.parse(readMarker(task).createdAt as string) + 3 * 3_600_000,
		);
		deepStrictEqual(
			findings.map((finding) => [finding.name, finding.level, finding.ok]),
			[
				["task worktree run-abandoned", "warn", true],
				["task worktree run-settled", "info", true],
			],
		);
		const settled = findings[1]?.detail ?? "";
		match(settled, /clio-coder\/task\/run-settled \(settled, 3h old, kept by its run\)/u);
		match(settled, /git log [0-9a-f]{40}\.\.clio-coder\/task\/run-settled/u);
		match(settled, /git worktree remove --force .*run-settled && git branch -D clio-coder\/task\/run-settled/u);
	});

	it("reports none preserved in a clean checkout and nothing outside a git checkout", () => {
		deepStrictEqual(taskWorktreeFindings(root), [{ ok: true, name: "task worktrees", detail: "none preserved" }]);
		const plain = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-task-recovery-plain-")));
		try {
			deepStrictEqual(taskWorktreeFindings(plain), []);
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});
});
