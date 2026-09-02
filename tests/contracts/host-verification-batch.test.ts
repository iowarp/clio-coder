import { deepStrictEqual, ok, rejects, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { DispatchRequest } from "../../src/domains/dispatch/contract.js";
import {
	type BatchVerificationParticipant,
	createBatchVerificationGate,
	hostVerificationRejection,
	runHostVerification,
} from "../../src/domains/dispatch/host-verification.js";
import { declaredScopeIntent } from "../../src/domains/dispatch/intent.js";
import { adaptRunReceiptValidationStatus } from "../../src/domains/evidence/trust-status.js";

type ResolvedCheck = NonNullable<DispatchRequest["resolvedVerification"]>[number];

interface Scratch {
	/** Scratch root holding the checkout, the state directory, and the run log. */
	root: string;
	/** Git checkout the declared checks run in. */
	project: string;
	/** Isolated `stateDir` for the verification memo and the check artifacts. */
	stateDir: string;
	/** One line per actual command execution, written by the check itself. */
	log: string;
}

const scratches: string[] = [];

afterEach(() => {
	while (scratches.length > 0) {
		const dir = scratches.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

function git(root: string, ...args: string[]): void {
	execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * A committed scratch checkout plus an isolated state directory.
 *
 * `git init` runs inside `project/`, never at the scratch root or the run root:
 * a `.git` at either of those levels flips `isInsideGitRepo()` for every
 * `mkdtemp` scratch in the suite and fails the ignore-policy contracts from an
 * unrelated file (issue #205, `tests/harness/tmp-git-guard.ts`).
 */
function makeScratch(): Scratch {
	const root = mkdtempSync(join(tmpdir(), "clio-host-verification-"));
	scratches.push(root);
	const project = join(root, "project");
	const stateDir = join(root, "state");
	mkdirSync(join(project, "src"), { recursive: true });
	mkdirSync(join(project, "tests"), { recursive: true });
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(join(project, "src", "a.ts"), "export const a = 1;\n", "utf8");
	writeFileSync(join(project, "src", "b.ts"), "export const b = 2;\n", "utf8");
	writeFileSync(join(project, "tests", "a.test.ts"), "// a\n", "utf8");
	writeFileSync(join(project, "tests", "b.test.ts"), "// b\n", "utf8");
	git(project, "init", "-q", "-b", "main");
	git(project, "config", "user.name", "Host Verification Contract");
	git(project, "config", "user.email", "host-verification@example.invalid");
	git(project, "add", "-A");
	git(project, "commit", "-q", "-m", "baseline");
	return { root, project, stateDir, log: join(root, "check-runs.log") };
}

/**
 * A declared check that records every execution and then prints `message`.
 *
 * `process.execPath` rather than `"node"`: `runCodeStep` passes a closed
 * environment allowlist (`code-step.ts` `FLEET_COMMAND_BASE_ENV`) and no
 * test-supplied variable survives it, so the run counter lives in the argv the
 * admission layer would have resolved.
 */
function check(input: { scratch: Scratch; id?: string; message: string; exitCode: number }): ResolvedCheck {
	const script = [
		`require("node:fs").appendFileSync(${JSON.stringify(input.scratch.log)}, "ran\\n");`,
		`console.error(${JSON.stringify(input.message)});`,
		`process.exit(${input.exitCode});`,
	].join(" ");
	return {
		check: input.id ?? "test",
		argv: [process.execPath, "-e", script],
		cwd: input.scratch.project,
		timeoutMs: 30_000,
	};
}

/**
 * One batch member. Omitting `writeRoots` is the unconfined shape a
 * verification-only intent normalizes to (`intent.ts:139` also drops a `"."`
 * entry into it), and `cwd` overrides the frame the member's roots resolve in,
 * which is what a `worktree: true` task carries.
 */
function member(input: {
	runId: string;
	scratch: Scratch;
	cwd?: string;
	writeRoots?: ReadonlyArray<string>;
	checks?: ReadonlyArray<ResolvedCheck>;
	workerSuccessful?: boolean;
}): BatchVerificationParticipant {
	const declared = declaredScopeIntent({ writeRoots: input.writeRoots ?? [] });
	ok(declared.ok, "scratch intent must normalize");
	return {
		runId: input.runId,
		request: {
			cwd: input.cwd ?? input.scratch.project,
			intent: declared.intent,
			...(input.checks === undefined ? {} : { resolvedVerification: input.checks }),
		},
		workerSuccessful: input.workerSuccessful ?? true,
	};
}

/** Command executions recorded by the check itself, across the whole batch. */
function runCount(scratch: Scratch): number {
	try {
		return readFileSync(scratch.log, "utf8")
			.trim()
			.split("\n")
			.filter((line) => line.length > 0).length;
	} catch {
		return 0;
	}
}

describe("batch-settled host verification", () => {
	it("runs one batch check once and rejects only the worker whose write roots the failure names", async () => {
		const scratch = makeScratch();
		const failing = check({ scratch, message: "1) tests/b.test.ts > adds\nAssertionError", exitCode: 1 });
		const gate = createBatchVerificationGate({ stateDir: scratch.stateDir });
		gate.live("run-a");
		gate.live("run-b");
		const [a, b] = await Promise.all([
			gate.arrive(member({ runId: "run-a", scratch, writeRoots: ["src/a.ts", "tests/a.test.ts"], checks: [failing] })),
			gate.arrive(member({ runId: "run-b", scratch, writeRoots: ["src/b.ts", "tests/b.test.ts"], checks: [failing] })),
		]);

		// Not "verified": the exculpated member's own checks array carries the
		// failing exit code, and "verified" is the claim every consumer reads as
		// "the declared checks passed".
		strictEqual(a?.status, "not_implicated");
		strictEqual(a?.strategy, "batch-settled");
		strictEqual(a?.reason, "batch_settled_not_implicated");
		strictEqual(a?.checks[0]?.exitCode, 1);
		strictEqual(b?.status, "rejected");
		strictEqual(b?.strategy, "batch-settled");
		strictEqual(b?.attribution?.[0]?.basis, "write_roots");
		deepStrictEqual(b?.attribution?.[0]?.charged, ["run-b"]);
		ok(b?.attribution?.[0]?.implicated.includes(resolve(scratch.project, "tests/b.test.ts")));
		strictEqual(runCount(scratch), 1);
		strictEqual(hostVerificationRejection(a), null);
		strictEqual(hostVerificationRejection(b)?.outcomeCode, "host_verification_rejected");
		// The trust surface must not certify a run whose declared check exited 1.
		strictEqual(adaptRunReceiptValidationStatus({ runId: "run-a", hostVerification: a }).state, "unknown");
		strictEqual(adaptRunReceiptValidationStatus({ runId: "run-b", hostVerification: b }).state, "failed");
	});

	it("charges a declaring worker that ran unconfined even when a sibling's write roots are implicated", async () => {
		const scratch = makeScratch();
		const failing = check({ scratch, message: "1) tests/a.test.ts > adds\nAssertionError", exitCode: 1 });
		const gate = createBatchVerificationGate({ stateDir: scratch.stateDir });
		gate.live("run-a");
		gate.live("run-unconfined");
		const [a, unconfined] = await Promise.all([
			gate.arrive(member({ runId: "run-a", scratch, writeRoots: ["tests/a.test.ts"], checks: [failing] })),
			// write_roots omitted: no boundary to test the failing paths against, and
			// the run executed with no write confinement at all.
			gate.arrive(member({ runId: "run-unconfined", scratch, checks: [failing] })),
		]);

		strictEqual(a?.status, "rejected");
		strictEqual(unconfined?.status, "rejected");
		strictEqual(unconfined?.checks[0]?.exitCode, 1);
		deepStrictEqual(a?.attribution?.[0]?.charged, ["run-a", "run-unconfined"]);
		// Not "write_roots": the unconfined member is charged without a path of its
		// own, so the record cannot claim positive evidence for every charged run.
		strictEqual(a?.attribution?.[0]?.basis, "unattributable");
		strictEqual(hostVerificationRejection(unconfined)?.outcomeCode, "host_verification_rejected");
	});

	it("clears a declarer when every named path falls inside a live sibling that declared no check", async () => {
		const scratch = makeScratch();
		const failing = check({ scratch, message: "1) src/b.ts > doubles", exitCode: 1 });
		const gate = createBatchVerificationGate({ stateDir: scratch.stateDir });
		gate.live("run-a");
		gate.live("run-b");
		const [a, b] = await Promise.all([
			gate.arrive(member({ runId: "run-a", scratch, writeRoots: ["src/a.ts"], checks: [failing] })),
			gate.arrive(member({ runId: "run-b", scratch, writeRoots: ["src/b.ts"] })),
		]);

		strictEqual(a?.status, "not_implicated");
		strictEqual(a?.attribution?.[0]?.basis, "attributed_elsewhere");
		deepStrictEqual(a?.attribution?.[0]?.charged, []);
		deepStrictEqual(a?.attribution?.[0]?.implicated, [resolve(scratch.project, "src/b.ts")]);
		strictEqual(hostVerificationRejection(a), null);
		strictEqual(b, undefined);
	});

	it("charges every declarer when a member's write roots resolve in a frame the check never ran in", async () => {
		const scratch = makeScratch();
		const failing = check({ scratch, message: "1) src/b.ts > doubles", exitCode: 1 });
		const gate = createBatchVerificationGate({ stateDir: scratch.stateDir });
		gate.live("run-a");
		gate.live("run-b");
		// A `worktree: true` task's request cwd is its own checkout
		// (`extension.ts:5777`) while the resolved check cwd stays the parent
		// (`dispatch-admission.ts:246`), so no boundary can cover a named path.
		const [a, b] = await Promise.all([
			gate.arrive(
				member({
					runId: "run-a",
					scratch,
					cwd: join(scratch.root, "worktree-a"),
					writeRoots: ["src/a.ts"],
					checks: [failing],
				}),
			),
			gate.arrive(
				member({
					runId: "run-b",
					scratch,
					cwd: join(scratch.root, "worktree-b"),
					writeRoots: ["src/b.ts"],
					checks: [failing],
				}),
			),
		]);

		strictEqual(a?.status, "rejected");
		strictEqual(b?.status, "rejected");
		strictEqual(a?.attribution?.[0]?.basis, "unattributable");
		deepStrictEqual(a?.attribution?.[0]?.charged, ["run-a", "run-b"]);
	});

	it("keeps the charging path in the capped implicated list", async () => {
		const scratch = makeScratch();
		// 40 unowned paths sort before the one that charges run-a, so an
		// alphabetical prefix would seal 32 paths supporting nothing.
		const noise = Array.from({ length: 40 }, (_, index) => `vendor/pkg-${String(index).padStart(2, "0")}.ts`);
		const failing = check({ scratch, message: [...noise, "1) zzz/owned.ts > adds"].join("\n"), exitCode: 1 });
		const gate = createBatchVerificationGate({ stateDir: scratch.stateDir });
		gate.live("run-a");
		gate.live("run-b");
		const [a, b] = await Promise.all([
			gate.arrive(member({ runId: "run-a", scratch, writeRoots: ["zzz/owned.ts"], checks: [failing] })),
			gate.arrive(member({ runId: "run-b", scratch, writeRoots: ["src/b.ts"], checks: [failing] })),
		]);

		strictEqual(a?.status, "rejected");
		strictEqual(b?.status, "not_implicated");
		strictEqual(a?.attribution?.[0]?.basis, "write_roots");
		strictEqual(a?.attribution?.[0]?.implicated.length, 32);
		strictEqual(a?.attribution?.[0]?.implicated[0], resolve(scratch.project, "zzz/owned.ts"));
	});

	it("charges every declaring worker when the failing check names no path", async () => {
		const scratch = makeScratch();
		const failing = check({ scratch, message: "boom", exitCode: 1 });
		const gate = createBatchVerificationGate({ stateDir: scratch.stateDir });
		gate.live("run-a");
		gate.live("run-b");
		const [a, b] = await Promise.all([
			gate.arrive(member({ runId: "run-a", scratch, writeRoots: ["src/a.ts"], checks: [failing] })),
			gate.arrive(member({ runId: "run-b", scratch, writeRoots: ["src/b.ts"], checks: [failing] })),
		]);

		strictEqual(a?.status, "rejected");
		strictEqual(b?.status, "rejected");
		strictEqual(a?.attribution?.[0]?.basis, "unattributable");
		deepStrictEqual(a?.attribution?.[0]?.charged, ["run-a", "run-b"]);
		deepStrictEqual(a?.attribution?.[0]?.implicated, []);
		strictEqual(runCount(scratch), 1);
	});

	it("charges every declaring worker when the named paths fall outside every write root", async () => {
		const scratch = makeScratch();
		const failing = check({ scratch, message: "1) vendor/x.ts > adds", exitCode: 1 });
		const gate = createBatchVerificationGate({ stateDir: scratch.stateDir });
		gate.live("run-a");
		gate.live("run-b");
		const [a, b] = await Promise.all([
			gate.arrive(member({ runId: "run-a", scratch, writeRoots: ["src/a.ts"], checks: [failing] })),
			gate.arrive(member({ runId: "run-b", scratch, writeRoots: ["src/b.ts"], checks: [failing] })),
		]);

		strictEqual(a?.status, "rejected");
		strictEqual(b?.status, "rejected");
		strictEqual(a?.attribution?.[0]?.basis, "unattributable");
		deepStrictEqual(a?.attribution?.[0]?.charged, ["run-a", "run-b"]);
		deepStrictEqual(a?.attribution?.[0]?.implicated, [resolve(scratch.project, "vendor/x.ts")]);
	});

	it("keeps the single-run receipt shape unchanged", async () => {
		const scratch = makeScratch();
		const passing = check({ scratch, message: "ok", exitCode: 0 });
		const result = await runHostVerification({
			runId: "run-solo",
			request: { resolvedVerification: [passing] },
			workerSuccessful: true,
			stateDir: scratch.stateDir,
		});

		deepStrictEqual(Object.keys(result ?? {}).sort(), ["checks", "status"]);
		strictEqual(result?.status, "verified");
		strictEqual(result?.checks[0]?.memo, false);
		strictEqual(runCount(scratch), 1);
	});

	it("releases the barrier when a live sibling never reaches it", async () => {
		const scratch = makeScratch();
		const passing = check({ scratch, message: "ok", exitCode: 0 });
		const gate = createBatchVerificationGate({ stateDir: scratch.stateDir });
		gate.live("run-a");
		gate.live("run-gone");
		const pending = gate.arrive(member({ runId: "run-a", scratch, writeRoots: ["src/a.ts"], checks: [passing] }));
		gate.abandon("run-gone");
		const a = await pending;

		strictEqual(a?.status, "verified");
		strictEqual(a?.strategy, "batch-settled");
	});

	it("forms a new barrier for each admission wave instead of racing the members admitted later", async () => {
		const scratch = makeScratch();
		const failing = check({ scratch, message: "1) src/a.ts > adds", exitCode: 1 });
		const gate = createBatchVerificationGate({ stateDir: scratch.stateDir });
		gate.live("run-1");
		gate.live("run-2");
		await Promise.all([
			gate.arrive(member({ runId: "run-1", scratch, writeRoots: ["src/a.ts"], checks: [failing] })),
			gate.arrive(member({ runId: "run-2", scratch, writeRoots: ["src/b.ts"], checks: [failing] })),
		]);

		// A batch larger than the effective capacity admits its remainder only once
		// the first wave's leases free. Those members must barrier against each
		// other rather than each running the shared check on a checkout the other
		// is still editing, which is the defect the gate exists to remove.
		gate.live("run-3");
		gate.live("run-4");
		const [three, four] = await Promise.all([
			gate.arrive(member({ runId: "run-3", scratch, writeRoots: ["src/a.ts"], checks: [failing] })),
			gate.arrive(member({ runId: "run-4", scratch, writeRoots: ["src/b.ts"], checks: [failing] })),
		]);

		strictEqual(three?.strategy, "batch-settled");
		strictEqual(four?.strategy, "batch-settled");
		strictEqual(three?.status, "rejected");
		strictEqual(four?.status, "not_implicated");
		deepStrictEqual(three?.attribution?.[0]?.charged, ["run-3"]);
		strictEqual(runCount(scratch), 2);
	});

	it("fails every parked member when the settlement and the per-run fallback both throw", async () => {
		const scratch = makeScratch();
		// A regular file where the state directory's parent belongs: the artifact
		// write in `runCodeStep` raises ENOTDIR, which is a declared check that
		// could not be executed, not a check that failed.
		const blocked = join(scratch.root, "blocked-state");
		writeFileSync(blocked, "not a directory\n", "utf8");
		const passing = check({ scratch, message: "ok", exitCode: 0 });
		const gate = createBatchVerificationGate({ stateDir: join(blocked, "state") });
		gate.live("run-a");
		gate.live("run-b");
		const a = gate.arrive(member({ runId: "run-a", scratch, writeRoots: ["src/a.ts"], checks: [passing] }));
		const b = gate.arrive(member({ runId: "run-b", scratch, writeRoots: ["src/b.ts"], checks: [passing] }));

		// The single-task path throws out of finalization and fails the run; a
		// batch member must not seal as succeeded with no host-verification record.
		await Promise.all([rejects(a, /ENOTDIR/u), rejects(b, /ENOTDIR/u)]);
		await rejects(
			runHostVerification({
				runId: "run-solo",
				request: { resolvedVerification: [passing] },
				workerSuccessful: true,
				stateDir: join(blocked, "state"),
			}),
			/ENOTDIR/u,
		);
	});

	it("parks a failed member and a member with no declared checks without running anything for them", async () => {
		const scratch = makeScratch();
		const passing = check({ scratch, message: "ok", exitCode: 0 });
		const gate = createBatchVerificationGate({ stateDir: scratch.stateDir });
		gate.live("run-a");
		gate.live("run-none");
		gate.live("run-failed");
		const [a, none, failed] = await Promise.all([
			gate.arrive(member({ runId: "run-a", scratch, writeRoots: ["src/a.ts"], checks: [passing] })),
			gate.arrive(member({ runId: "run-none", scratch, writeRoots: ["src/b.ts"] })),
			gate.arrive(
				member({
					runId: "run-failed",
					scratch,
					writeRoots: ["tests/b.test.ts"],
					checks: [passing],
					workerSuccessful: false,
				}),
			),
		]);

		strictEqual(a?.status, "verified");
		strictEqual(a?.strategy, "batch-settled");
		strictEqual(none, undefined);
		deepStrictEqual(failed, { status: "skipped", reason: "worker_not_successful", checks: [] });
		strictEqual(runCount(scratch), 1);
	});
});
