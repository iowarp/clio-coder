import { deepStrictEqual, match, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { createWorkerSafety, createWorkerToolRegistry } from "../../src/engine/worker-tools.js";
import type { ToolRegistry, ToolResult } from "../../src/tools/registry.js";
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
		deepStrictEqual((await call({ op: "log", limit: 5000 })).details?.argv, ["git", "log", "--oneline", "-n", "200"]);
		deepStrictEqual((await call({ op: "log", limit: -3 })).details?.argv, ["git", "log", "--oneline", "-n", "20"]);
		deepStrictEqual(subjects((await call({ op: "log", path: "a.txt" })).output), ["first"]);
	});

	it("runs from a workspace subdirectory and refuses a cwd outside the workspace or an unknown op", async () => {
		deepStrictEqual((await call({ op: "status", cwd: "docs" })).details?.cwd, join(repo, "docs"));
		match(await refusal({ op: "status", cwd: scratch.dir }), /^git: cwd escapes workspace root: /);
		strictEqual(await refusal({ op: "push" }), "git: op must be status, diff, or log; got 'push'");
		match(await refusal({ op: "log", max_output_bytes: 8 }), /^git: output exceeded 8 bytes/);
	});
});
