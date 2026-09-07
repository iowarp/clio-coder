import { match, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	claimCompeteGroup,
	cleanupCompeteGroup,
	commitCandidateWork,
	createCandidateWorktreeMapped,
	markCompeteGroupCleanupReady,
	mergeWinnerBranch,
} from "../../src/tools/compete-worktrees.js";
import { createDispatchAdmissionController } from "../../src/tools/dispatch-admission.js";
import { DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT } from "../../src/tools/dispatch-plan.js";
import type { DispatchToolDeps } from "../../src/tools/dispatch-types.js";

function git(root: string, ...args: string[]) {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function repo() {
	const root = mkdtempSync(join(tmpdir(), "clio-dispatch-retain-"));
	git(root, "init", "-q");
	git(root, "config", "user.name", "Contract");
	git(root, "config", "user.email", "contract@example.invalid");
	writeFileSync(join(root, "base.txt"), "base");
	git(root, "add", ".");
	git(root, "commit", "-qm", "base");
	return root;
}
test("automatic checkpoints do not execute configured Git content filters", async () => {
	const root = repo();
	try {
		const { captureWorkspaceCheckpoint, workspaceCheckpointRef } = await import(
			"../../src/domains/dispatch/workspace-checkpoint.js"
		);
		writeFileSync(join(root, ".gitattributes"), "*.txt filter=checkpoint-test\n");
		git(root, "config", "filter.checkpoint-test.clean", "touch filter-ran; cat");
		git(root, "config", "filter.checkpoint-test.required", "true");
		writeFileSync(join(root, "base.txt"), "recover exact work");
		const ref = captureWorkspaceCheckpoint(root, workspaceCheckpointRef("loop", "filter-contract"), "filter contract");
		strictEqual(existsSync(join(root, "filter-ran")), false);
		strictEqual(git(root, "show", `${ref}:base.txt`), "recover exact work");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
test("parallel admission refuses overlapping/unknown writers and allows enforced disjoint roots", () => {
	const root = repo(),
		previous = process.cwd();
	process.chdir(root);
	const admission = createDispatchAdmissionController({
		dispatch: {},
		getAgentSpecs: () => [
			{ id: "coder", capabilityClass: "workspace-edit" },
			{ id: "scout", capabilityClass: "read-only" },
		],
	} as unknown as DispatchToolDeps);
	const prepare = (tasks: unknown[], extra = {}) =>
		admission.prepareAdmissionArguments({ mode: "parallel", tasks, ...extra })[DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT];
	const writer = (roots?: string[]) => ({
		agent: "coder",
		task: "Implement scoped change",
		...(roots ? { intent: { write_roots: roots } } : {}),
	});
	try {
		match(String(prepare([writer(), writer()])), /parallel_writer_conflict/);
		match(String(prepare([writer(["src/"]), writer(["src/nested/"])])), /parallel_writer_conflict/);
		strictEqual(prepare([writer(["src/"]), writer(["docs/"])]), undefined);
		strictEqual(prepare([writer(), { agent: "scout", task: "Inspect sources" }]), undefined);
		strictEqual(prepare([writer(), writer()], { writers: 1 }), undefined);
		strictEqual(
			prepare([
				{ ...writer(), worktree: true },
				{ ...writer(), worktree: true },
			]),
			undefined,
		);
		mkdirSync(join(root, "src"));
		symlinkSync("src", join(root, "alias"));
		match(String(prepare([writer(["src/"]), writer(["alias/new/"])])), /parallel_writer_conflict/);
	} finally {
		process.chdir(previous);
		rmSync(root, { recursive: true, force: true });
	}
});
test("compete cleanup preserves a recoverable dirty loser without moving the operator index or HEAD", async () => {
	const root = repo();
	try {
		const ownership = claimCompeteGroup(root, "retain-contract");
		const winner = await createCandidateWorktreeMapped(ownership, 1, git(root, "rev-parse", "HEAD"));
		writeFileSync(join(winner.path, "winner.txt"), "winning work");
		commitCandidateWork(winner, "winner");
		const candidate = await createCandidateWorktreeMapped(ownership, 2, git(root, "rev-parse", "HEAD"));
		strictEqual(mergeWinnerBranch(root, winner.branch).ok, true);
		writeFileSync(join(candidate.path, "base.txt"), "candidate work");
		writeFileSync(join(candidate.path, "new.txt"), "new evidence");
		const head = git(root, "rev-parse", "HEAD"),
			index = readFileSync(join(root, ".git", "index"));
		cleanupCompeteGroup(markCompeteGroupCleanupReady(ownership));
		const refs = git(root, "for-each-ref", "--format=%(refname)", "refs/clio-coder/compete/");
		ok(refs.length > 0);
		const { workspaceCheckpointRef } = await import("../../src/domains/dispatch/workspace-checkpoint.js");
		const ref = workspaceCheckpointRef("compete", "retain-contract:2");
		ok(refs.includes(ref));
		strictEqual(git(root, "show", `${ref}:base.txt`), "candidate work");
		strictEqual(git(root, "show", `${ref}:new.txt`), "new evidence");
		strictEqual(git(root, "rev-parse", "HEAD"), head);
		strictEqual(readFileSync(join(root, ".git", "index")).equals(index), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a two-cycle fleet loop persists independently recoverable states before repair", async () => {
	const { compileExecutionPlan } = await import("../../src/domains/dispatch/execution-plan.js");
	const { executeFleetRun } = await import("../../src/domains/dispatch/fleet-run.js");
	const { workspaceCheckpointRef } = await import("../../src/domains/dispatch/workspace-checkpoint.js");
	const { isolateClioEnv } = await import("../harness/scratch-env.js");
	const env = await isolateClioEnv("clio-loop-ref-");
	const root = repo();
	try {
		const head = git(root, "rev-parse", "HEAD"),
			index = readFileSync(join(root, ".git", "index"));
		const plan = compileExecutionPlan({
			topology: "fleet",
			rootTask: "repair",
			maxWorkers: 1,
			onFailure: "stop",
			steps: [
				{
					kind: "code",
					id: "check1",
					commandId: "check",
					scope: "readonly",
					dependencies: [],
					verification: true,
					loop: { loopId: "review", role: "check", attempt: 1 },
				},
				{
					kind: "code",
					id: "repair1",
					commandId: "repair",
					scope: "workspace",
					dependencies: ["check1"],
					loop: { loopId: "review", role: "repair", attempt: 1 },
				},
				{
					kind: "code",
					id: "check2",
					commandId: "check",
					scope: "readonly",
					dependencies: ["repair1"],
					verification: true,
					loop: { loopId: "review", role: "check", attempt: 2 },
				},
			],
			loops: [
				{ id: "review", checkKind: "code", maxAttempts: 2, checkStepIds: ["check1", "check2"], repairStepIds: ["repair1"] },
			],
		});
		const command = (id: string, script: string) => ({
			id,
			argv: [process.execPath, "-e", script],
			cwd: "",
			timeoutMs: 10000,
			env: [],
			description: id,
		});
		const commands = {
			version: 1 as const,
			path: join(root, "commands.yaml"),
			commands: new Map([
				["check", command("check", "process.exit(require('node:fs').readFileSync('base.txt','utf8')==='fixed'?0:1)")],
				["repair", command("repair", "require('node:fs').writeFileSync('base.txt','fixed')")],
			]),
		};
		const outcome = await executeFleetRun({
			plan,
			contractName: "test",
			commands,
			workspaceRoot: root,
			fleetRootId: "two-cycle-contract",
			dispatch: {} as Parameters<typeof executeFleetRun>[0]["dispatch"],
			agents: {} as Parameters<typeof executeFleetRun>[0]["agents"],
			attributionEnabled: false,
		});
		strictEqual(outcome.cleanRun, true);
		const first = workspaceCheckpointRef("loop", "two-cycle-contract:review:1"),
			second = workspaceCheckpointRef("loop", "two-cycle-contract:review:2");
		strictEqual(git(root, "show", `${first}:base.txt`), "base");
		strictEqual(git(root, "show", `${second}:base.txt`), "fixed");
		strictEqual(git(root, "rev-parse", "HEAD"), head);
		strictEqual(readFileSync(join(root, ".git", "index")).equals(index), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
		await env.restore();
	}
});
