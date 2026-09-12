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
	workspaceFingerprint,
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
	const root = mkdtempSync(join(tmpdir(), "clio-coder-host-verification-"));
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

describe("host verification judgment identity", () => {
	function measurement(scratch: Scratch): ResolvedCheck {
		return {
			check: "value",
			argv: [
				process.execPath,
				"-e",
				[
					`require("node:fs").appendFileSync(${JSON.stringify(scratch.log)}, "ran\\n");`,
					"console.log(JSON.stringify({ value: 2 }));",
				].join(" "),
			],
			cwd: scratch.project,
			timeoutMs: 30_000,
		};
	}

	function verify(scratch: Scratch, runId: string, resolvedCheck: ResolvedCheck) {
		return runHostVerification({
			runId,
			request: { resolvedVerification: [resolvedCheck] },
			workerSuccessful: true,
			stateDir: scratch.stateDir,
		});
	}

	for (const kind of ["numeric-compare", "perf-budget"] as const) {
		it(`does not reuse an exit-only pass for a ${kind} judgment`, async () => {
			const scratch = makeScratch();
			const reference = join(scratch.project, "reference.json");
			writeFileSync(reference, '{"value":1}');
			const base = measurement(scratch);
			const command = await verify(scratch, "exit-only", { ...base, check: "exit-only", kind: "command" });
			strictEqual(command?.status, "verified");
			const judged = await verify(scratch, "judged", {
				...base,
				kind,
				...(kind === "numeric-compare"
					? { numeric: { reference, tolerance: { absolute: 0 } } }
					: { perf: { budget: { wallTimeMs: 0.001 } } }),
			});
			strictEqual(judged?.status, "rejected");
			strictEqual(judged?.checks[0]?.check, "value");
			strictEqual(judged?.checks[0]?.memo, false);
			strictEqual(judged?.checks[0]?.report?.kind, kind);
			strictEqual(runCount(scratch), 2);
		});
	}

	for (const bound of [
		"numeric tolerance",
		"performance budget",
		"budget tolerance",
		"baseline tolerance",
		"timeout",
	] as const) {
		it(`invalidates a memo pass when the ${bound} changes`, async () => {
			const scratch = makeScratch();
			const reference = join(scratch.project, "reference.json");
			const baseline = join(scratch.project, "baseline.json");
			writeFileSync(reference, '{"value":1}');
			writeFileSync(baseline, '{"version":1,"wallTimeMs":0.001}');
			const base = measurement(scratch);
			const pairs: Record<typeof bound, [ResolvedCheck, ResolvedCheck]> = {
				"numeric tolerance": [
					{ ...base, kind: "numeric-compare", numeric: { reference, tolerance: { absolute: 1 } } },
					{ ...base, kind: "numeric-compare", numeric: { reference, tolerance: { absolute: 0 } } },
				],
				"performance budget": [
					{ ...base, kind: "perf-budget", perf: { budget: { wallTimeMs: 60_000 } } },
					{ ...base, kind: "perf-budget", perf: { budget: { wallTimeMs: 0.001 } } },
				],
				"budget tolerance": [
					{ ...base, kind: "perf-budget", perf: { budget: { wallTimeMs: 0.001, tolerance: { relative: 60_000_000 } } } },
					{ ...base, kind: "perf-budget", perf: { budget: { wallTimeMs: 0.001, tolerance: { relative: 0 } } } },
				],
				"baseline tolerance": [
					{ ...base, kind: "perf-budget", perf: { baseline, tolerance: { relative: 60_000_000 } } },
					{ ...base, kind: "perf-budget", perf: { baseline, tolerance: { relative: 0 } } },
				],
				timeout: [base, { ...base, timeoutMs: 60_000 }],
			};
			const [loose, strict] = pairs[bound];
			const first = await verify(scratch, "loose", loose);
			strictEqual(first?.status, "verified");
			const second = await verify(scratch, "strict", strict);
			strictEqual(second?.checks[0]?.memo, false);
			strictEqual(second?.status, bound === "timeout" ? "verified" : "rejected");
			strictEqual(runCount(scratch), 2);
		});
	}

	for (const kind of ["numeric-compare", "perf-budget"] as const) {
		it(`invalidates ${kind} evidence when an ignored reference or baseline changes`, async () => {
			const scratch = makeScratch();
			writeFileSync(join(scratch.project, ".gitignore"), "measurements/\n");
			mkdirSync(join(scratch.project, "measurements"));
			const path = join(scratch.project, "measurements", "reference.json");
			writeFileSync(path, kind === "numeric-compare" ? '{"value":2}' : '{"version":1,"wallTimeMs":60000}');
			const resolved: ResolvedCheck = {
				...measurement(scratch),
				kind,
				...(kind === "numeric-compare"
					? { numeric: { reference: path, tolerance: { absolute: 0 } } }
					: { perf: { baseline: path } }),
			};
			const fingerprint = workspaceFingerprint(scratch.project);
			ok(fingerprint);
			const first = await verify(scratch, "original", resolved);
			strictEqual(first?.status, "verified");
			const reused = await verify(scratch, "identical", structuredClone(resolved));
			strictEqual(reused?.checks[0]?.memo, true);
			strictEqual(reused?.checks[0]?.evidenceRunId, "original");
			deepStrictEqual(reused?.checks[0]?.report, first?.checks[0]?.report);
			writeFileSync(path, kind === "numeric-compare" ? '{"value":1}' : '{"version":1,"wallTimeMs":0.001}');
			strictEqual(
				workspaceFingerprint(scratch.project),
				fingerprint,
				"ignored data does not change the workspace fingerprint",
			);
			const changed = await verify(scratch, "changed", resolved);
			strictEqual(changed?.status, "rejected");
			strictEqual(changed?.checks[0]?.memo, false);
			rmSync(path);
			const missing = await verify(scratch, "missing", resolved);
			strictEqual(missing?.status, "rejected");
			strictEqual(missing?.checks[0]?.memo, false);
			strictEqual(runCount(scratch), 3);
		});
	}

	it("preserves check names and reuses identical command evidence with provenance", async () => {
		const scratch = makeScratch();
		const base = measurement(scratch);
		const first = await verify(scratch, "first", base);
		strictEqual(first?.status, "verified");
		const renamed = await verify(scratch, "renamed", { ...base, check: "energy" });
		strictEqual(renamed?.checks[0]?.check, "energy");
		strictEqual(renamed?.checks[0]?.memo, false);
		const reused = await verify(scratch, "reused", { ...base, kind: "command" });
		strictEqual(reused?.checks[0]?.check, "value");
		strictEqual(reused?.checks[0]?.memo, true);
		strictEqual(reused?.checks[0]?.evidenceRunId, "first");
		strictEqual(reused?.checks[0]?.artifactPath, first?.checks[0]?.artifactPath);
		strictEqual(runCount(scratch), 2);
	});

	it("retains every batch judgment sharing argv and only deduplicates identical declarations", async () => {
		const scratch = makeScratch();
		const reference = join(scratch.project, "reference.json");
		const alternate = join(scratch.project, "alternate.json");
		writeFileSync(reference, '{"value":1}');
		writeFileSync(alternate, '{"value":2}');
		const base = measurement(scratch);
		const checks: ResolvedCheck[] = [
			base,
			{ ...base, check: "energy" },
			{ ...base, kind: "numeric-compare", numeric: { reference, tolerance: { absolute: 1 } } },
			{ ...base, kind: "numeric-compare", numeric: { reference, tolerance: { absolute: 0 } } },
			{ ...base, kind: "numeric-compare", numeric: { reference: alternate, tolerance: { absolute: 0 } } },
			{ ...base, kind: "perf-budget", perf: { budget: { wallTimeMs: 60_000 } } },
			{ ...base, kind: "perf-budget", perf: { budget: { wallTimeMs: 0.001 } } },
			{ ...base, timeoutMs: 60_000 },
		];
		const gate = createBatchVerificationGate({ stateDir: scratch.stateDir });
		gate.live("owner");
		gate.live("sibling");
		const [owner, sibling] = await Promise.all([
			gate.arrive(member({ runId: "owner", scratch, checks })),
			gate.arrive(member({ runId: "sibling", scratch, checks: structuredClone(checks) })),
		]);
		for (const result of [owner, sibling]) {
			strictEqual(result?.status, "rejected");
			deepStrictEqual(
				result?.checks.map((entry) => entry.check),
				checks.map((entry) => entry.check),
			);
			deepStrictEqual(
				result?.checks.map((entry) => entry.exitCode),
				[0, 0, 0, 1, 0, 0, 1, 0],
			);
			deepStrictEqual(
				result?.checks.map((entry) => entry.report?.kind),
				[
					undefined,
					undefined,
					"numeric-compare",
					"numeric-compare",
					"numeric-compare",
					"perf-budget",
					"perf-budget",
					undefined,
				],
			);
		}
		ok(sibling?.checks.every((entry) => entry.evidenceRunId === "owner"));
		strictEqual(runCount(scratch), checks.length);
	});
});

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
