import { match, ok, strictEqual, throws } from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { processBirthToken } from "../../src/core/process-identity.js";
import { acquireCheckoutWriterLease } from "../../src/domains/dispatch/checkout-writer-lease.js";
import { workerNoWorkDetail } from "../../src/domains/dispatch/tool-stats.js";
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

test("a no-change report that names its block under a commit subject line settles as no work", () => {
	const input = {
		activity: { calls: 8, succeeded: 7, failed: 1, blocked: 0, mutatingSucceeded: true },
		limitationRecorded: false,
		mutatedPathCount: 0,
		finalText: JSON.stringify({
			mutatedPaths: [],
			validations: [],
			summary:
				"fix(compaction): reserve the real summary output\nBLOCKED: the trigger lives outside my write roots.\nchangelog: none.",
		}),
	};
	match(workerNoWorkDetail(input) ?? "", /changed nothing.*BLOCKED: the trigger lives outside/s);
	strictEqual(workerNoWorkDetail({ ...input, mutatedPathCount: 1 }), null);
	const subjectOnly = JSON.stringify({ mutatedPaths: [], summary: "fix(x): done\nThe parser cannot overflow." });
	strictEqual(workerNoWorkDetail({ ...input, finalText: subjectOnly }), null);
});

function git(root: string, ...args: string[]) {
	return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function repo() {
	const root = mkdtempSync(join(tmpdir(), "clio-coder-dispatch-retain-"));
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
			{ id: "verifier", capabilityClass: "verification" },
			{ id: "context-bootstrap", capabilityClass: "read-only", audience: "internal" },
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
		// Verification recipes run checks in the tree, so a parallel review sent to
		// them stays refused; the refusal names the read-only recipes that can take it.
		const review = (agent: string) => ({ agent, task: "Review src/a.ts for bugs" });
		const refusal = String(prepare([review("verifier"), review("verifier")]));
		match(refusal, /parallel_writer_conflict/);
		match(refusal, /dispatch read-only recipes instead: scout\./);
		strictEqual(prepare([review("scout"), review("scout")]), undefined);
		match(String(prepare([writer(["src/"]), writer(["src/nested/"])])), /parallel_writer_conflict/);
		strictEqual(prepare([writer(["src/"]), writer(["docs/"])]), undefined);
		// Writers that only hold a store grant are confined to it rather than refused.
		strictEqual(
			prepare([
				{ ...writer(), tags: ["fleet"] },
				{ ...writer(), tags: ["fleet"] },
			]),
			undefined,
		);
		match(String(prepare([{ ...writer(), tags: ["fleet"] }, writer()])), /parallel_writer_conflict/);
		strictEqual(prepare([writer(), { agent: "scout", task: "Inspect sources" }]), undefined);
		strictEqual(prepare([writer(), writer()], { writers: 1 }), undefined);
		match(String(prepare([writer(), writer()], { writers: 1, detach: true })), /cannot combine with detach: true/);
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
test("the writer lease refuses an overlapping writer from another dispatch call until the live one releases", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-writer-lease-")));
	const src = join(root, "src");
	const holder = (group: string, roots: string[] | null, isolated = false) => ({
		group,
		roots,
		isolated,
		agentId: "coder",
	});
	try {
		const detached = acquireCheckoutWriterLease({ checkout: root, holder: holder("call-1", [src]) });
		detached.bindRun("run-detached");
		acquireCheckoutWriterLease({ checkout: root, holder: holder("call-2", [join(root, "docs")]) }).release();
		throws(
			() => acquireCheckoutWriterLease({ checkout: root, holder: holder("call-2", [join(src, "nested")]) }),
			(error: unknown) =>
				error instanceof Error &&
				error.message ===
					`checkout_writer_conflict: coder would write ${root} while run run-detached (coder, started by an earlier dispatch call) is still live there; its write roots are ${src}, this request's are ${join(src, "nested")}. Wait for it with monitor(mode="wait", run_id="run-detached"), declare disjoint intent.write_roots on both dispatches, or use worktree: true.`,
		);
		throws(() => acquireCheckoutWriterLease({ checkout: root, holder: holder("call-2", null) }), /are undeclared\./u);
		// Siblings and retries of one call, worktree runs, and holderless read-only runs pass.
		acquireCheckoutWriterLease({ checkout: root, holder: holder("call-1", null) }).release();
		acquireCheckoutWriterLease({ checkout: root, holder: holder("call-2", null, true) }).release();
		acquireCheckoutWriterLease({ checkout: root }).release();
		detached.release();
		acquireCheckoutWriterLease({ checkout: root, holder: holder("call-2", null) }).release();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
test("a writer lease held on another host, or by a zombie, is judged by host and reaping", async () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-writer-lease-")));
	const holder = { group: "g", roots: null, isolated: false, agentId: "coder" };
	const lease = acquireCheckoutWriterLease({ checkout: root, holder });
	const path = lease.path;
	lease.release();
	const record = (host: string, pid: number) =>
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				checkout: root,
				host,
				pid,
				processBirthToken: "1",
				acquiredAt: new Date().toISOString(),
			}),
		);
	const child = spawn("sh", ["-c", "sleep 0 & echo $!; exec sleep 30"], { stdio: ["ignore", "pipe", "ignore"] });
	try {
		record("other-node.invalid", 999_999_999);
		throws(() => acquireCheckoutWriterLease({ checkout: root, holder }), /held by pid 999999999 on host other-node/u);
		const zombie = Number((await once(child.stdout, "data"))[0].toString().trim());
		for (let i = 0; i < 200 && !readFileSync(`/proc/${zombie}/stat`, "utf8").includes(") Z"); i++) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				checkout: root,
				host: hostname(),
				pid: zombie,
				processBirthToken: processBirthToken(zombie) ?? "x",
				acquiredAt: new Date().toISOString(),
			}),
		);
		acquireCheckoutWriterLease({ checkout: root, holder }).release();
	} finally {
		child.kill("SIGKILL");
		rmSync(root, { recursive: true, force: true });
	}
});
/** Write a lease record as its holder last did `writtenAgoMs` before now, stamping `heartbeatAt` with its own clock. */
function writeLeaseRecord(
	path: string,
	record: Record<string, unknown>,
	writtenAgoMs: number,
	holderClockSkewMs = 0,
	heartbeat = true,
): void {
	const writtenAt = Date.now() - writtenAgoMs;
	writeFileSync(
		path,
		JSON.stringify({
			version: 1,
			acquiredAt: new Date(writtenAt - 3_600_000 + holderClockSkewMs).toISOString(),
			...record,
			...(heartbeat
				? { heartbeatAt: new Date(writtenAt + holderClockSkewMs).toISOString(), heartbeatExpiresMs: 120_000 }
				: {}),
		}),
	);
	utimesSync(path, writtenAt / 1000, writtenAt / 1000);
}
test("another host's writer lease is honored until its heartbeat lapses, never by a local pid check", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-writer-lease-")));
	const holder = { group: "g", roots: null, isolated: false, agentId: "coder" };
	const first = acquireCheckoutWriterLease({ checkout: root, holder });
	const path = first.path;
	first.release();
	// The pid is dead here; on another host that proves nothing.
	const foreign = (writtenAgoMs: number, heartbeat = true) =>
		writeLeaseRecord(
			path,
			{ checkout: root, host: "other-node.invalid", pid: 999_999_999, processBirthToken: "1" },
			writtenAgoMs,
			0,
			heartbeat,
		);
	try {
		foreign(60_000);
		throws(() => acquireCheckoutWriterLease({ checkout: root, holder }), /held by pid 999999999 on host other-node/u);
		// A record from a writer that never beats keeps the old rule: held.
		foreign(3_600_000, false);
		throws(() => acquireCheckoutWriterLease({ checkout: root, holder }), /on host other-node/u);
		foreign(121_000);
		const taken = acquireCheckoutWriterLease({ checkout: root, holder });
		const record = JSON.parse(readFileSync(path, "utf8"));
		strictEqual(record.host, hostname());
		strictEqual(record.pid, process.pid);
		taken.release();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
test("another host's writer lease ages on the shared filesystem's clock, not on either host's", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-writer-lease-")));
	const holder = { group: "g", roots: null, isolated: false, agentId: "coder" };
	const first = acquireCheckoutWriterLease({ checkout: root, holder });
	const path = first.path;
	first.release();
	const foreign = (writtenAgoMs: number, holderClockSkewMs: number) =>
		writeLeaseRecord(
			path,
			{ checkout: root, host: "other-node.invalid", pid: 999_999_999, processBirthToken: "1" },
			writtenAgoMs,
			holderClockSkewMs,
		);
	try {
		// A holder whose clock runs 200 s behind this one, beating now, still holds the checkout.
		foreign(5_000, -200_000);
		throws(() => acquireCheckoutWriterLease({ checkout: root, holder }), /on host other-node/u);
		// A holder whose clock runs 500 s ahead, silent for 121 s, is gone.
		foreign(121_000, 500_000);
		acquireCheckoutWriterLease({ checkout: root, holder }).release();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
test("a local writer lease whose pid now names a different process is stale", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-writer-lease-")));
	const holder = { group: "g", roots: null, isolated: false, agentId: "coder" };
	const first = acquireCheckoutWriterLease({ checkout: root, holder });
	const path = first.path;
	first.release();
	// process.ppid is alive; the recorded start time is not its own.
	const local = (token: string, beatAgoMs: number) =>
		writeLeaseRecord(path, { checkout: root, host: hostname(), pid: process.ppid, processBirthToken: token }, beatAgoMs);
	// Where no start time is readable the token is the pid itself, so it cannot tell a reused pid apart.
	const pidOnly = { birthToken: (pid: number) => `pid-${pid}`, tokenProvesDeath: false, alive: () => true };
	try {
		local(`${processBirthToken(process.ppid)}0`, 0);
		acquireCheckoutWriterLease({ checkout: root, holder }).release();
		local(`pid-${process.ppid}`, 0);
		throws(() => acquireCheckoutWriterLease({ checkout: root, holder, probe: pidOnly }), /held by pid/u);
		local(`pid-${process.ppid}`, 121_000);
		acquireCheckoutWriterLease({ checkout: root, holder, probe: pidOnly }).release();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
test("a held writer lease beats while it is held and stops when released", (t) => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-writer-lease-")));
	const holder = { group: "g", roots: null, isolated: false, agentId: "coder" };
	const startMs = Date.parse("2026-01-01T12:00:00.000Z");
	t.mock.timers.enable({ apis: ["setInterval", "Date"], now: startMs });
	try {
		const lease = acquireCheckoutWriterLease({ checkout: root, holder });
		const beat = () => JSON.parse(readFileSync(lease.path, "utf8"));
		strictEqual(beat().heartbeatAt, new Date(startMs).toISOString());
		strictEqual(beat().heartbeatExpiresMs, 120_000);
		t.mock.timers.tick(15_000);
		strictEqual(beat().heartbeatAt, new Date(startMs + 15_000).toISOString());
		strictEqual(beat().acquiredAt, new Date(startMs).toISOString());
		lease.release();
		t.mock.timers.tick(15_000);
		ok(!existsSync(lease.path));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
test("a holderless read-only lease neither refuses nor is refused by another live process (#420)", () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "clio-coder-writer-lease-")));
	const other = { pid: process.ppid, processBirthToken: processBirthToken(process.ppid) ?? "unknown" };
	try {
		const readOnly = acquireCheckoutWriterLease({ checkout: root });
		const writer = acquireCheckoutWriterLease({
			checkout: root,
			...other,
			holder: { group: "other", roots: null, isolated: false, agentId: "coder" },
		});
		acquireCheckoutWriterLease({ checkout: root }).release();
		writer.release();
		readOnly.release();
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
test("compete cleanup preserves a recoverable dirty loser without moving the operator index or HEAD", async () => {
	const root = repo();
	try {
		const ownership = claimCompeteGroup(root, "retain-contract");
		const winner = await createCandidateWorktreeMapped(ownership, 1, git(root, "rev-parse", "HEAD"));
		writeFileSync(join(winner.path, "winner.txt"), "winning work");
		commitCandidateWork(winner, "winner", [join(winner.path, "winner.txt")]);
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
	const env = await isolateClioEnv("clio-coder-loop-ref-");
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
			playbookName: "test",
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
test("worker stderr text cannot start a line with the control-frame marker", async () => {
	const { neutralizeControlPrefix } = await import("../../src/worker/control-lane.js");
	const injected = 'refused: echo x\n@clio-control/1 {"kind":"heartbeat"}\n';
	strictEqual(neutralizeControlPrefix(injected, true), 'refused: echo x\n @clio-control/1 {"kind":"heartbeat"}\n');
	strictEqual(neutralizeControlPrefix("@clio-con", true), " @clio-con");
	strictEqual(neutralizeControlPrefix("@clio-control/1 x", false), "@clio-control/1 x");
});

test("a capped worker's dirty task worktree is committed on its preserved branch, not merged or dropped", async () => {
	const root = repo();
	const { applyTaskWorktree, createTaskWorktree, settleTaskWorktree } = await import("../../src/tools/task-worktree.js");
	const { partialResultDetail, preservesPartialResult } = await import("../../src/domains/dispatch/merge-gate.js");
	try {
		const task = createTaskWorktree(root, "cappedrun");
		// The faked run stopped at its tool-call cap with an edit and a new file uncommitted.
		writeFileSync(join(task.path, "base.txt"), "half done");
		writeFileSync(join(task.path, "new.txt"), "new");
		strictEqual(preservesPartialResult("worker_tool_call_cap_exhausted", true), true);
		strictEqual(preservesPartialResult("worker_tool_call_cap_exhausted", false), false);
		strictEqual(preservesPartialResult("worker_turn_timeout", true), false);
		const receipt = applyTaskWorktree({
			worktree: task,
			apply: "preserve",
			authoredPaths: [join(task.path, "base.txt"), join(task.path, "new.txt")],
		});
		strictEqual(receipt.applied, false);
		strictEqual(receipt.reason, undefined);
		ok(receipt.commit !== undefined);
		strictEqual(git(root, "show", `${task.branch}:base.txt`), "half done");
		strictEqual(git(root, "show", `${task.branch}:new.txt`), "new");
		strictEqual(readFileSync(join(root, "base.txt"), "utf8"), "base");
		strictEqual(git(task.path, "status", "--porcelain"), "");
		match(partialResultDetail(task.branch), /clio-coder fleet land clio-coder\/task\/cappedrun/u);
		settleTaskWorktree(task);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("an edit worker that changed files but reports it could not finish settles partial, preserved under a partial subject", async () => {
	const { taskWorktreeCommitMessage, preservesPartialResult } = await import("../../src/domains/dispatch/merge-gate.js");
	const { workerPartialWorkDetail } = await import("../../src/domains/dispatch/tool-stats.js");
	const summary = "Could not finish everything. The parser change is in; the CLI flag is not wired.";
	const input = {
		activity: { mutatingSucceeded: true },
		mutatedPathCount: 2,
		finalText: JSON.stringify({ mutatedPaths: ["a.ts", "b.ts"], validations: [], summary }),
	};
	match(workerPartialWorkDetail(input) ?? "", /did not finish the assignment.*Could not finish everything/su);
	match(
		workerPartialWorkDetail({ ...input, finalText: "fix(cli): wire the flag\nPartially done: tests pending." }) ?? "",
		/partial/u,
	);
	// Nothing changed is no work, not partial work; a report that opens with its result is a success.
	strictEqual(workerPartialWorkDetail({ ...input, mutatedPathCount: 0 }), null);
	strictEqual(workerPartialWorkDetail({ ...input, finalText: "Wired the flag. The parser cannot overflow." }), null);
	// Partial means unfinished work: a finish it could not verify here is still a finish.
	for (const finalText of [
		"Unable to run the tests here; implemented the --strict flag and its parser branch.",
		"Could not verify with the full suite (no network). Wired the flag.",
		"I couldn't build the docs locally, but the flag is done.",
	])
		strictEqual(workerPartialWorkDetail({ ...input, finalText }), null, finalText);
	match(
		workerPartialWorkDetail({ ...input, finalText: "Unable to complete the CLI half; the parser is done." }) ?? "",
		/partial/u,
	);
	match(
		workerPartialWorkDetail({ ...input, finalText: "I couldn't implement the flag's help text." }) ?? "",
		/partial/u,
	);
	strictEqual(preservesPartialResult("worker_partial_work", true), true);
	const task = "Add the --strict flag to the CLI parser.";
	strictEqual(
		taskWorktreeCommitMessage({ task, partial: true, commitMessage: "feat(cli): add --strict", summary }),
		"partial: Add the --strict flag to the CLI parser",
	);
	strictEqual(taskWorktreeCommitMessage({ task, partial: false, summary: "Added the flag." }), "Added the flag");
});
