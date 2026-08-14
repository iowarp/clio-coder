import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// Deliberately inside a workspace, which is the case the journal exclusion is
// about: an operator may put the Clio state directory in the repository.
const JOURNAL_ROOT = mkdtempSync(join(tmpdir(), "clio-writes-journal-"));
process.env.CLIO_CODER_STATE_DIR = join(JOURNAL_ROOT, ".state");

import {
	type FleetContract,
	normalizeWriteBoundary,
	normalizeWriteBoundaryEntry,
	parseFleetContract,
	writeBoundariesOverlap,
	writeBoundaryCovers,
} from "../../src/domains/agents/index.js";
import { compileExecutionPlan, type ExecutionPlanStepInput } from "../../src/domains/dispatch/execution-plan.js";
import {
	type ExecutionSchedulerAdapter,
	type ExecutionStepResult,
	type ExecutionWriteBoundaryOutcome,
	executePlan,
} from "../../src/domains/dispatch/execution-scheduler.js";
import { compileFleetExecutionPlan } from "../../src/domains/dispatch/fleet-plan.js";
import {
	captureWorkspaceSnapshot,
	diffWorkspace,
	enforceWriteBoundary,
	WRITE_BOUNDARY_VIOLATION_REASON,
} from "../../src/domains/dispatch/write-boundary.js";
import {
	createWriteBoundaryEnforcer,
	preflightWriteBoundaries,
} from "../../src/domains/dispatch/write-boundary-enforcer.js";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const roots: string[] = [];

after(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	rmSync(JOURNAL_ROOT, { recursive: true, force: true });
});

function git(root: string, args: string[]): string {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function write(root: string, path: string, contents: string): void {
	const full = join(root, path);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, contents, "utf8");
}

/** A committed repository with the given files at HEAD. */
function repo(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "clio-writes-"));
	roots.push(root);
	git(root, ["init", "-q", "-b", "main"]);
	git(root, ["config", "user.email", "fleet@clio.test"]);
	git(root, ["config", "user.name", "clio-coder fleet"]);
	git(root, ["config", "commit.gpgsign", "false"]);
	for (const [path, contents] of Object.entries(files)) write(root, path, contents);
	git(root, ["add", "-A"]);
	git(root, ["commit", "-q", "-m", "baseline"]);
	return root;
}

function agentStep(id: string, writes: string[] | undefined, dependencies: string[] = []): ExecutionPlanStepInput {
	return {
		kind: "agent",
		id,
		agentId: "coder",
		executionRole: "builder",
		scope: writes !== undefined && writes.length === 0 ? "readonly" : "workspace",
		expectedResultContract: "mutation-report",
		requestedAuthority: "workspace-edit",
		approvedAuthority: "workspace-edit",
		dependencies,
		task: "do the thing",
		...(writes === undefined ? {} : { writes }),
	};
}

// ---------------------------------------------------------------------------
// grammar
// ---------------------------------------------------------------------------

describe("contracts/write-boundary grammar", () => {
	it("normalizes entries and sorts them canonically", () => {
		deepStrictEqual(normalizeWriteBoundary(["docs//guide.md", "src/", "src/"]), ["docs/guide.md", "src/"]);
	});

	it("refuses paths that are not repository-relative or not literal", () => {
		throws(() => normalizeWriteBoundaryEntry("/etc/passwd"), /repository-relative/);
		throws(() => normalizeWriteBoundaryEntry("../outside"), /'\.\.'/);
		throws(() => normalizeWriteBoundaryEntry("src/**/*.ts"), /glob/);
		throws(() => normalizeWriteBoundaryEntry("src\\win"), /separators/);
		throws(() => normalizeWriteBoundaryEntry("  "), /non-empty/);
	});

	it("covers a subtree only when the entry declares one", () => {
		ok(writeBoundaryCovers(["docs/"], "docs/deep/guide.md"));
		ok(!writeBoundaryCovers(["docs"], "docs/guide.md"));
		ok(writeBoundaryCovers(["docs"], "docs"));
		// A shared name prefix is not containment.
		ok(!writeBoundaryCovers(["src/"], "srcfoo/a.ts"));
	});

	it("detects overlap between declarations", () => {
		ok(writeBoundariesOverlap(["src/"], ["src/domains/a.ts"]));
		ok(!writeBoundariesOverlap(["src/"], ["docs/"]));
		ok(!writeBoundariesOverlap([], ["docs/"]));
	});
});

