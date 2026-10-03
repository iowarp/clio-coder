import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { discoverAgentRecipes } from "../../src/domains/agents/registry.js";
import { createWorkerSafety, createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
import { createWorkerGitContext } from "../../src/tools/git-exec.js";
import { applyToolProfile } from "../../src/tools/profiles.js";
import type { ToolRegistry, ToolResult } from "../../src/tools/registry.js";
import { createTaskWorktree } from "../../src/tools/task-worktree.js";
import { type IsolatedClioEnv, isolateClioEnv } from "../harness/scratch-env.js";

/**
 * git through a worker registry over a real repository with two commits, one
 * unstaged edit, one staged edit, and one untracked file. Each op is held to
 * the argv it ran and to what that argv reports; the exec spine underneath
 * (streaming, caps, timeouts) is pinned by safe-exec-streaming.test.ts.
 */

function git(cwd: string, ...args: string[]): string {
	return execFileSync(
		"git",
		["-c", "user.email=clio@example.invalid", "-c", "user.name=clio", "-c", "commit.gpgsign=false", ...args],
		{ cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
	).trim();
}

it("offers read-only git inspection to researcher, including the council profile", () => {
	const researcher = discoverAgentRecipes(process.cwd()).find(
		(recipe) => recipe.id === "researcher" && recipe.source === "builtin",
	);
	ok(researcher?.toolRequirements.optional.includes(ToolNames.Git));
	deepStrictEqual(applyToolProfile([ToolNames.Git], "council-read-only"), [ToolNames.Git]);
});

describe("git tool", () => {
	let scratch: IsolatedClioEnv;
	let registry: ToolRegistry;
	let repo: string;
	let previousCwd: string;
	beforeEach(async () => {
		scratch = await isolateClioEnv("clio-coder-git-tool-");
		// An operator's color.ui or log.decorate would change what git prints; restore() drops both.
		process.env.GIT_CONFIG_GLOBAL = "/dev/null";
		process.env.GIT_CONFIG_NOSYSTEM = "1";
		repo = join(scratch.dir, "repo");
		mkdirSync(join(repo, "docs"), { recursive: true });
		git(repo, "init", "-q", "-b", "main");
		writeFileSync(join(repo, "a.txt"), "one\n");
		writeFileSync(join(repo, "docs", "b.md"), "x\n");
		git(repo, "add", ".");
		git(repo, "commit", "-qm", "first");
		appendFileSync(join(repo, "docs", "b.md"), "y\n");
		git(repo, "commit", "-qam", "second touches docs");
		appendFileSync(join(repo, "a.txt"), "unstaged\n");
		appendFileSync(join(repo, "docs", "b.md"), "staged\n");
		git(repo, "add", "docs/b.md");
		writeFileSync(join(repo, "new.txt"), "untracked\n");
		previousCwd = process.cwd();
		process.chdir(repo);
		registry = createWorkerToolRegistry(undefined, createWorkerSafety({ cwd: repo }));
	});
	afterEach(() => {
		process.chdir(previousCwd);
		scratch.restore();
	});

	async function call(args: Record<string, unknown>): Promise<Extract<ToolResult, { kind: "ok" }>> {
		const verdict = await registry.invoke({ tool: ToolNames.Git, args });
		if (verdict.kind !== "ok" || verdict.result.kind !== "ok") {
			throw new Error(`git ${JSON.stringify(args)} did not succeed: ${JSON.stringify(verdict)}`);
		}
		return verdict.result;
	}

	async function refusal(args: Record<string, unknown>): Promise<string> {
		const verdict = await registry.invoke({ tool: ToolNames.Git, args });
		if (verdict.kind !== "ok" || verdict.result.kind !== "error") {
			throw new Error(`git ${JSON.stringify(args)} was not refused: ${JSON.stringify(verdict)}`);
		}
		return verdict.result.message;
	}

	it("reports short status with the branch, staged, unstaged, and untracked entries", async () => {
		const status = await call({ op: "status" });
		deepStrictEqual(status.output.trim().split("\n"), ["## main", " M a.txt", "M  docs/b.md", "?? new.txt"]);
		deepStrictEqual(status.details?.argv, ["git", "status", "--short", "--branch"]);
		strictEqual(status.details?.exitCode, 0);
	});

	it("separates unstaged from staged diffs and honours stat, name-only, and path scoping", async () => {
		const unstaged = await call({ op: "diff" });
		match(unstaged.output, /^\+unstaged$/m);
		strictEqual(unstaged.output.includes("+staged"), false);
		const staged = await call({ op: "diff", cached: true });
		match(staged.output, /^\+staged$/m);
		strictEqual(staged.output.includes("+unstaged"), false);
		strictEqual((await call({ op: "diff", cached: true, name_only: true })).output.trim(), "docs/b.md");
		match((await call({ op: "diff", stat: true })).output, /a\.txt \| 1 \+\n 1 file changed, 1 insertion\(\+\)/);
		strictEqual((await call({ op: "diff", path: "docs" })).output, "");
		deepStrictEqual((await call({ op: "diff", cached: true, stat: true, path: "docs" })).details?.argv, [
			"git",
			"diff",
			"--no-ext-diff",
			"--no-textconv",
			"--cached",
			"--stat",
			"--",
			"docs",
		]);
	});

	it("logs one line per commit, clamps the limit, and scopes to a path", async () => {
		const subjects = (output: string) =>
			output
				.trim()
				.split("\n")
				.map((line) => line.replace(/^[0-9a-f]+ /, ""));
		deepStrictEqual(subjects((await call({ op: "log" })).output), ["second touches docs", "first"]);
		deepStrictEqual(subjects((await call({ op: "log", limit: 1 })).output), ["second touches docs"]);
		deepStrictEqual((await call({ op: "log", limit: 5000 })).details?.argv, [
			"git",
			"log",
			"--no-ext-diff",
			"--no-textconv",
			"--oneline",
			"-n",
			"200",
		]);
		deepStrictEqual((await call({ op: "log", limit: -3 })).details?.argv, [
			"git",
			"log",
			"--no-ext-diff",
			"--no-textconv",
			"--oneline",
			"-n",
			"20",
		]);
		deepStrictEqual(subjects((await call({ op: "log", path: "a.txt" })).output), ["first"]);
	});

	it("runs from a workspace subdirectory and refuses a cwd outside the workspace or an unknown op", async () => {
		deepStrictEqual((await call({ op: "status", cwd: "docs" })).details?.cwd, join(repo, "docs"));
		match(await refusal({ op: "status", cwd: scratch.dir }), /^git: cwd escapes workspace root: /);
		strictEqual(
			await refusal({ op: "push" }),
			'git: expected args.op to be status, diff, log, show, add, or commit; got "push". Example: gateway({op:"call",capability:"git",args:{"op":"log","rev":"main","limit":5,"stat":true}})',
		);
		strictEqual(
			await refusal({ command: "log -20" }),
			'git: expected args.op to be status, diff, log, show, add, or commit; got ""; unrecognized field "command". Example: gateway({op:"call",capability:"git",args:{"op":"log","rev":"main","limit":5,"stat":true}})',
		);
		match(await refusal({ op: "log", max_output_bytes: 8 }), /^git: output exceeded 8 bytes/);
	});

	it("inspects a named revision with show, log rev, and a diff range, and refuses an option-shaped revision", async () => {
		const show = await call({ op: "show", rev: "HEAD~1" });
		deepStrictEqual(show.details?.argv, [
			"git",
			"show",
			"--no-ext-diff",
			"--no-textconv",
			"--stat",
			"--patch",
			"--diff-merges=first-parent",
			"--end-of-options",
			"HEAD~1",
		]);
		match(show.output, /^ {4}first$/m);
		match(show.output, /^\+one$/m);
		strictEqual((await call({ op: "show", rev: "HEAD~1", stat: true })).output.includes("diff --git"), false);
		strictEqual((await call({ op: "log", rev: "HEAD~1" })).output.trim().replace(/^[0-9a-f]+ /, ""), "first");
		strictEqual((await call({ op: "diff", rev: "HEAD~1..HEAD", name_only: true })).output.trim(), "docs/b.md");
		match(
			await refusal({ op: "show", rev: "--output=leak.txt" }),
			/^git: rev "--output=leak\.txt" starts with -; nothing ran/,
		);
		match(await refusal({ op: "log", rev: "HEAD~1..-x" }), /starts with -; nothing ran/);
		match(await refusal({ op: "show", rev: "HEAD~1..HEAD" }), /is a range; show takes one revision/);
	});

	it("refuses a field the op does not take instead of running a different command", async () => {
		// DF-9: a nested args array was dropped and the default 20-commit log ran, green.
		match(
			await refusal({ op: "log", args: ["-1", "--format=fuller", "HEAD"] }),
			/^git: op log does not take field "args"; nothing ran\. log takes rev, limit, stat, path, .*use op show with rev\. Example: /,
		);
		match(await refusal({ op: "status", limit: 3 }), /^git: op status does not take field "limit"; nothing ran\./);
	});
});

it("admits typed add and commit only on the attested task branch, and asks the operator for in-tree hooks without execute", async () => {
	const scratch = await isolateClioEnv("clio-coder-git-task-");
	const previousCwd = process.cwd();
	try {
		// Git in the tool reads HOME's configuration, so it points at the scratch home.
		process.env.HOME = scratch.dir;
		process.env.GIT_CONFIG_NOSYSTEM = "1";
		const repo = join(scratch.dir, "repo");
		mkdirSync(repo);
		git(repo, "init", "-q", "-b", "main");
		writeFileSync(join(repo, "a.txt"), "one\n");
		git(repo, "add", ".");
		git(repo, "commit", "-qm", "base");
		const worktree = createTaskWorktree(repo, "run-typed");
		process.chdir(worktree.path);
		const parks: string[] = [];
		const registry = createWorkerToolRegistry(
			undefined,
			createWorkerSafety({ cwd: worktree.path }),
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			// workspace-edit, git: worktree, and no bash or run_script in the permit.
			createWorkerGitContext({
				allowance: "worktree",
				executePermitted: false,
				cwd: worktree.path,
				taskWorktree: worktree,
			}),
		);
		// Headless: nobody answers, so every ask is denied.
		registry.onPermissionRequired((_call, _decision, meta) => {
			parks.push(meta.approvalAuthority ?? "none");
			registry.cancelParkedCall(meta.requestId, "headless deny");
		});

		writeFileSync(join(worktree.path, "a.txt"), "two\n");
		const add = await registry.invoke({ tool: ToolNames.Git, args: { op: "add", paths: ["a.txt"] } });
		strictEqual(add.kind === "ok" && add.result.kind, "ok");
		const commit = await registry.invoke({ tool: ToolNames.Git, args: { op: "commit", message: "worker change" } });
		strictEqual(commit.kind === "ok" && commit.result.kind, "ok");
		strictEqual(git(repo, "log", "-1", "--format=%s", worktree.branch), "worker change");
		deepStrictEqual(parks, []);

		// The same commit with HEAD moved off the task branch asks main and commits nothing.
		git(worktree.path, "switch", "-q", "-c", "elsewhere");
		writeFileSync(join(worktree.path, "b.txt"), "b\n");
		git(worktree.path, "add", "b.txt");
		const moved = await registry.invoke({ tool: ToolNames.Git, args: { op: "commit", message: "worker change" } });
		strictEqual(moved.kind, "blocked");
		deepStrictEqual(parks, ["main"]);
		strictEqual(git(repo, "rev-parse", "elsewhere"), git(repo, "rev-parse", worktree.branch));

		// Back on the task branch, hooks the worker could author need the operator.
		git(worktree.path, "switch", "-q", worktree.branch);
		git(repo, "config", "core.hooksPath", ".husky");
		const hooked = await registry.invoke({ tool: ToolNames.Git, args: { op: "commit", message: "worker change" } });
		strictEqual(hooked.kind, "blocked");
		deepStrictEqual(parks, ["main", "operator"]);
		strictEqual(git(repo, "rev-list", "--count", worktree.branch), "2");
	} finally {
		process.chdir(previousCwd);
		scratch.restore();
	}
});