// ---------------------------------------------------------------------------
// contract schema
// ---------------------------------------------------------------------------

function contract(version: number, steps: string[]): FleetContract {
	return parseFleetContract(
		[
			"---",
			`version: ${version}`,
			"name: bounded",
			"steps:",
			...steps,
			"maxWorkers: 2",
			"onFailure: stop",
			"---",
			"Do {{task}}.",
		].join("\n"),
		"fleet.md",
	);
}

describe("contracts/write-boundary contract schema", () => {
	it("carries a normalized allowlist on a v4 workspace step", () => {
		const parsed = contract(4, [
			"  - kind: agent",
			"    id: build",
			"    agent: coder",
			"    scope: workspace",
			"    dependencies: []",
			"    writes: [src/, docs//guide.md]",
		]);
		const first = parsed.steps[0];
		ok(first?.kind === "agent");
		deepStrictEqual(first.writes, ["docs/guide.md", "src/"]);
	});

	it("refuses a v4 workspace step that declares no boundary", () => {
		throws(
			() =>
				contract(4, [
					"  - kind: agent",
					"    id: build",
					"    agent: coder",
					"    scope: workspace",
					"    dependencies: []",
				]),
			/must declare a non-empty 'writes'/,
		);
	});

	it("refuses a readonly step that declares one, because readonly is the empty allowlist", () => {
		throws(
			() =>
				contract(4, [
					"  - kind: agent",
					"    id: review",
					"    agent: verifier",
					"    scope: readonly",
					"    dependencies: []",
					"    writes: [docs/]",
				]),
			/is 'readonly', which is the empty allowlist/,
		);
	});

	it("refuses a boundary declared under a version that would not enforce it", () => {
		throws(
			() =>
				contract(3, [
					"  - kind: agent",
					"    id: build",
					"    agent: coder",
					"    scope: workspace",
					"    dependencies: []",
					"    writes: [src/]",
				]),
			/'writes' requires contract version 4/,
		);
	});

	it("leaves v3 contracts unenforced and unchanged", () => {
		const parsed = contract(3, [
			"  - kind: agent",
			"    id: build",
			"    agent: coder",
			"    scope: workspace",
			"    dependencies: []",
		]);
		const only = parsed.steps[0];
		ok(only?.kind === "agent");
		strictEqual(only.writes, undefined);
	});

	it("declares a boundary for both halves of a loop", () => {
		const parsed = contract(4, [
			"  - kind: loop",
			"    id: suite",
			"    maxAttempts: 2",
			"    dependencies: []",
			"    check: {kind: code, command: test, scope: workspace, writes: [.cache/]}",
			"    repair: {kind: agent, agent: coder, scope: workspace, writes: [src/]}",
		]);
		const plan = compileFleetExecutionPlan({
			contract: parsed,
			task: "fix it",
			resolveAgent: () => ({
				requestedAuthority: "workspace-edit",
				approvedAuthority: "workspace-edit",
				expectedResultContract: "mutation-report",
				executionRole: "builder",
			}),
		});
		// Every unrolled attempt inherits the same declaration: the bound governs
		// how often work is retried, never what it may touch.
		deepStrictEqual(
			plan.steps.map((step) => [step.id, step.writes]),
			[
				["suite.check.1", [".cache/"]],
				["suite.repair.1", ["src/"]],
				["suite.check.2", [".cache/"]],
			],
		);
	});
});

// ---------------------------------------------------------------------------
// wave validation
// ---------------------------------------------------------------------------

describe("contracts/write-boundary wave validation", () => {
	it("refuses two writers in one wave, because one checkout cannot attribute a change", () => {
		throws(
			() =>
				compileExecutionPlan({
					topology: "fleet",
					rootTask: "t",
					maxWorkers: 2,
					onFailure: "stop",
					steps: [agentStep("docs", ["docs/"]), agentStep("code", ["src/"])],
				}),
			/concurrent writers cannot be attributed/,
		);
	});

	it("allows the same two writers once they are ordered", () => {
		const plan = compileExecutionPlan({
			topology: "fleet",
			rootTask: "t",
			maxWorkers: 2,
			onFailure: "stop",
			steps: [agentStep("docs", ["docs/"]), agentStep("code", ["src/"], ["docs"])],
		});
		deepStrictEqual(plan.waves, [["docs"], ["code"]]);
	});

	it("allows a readonly step beside the wave's one writer", () => {
		const plan = compileExecutionPlan({
			topology: "fleet",
			rootTask: "t",
			maxWorkers: 2,
			onFailure: "stop",
			steps: [agentStep("code", ["src/"]), agentStep("read", [])],
		});
		deepStrictEqual(plan.waves, [["code", "read"]]);
	});

	it("refuses a wave that mixes an enforced step with an unenforced one", () => {
		throws(
			() =>
				compileExecutionPlan({
					topology: "fleet",
					rootTask: "t",
					maxWorkers: 2,
					onFailure: "stop",
					steps: [agentStep("bounded", ["src/"]), agentStep("unbounded", undefined)],
				}),
			/declare no boundary/,
		);
	});
});

// ---------------------------------------------------------------------------
// enforcement against a real checkout
// ---------------------------------------------------------------------------

describe("contracts/write-boundary enforcement", () => {
	it("passes a step that only changed what it declared", () => {
		const root = repo({ "src/a.ts": "export const a = 1;\n", "docs/guide.md": "# guide\n" });
		const snapshot = captureWorkspaceSnapshot(root);
		write(root, "src/a.ts", "export const a = 2;\n");
		write(root, "src/b.ts", "export const b = 1;\n");
		const verdict = enforceWriteBoundary({ snapshot, window: "wave-0", stepIds: ["build"], allow: ["src/"] });
		strictEqual(verdict.status, "clean");
		strictEqual(verdict.reason, null);
		deepStrictEqual(verdict.changedPaths, ["src/a.ts", "src/b.ts"]);
		deepStrictEqual(verdict.violations, []);
	});

	it("rolls an unauthorized new file back and names the paths and the declaration", () => {
		const root = repo({ "src/a.ts": "a\n", "docs/guide.md": "# guide\n" });
		const snapshot = captureWorkspaceSnapshot(root);
		write(root, "docs/guide.md", "# rewritten\n");
		write(root, "src/sneaky.ts", "export const sneaky = 1;\n");
		const verdict = enforceWriteBoundary({ snapshot, window: "wave-0", stepIds: ["docs"], allow: ["docs/"] });

		strictEqual(verdict.status, "rolled-back");
		strictEqual(verdict.reason, WRITE_BOUNDARY_VIOLATION_REASON);
		deepStrictEqual(verdict.violations, ["src/sneaky.ts"]);
		deepStrictEqual(verdict.rolledBack, [
			{ path: "src/sneaky.ts", action: "removed", restoredFrom: "did not exist at baseline" },
		]);
		ok(!existsSync(join(root, "src/sneaky.ts")));
		// The authorized change survives.
		strictEqual(readFileSync(join(root, "docs/guide.md"), "utf8"), "# rewritten\n");
		match(verdict.detail ?? "", /step 'docs'/);
		match(verdict.detail ?? "", /src\/sneaky\.ts/);
		match(verdict.detail ?? "", /Declared writes: docs\//);
		match(verdict.detail ?? "", /widen the step's `writes:` declaration/);
	});

	it("restores an unauthorized edit of a tracked file from the baseline commit", () => {
		const root = repo({ "src/a.ts": "original\n", "docs/guide.md": "# guide\n" });
		const snapshot = captureWorkspaceSnapshot(root);
		write(root, "src/a.ts", "tampered\n");
		const verdict = enforceWriteBoundary({ snapshot, window: "wave-0", stepIds: ["docs"], allow: ["docs/"] });

		strictEqual(verdict.status, "rolled-back");
		strictEqual(readFileSync(join(root, "src/a.ts"), "utf8"), "original\n");
		strictEqual(verdict.rolledBack[0]?.action, "restored");
		strictEqual(verdict.rolledBack[0]?.restoredFrom, `${snapshot.head}:src/a.ts`);
	});

	it("restores an unauthorized deletion of a tracked file", () => {
		const root = repo({ "src/a.ts": "original\n" });
		const snapshot = captureWorkspaceSnapshot(root);
		unlinkSync(join(root, "src/a.ts"));
		const verdict = enforceWriteBoundary({ snapshot, window: "wave-0", stepIds: ["docs"], allow: ["docs/"] });

		strictEqual(verdict.status, "rolled-back");
		strictEqual(readFileSync(join(root, "src/a.ts"), "utf8"), "original\n");
	});

	it("refuses to guess when an untracked file it never recorded is deleted", () => {
		const root = repo({ "src/a.ts": "a\n" });
		write(root, "scratch.txt", "operator notes\n");
		const snapshot = captureWorkspaceSnapshot(root);
		unlinkSync(join(root, "scratch.txt"));
		const verdict = enforceWriteBoundary({ snapshot, window: "wave-0", stepIds: ["build"], allow: ["src/"] });

		strictEqual(verdict.status, "rollback-incomplete");
		strictEqual(verdict.reason, WRITE_BOUNDARY_VIOLATION_REASON);
		deepStrictEqual(verdict.violations, ["scratch.txt"]);
		deepStrictEqual(verdict.rolledBack, []);
		strictEqual(verdict.unrecoverable[0]?.path, "scratch.txt");
		// The tree is left exactly as the step made it, for the operator.
		ok(!existsSync(join(root, "scratch.txt")));
		match(verdict.detail ?? "", /Rollback is incomplete/);
	});

	it("fails a readonly step that changed the repository at all", () => {
		const root = repo({ "src/a.ts": "a\n" });
		const snapshot = captureWorkspaceSnapshot(root);
		write(root, "src/a.ts", "reviewer edited this\n");
		const verdict = enforceWriteBoundary({ snapshot, window: "wave-0", stepIds: ["review"], allow: [] });

		strictEqual(verdict.reason, WRITE_BOUNDARY_VIOLATION_REASON);
		strictEqual(verdict.status, "rolled-back");
		strictEqual(readFileSync(join(root, "src/a.ts"), "utf8"), "a\n");
		match(verdict.detail ?? "", /Declared writes: \(nothing: readonly\)/);
	});

	it("names every step of a window that ran more than one, rather than guessing", () => {
		const root = repo({ "src/a.ts": "a\n" });
		const snapshot = captureWorkspaceSnapshot(root);
		write(root, "elsewhere.txt", "x\n");
		const verdict = enforceWriteBoundary({
			snapshot,
			window: "wave-0",
			stepIds: ["writer", "reader"],
			allow: ["src/"],
		});
		match(verdict.detail ?? "", /'writer', 'reader' ran concurrently/);
	});

	it("reads a commit that moves HEAD without touching the tree as no change", () => {
		const root = repo({ "src/a.ts": "a\n" });
		write(root, "src/a.ts", "edited\n");
		const snapshot = captureWorkspaceSnapshot(root);
		git(root, ["add", "-A"]);
		git(root, ["commit", "-q", "-m", "clio(fleet): commit the work"]);
		deepStrictEqual(diffWorkspace(snapshot), []);
		strictEqual(enforceWriteBoundary({ snapshot, window: "commit", stepIds: ["c"], allow: [] }).status, "clean");
	});

	it("does not blame a step for the orchestrator's own journal inside the workspace", () => {
		git(JOURNAL_ROOT, ["init", "-q", "-b", "main"]);
		git(JOURNAL_ROOT, ["config", "user.email", "fleet@clio.test"]);
		git(JOURNAL_ROOT, ["config", "user.name", "clio-coder fleet"]);
		write(JOURNAL_ROOT, "src/a.ts", "a\n");
		git(JOURNAL_ROOT, ["add", "-A"]);
		git(JOURNAL_ROOT, ["commit", "-q", "-m", "baseline"]);
		const snapshot = captureWorkspaceSnapshot(JOURNAL_ROOT);
		// A receipt, a code-step log, and a boundary verdict are all written while
		// the step runs. They are the orchestrator's writing, not the step's.
		write(JOURNAL_ROOT, ".state/receipts/run-1.json", "{}\n");
		strictEqual(enforceWriteBoundary({ snapshot, window: "wave-0", stepIds: ["r"], allow: [] }).status, "clean");
	});

	it("catches a declared path that escapes the workspace through a symlink", () => {
		const root = repo({ "src/a.ts": "a\n" });
		const outside = mkdtempSync(join(tmpdir(), "clio-writes-outside-"));
		roots.push(outside);
		symlinkSync(outside, join(root, "escape"));
		const enforcer = createWriteBoundaryEnforcer({
			root,
			rootId: "fleet-symlink",
			boundaryFor: () => ["escape/"],
		});
		throws(() => enforcer.begin("wave-0", ["build"]), /outside the workspace/);
	});

	it("fails closed at preflight when the workspace is not a git repository", () => {
		const root = mkdtempSync(join(tmpdir(), "clio-writes-plain-"));
		roots.push(root);
		const plan = compileExecutionPlan({
			topology: "fleet",
			rootTask: "t",
			maxWorkers: 1,
			onFailure: "stop",
			steps: [agentStep("build", ["src/"])],
		});
		throws(() => preflightWriteBoundaries(plan, root), /is not a git repository/);
		// An unenforced plan is unaffected: nothing claims a boundary.
		const unbounded = compileExecutionPlan({
			topology: "fleet",
			rootTask: "t",
			maxWorkers: 1,
			onFailure: "stop",
			steps: [agentStep("build", undefined)],
		});
		preflightWriteBoundaries(unbounded, root);
	});

	it("records the verdict durably beside the run ledger", async () => {
		const root = repo({ "src/a.ts": "a\n" });
		const recorded: string[] = [];
		const enforcer = createWriteBoundaryEnforcer({
			root,
			rootId: "fleet-record",
			boundaryFor: () => ["src/"],
			onVerdict: (_verdict, path) => recorded.push(path),
		});
		enforcer.begin("wave-0", ["build"]);
		write(root, "outside.txt", "x\n");
		const outcome = await enforcer.verify("wave-0", ["build"]);

		strictEqual(outcome.violated, true);
		deepStrictEqual(outcome.failedStepIds, ["build"]);
		strictEqual(recorded.length, 1);
		const sealed = JSON.parse(readFileSync(recorded[0] ?? "", "utf8")) as {
			version: number;
			violations: string[];
			digest: string;
			baselineHead: string;
		};
		strictEqual(sealed.version, 1);
		deepStrictEqual(sealed.violations, ["outside.txt"]);
		strictEqual(sealed.digest.length, 64);
		strictEqual(sealed.baselineHead, git(root, ["rev-parse", "HEAD"]));
	});

	it("refuses to verify a window it never snapshotted", async () => {
		const root = repo({ "src/a.ts": "a\n" });
		const enforcer = createWriteBoundaryEnforcer({ root, rootId: "fleet-missing", boundaryFor: () => ["src/"] });
		await enforcer.verify("wave-9", ["build"]).then(
			() => ok(false, "expected a refusal"),
			(error: Error) => match(error.message, /verified without a snapshot/),
		);
	});
});

// ---------------------------------------------------------------------------
// scheduler integration
// ---------------------------------------------------------------------------

function result(id: string): ExecutionStepResult {
	return {
		stepId: id,
		assignmentId: `assignment-${id}`,
		terminalRunId: `run-${id}`,
		receiptDigest: "a".repeat(64),
		output: `${id}-output`,
		succeeded: true,
		integrityValid: true,
	};
}

function boundaryAdapter(violate: ReadonlyArray<string>): ExecutionSchedulerAdapter & { windows: string[] } {
	const windows: string[] = [];
	return {
		windows,
		preflight: (step) => ({ step, costUpperBoundUsd: 1, nodeId: "local" }),
		reserve: () => ({ ownerId: "owner" }),
		run: async (step) => ({ assignmentId: `assignment-${step.id}`, result: Promise.resolve(result(step.id)) }),
		beginWriteBoundary: (window) => {
			windows.push(`begin:${window}`);
		},
		verifyWriteBoundary: async (window, stepIds): Promise<ExecutionWriteBoundaryOutcome> => {
			windows.push(`verify:${window}`);
			const blamed = stepIds.filter((id) => violate.includes(id));
			return {
				window,
				violated: blamed.length > 0,
				failedStepIds: blamed,
				detail: blamed.length > 0 ? "wrote outside its declared boundary" : null,
			};
		},
		cancel: () => {},
		release: () => {},
		releaseUnconsumed: () => {},
	};
}

describe("contracts/write-boundary scheduling", () => {
	it("snapshots before the wave spawns and verifies before results cross edges", async () => {
		const plan = compileExecutionPlan({
			topology: "fleet",
			rootTask: "t",
			maxWorkers: 1,
			onFailure: "stop",
			steps: [agentStep("build", ["src/"]), agentStep("review", [], ["build"])],
		});
		const adapter = boundaryAdapter([]);
		const outcome = await executePlan(plan, adapter);

		deepStrictEqual(adapter.windows, ["begin:wave-0", "verify:wave-0", "begin:wave-1", "verify:wave-1"]);
		deepStrictEqual(
			outcome.writeBoundaries.map((entry) => [entry.window, entry.violated]),
			[
				["wave-0", false],
				["wave-1", false],
			],
		);
		strictEqual(outcome.results.get("review")?.succeeded, true);
	});

	it("fails the violating step and blocks everything downstream of it", async () => {
		const plan = compileExecutionPlan({
			topology: "fleet",
			rootTask: "t",
			maxWorkers: 1,
			onFailure: "continue",
			steps: [agentStep("build", ["src/"]), agentStep("review", [], ["build"])],
		});
		const outcome = await executePlan(plan, boundaryAdapter(["build"]));

		const build = outcome.results.get("build");
		strictEqual(build?.succeeded, false);
		strictEqual(build?.boundaryViolated, true);
		deepStrictEqual(outcome.skipped, ["review"]);
		strictEqual(outcome.writeBoundaries[0]?.violated, true);
	});

	it("refuses a plan that declares a boundary no scheduler can verify", async () => {
		const plan = compileExecutionPlan({
			topology: "fleet",
			rootTask: "t",
			maxWorkers: 1,
			onFailure: "stop",
			steps: [agentStep("build", ["src/"])],
		});
		const adapter = boundaryAdapter([]);
		const blind: ExecutionSchedulerAdapter = {
			preflight: adapter.preflight,
			reserve: adapter.reserve,
			run: adapter.run,
			cancel: adapter.cancel,
			release: adapter.release,
			releaseUnconsumed: adapter.releaseUnconsumed,
		};
		await executePlan(plan, blind).then(
			() => ok(false, "expected a refusal"),
			(error: Error) => match(error.message, /cannot verify them/),
		);
	});

	it("does not enforce a plan whose steps declare nothing", async () => {
		const plan = compileExecutionPlan({
			topology: "fleet",
			rootTask: "t",
			maxWorkers: 1,
			onFailure: "stop",
			steps: [agentStep("build", undefined)],
		});
		const adapter = boundaryAdapter([]);
		const outcome = await executePlan(plan, adapter);
		deepStrictEqual(adapter.windows, []);
		deepStrictEqual(outcome.writeBoundaries, []);
	});
});
