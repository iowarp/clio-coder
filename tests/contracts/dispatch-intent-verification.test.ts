import { deepStrictEqual, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isDeterministicOutcomeCode } from "../../src/domains/dispatch/backoff.js";
import { hostVerificationRejection, runHostVerification } from "../../src/domains/dispatch/host-verification.js";
import { normalizeDispatchIntent } from "../../src/domains/dispatch/intent.js";
import { validateJobSpec } from "../../src/domains/dispatch/validation.js";
import { createDispatchAdmissionController } from "../../src/tools/dispatch-admission.js";
import { DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT } from "../../src/tools/dispatch-plan.js";
import type { DispatchToolDeps } from "../../src/tools/dispatch-types.js";

const declared = new Map([["test", { id: "test", timeoutMs: 30_000 }]]);

function admission(runtimeId = "http") {
	const dispatch = {
		preview: () => ({
			agentId: "coder",
			specFingerprint: "spec",
			targetId: "local",
			wireModelId: "model",
			runtimeId,
			node: { id: "local", kind: "local" as const },
			thinkingLevel: null,
			toolSignature: "tools",
			endpointIdentityHash: "endpoint",
			settingsFingerprint: "settings",
			costUpperBoundUsd: 0.01,
			costUpperBoundKnown: true,
			routeApproval: null,
		}),
	} as unknown as DispatchToolDeps["dispatch"];
	return createDispatchAdmissionController({
		dispatch,
		getAgentSpecs: () => [],
		getCostCeilingUsd: () => 10,
	});
}

function preparationError(prepared: Record<string, unknown>): string {
	const error = prepared[DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT];
	strictEqual(typeof error, "string");
	return String(error);
}

describe("typed dispatch intent", () => {
	it("normalizes POSIX paths deterministically and rejects malformed boundaries", () => {
		const normalized = normalizeDispatchIntent(
			{
				read_roots: [" src//tools/ ", "src/tools/", "src/domains/"],
				write_roots: [],
				relevant_paths: ["docs/fleet-dispatch.md"],
				expected_outputs: ["dist//cli.js"],
				verification: [{ check: "test", timeout_ms: 99_999 }],
			},
			declared,
		);
		ok(normalized.ok);
		deepStrictEqual(normalized.intent, {
			version: 2,
			readRoots: ["src/domains/", "src/tools/"],
			writeRoots: [],
			relevantPaths: ["docs/fleet-dispatch.md"],
			pathProvenance: [
				{
					path: "docs/fleet-dispatch.md",
					evidence: [
						{
							provenance: "declared",
							source: "intent.relevant_paths",
							confidence: "certain",
							reason: "explicit_intent",
						},
					],
				},
				...(["src/domains/", "src/tools/"] as const).map((path) => ({
					path,
					evidence: [
						{
							provenance: "declared" as const,
							source: "intent.read_roots" as const,
							confidence: "certain" as const,
							reason: "explicit_intent" as const,
						},
					],
				})),
			],
			expectedOutputs: ["dist/cli.js"],
			verification: [{ check: "test", timeoutMs: 30_000 }],
		});
		for (const [value, reason] of [
			["/tmp/x", "intent_path_absolute"],
			["../x", "intent_path_escapes_root"],
			["src/*.ts", "intent_path_malformed"],
			["./src/tools", "intent_path_malformed"],
			["", "intent_path_malformed"],
		] as const) {
			const result = normalizeDispatchIntent({ read_roots: [value] }, declared);
			ok(!result.ok);
			strictEqual(result.reason, reason);
		}
		const overCap = normalizeDispatchIntent(
			{ read_roots: Array.from({ length: 33 }, (_, index) => `p${index}`) },
			declared,
		);
		ok(!overCap.ok);
		strictEqual(overCap.reason, "intent_path_over_cap");
	});

	it("inherits batch intent, permits narrowing, and refuses an item that widens the top-level ceiling", () => {
		const controller = admission();
		const base = {
			tasks: [{ task: "first" }, { task: "second", intent: { read_roots: ["src/domains/"] } }],
			intent: { read_roots: ["src/"] },
		};
		const first = controller.prepareAdmissionArguments(base);
		const snapshot = controller.state.trustedExecutionSnapshots.get(first);
		ok(snapshot?.kind === "dispatch");
		deepStrictEqual(snapshot.requests[0]?.intent?.readRoots, ["src/"]);
		deepStrictEqual(snapshot.requests[1]?.intent?.readRoots, ["src/domains/"]);
		const same = controller.prepareAdmissionArguments(structuredClone(base));
		strictEqual(controller.describeDispatchPlan(first).hash, controller.describeDispatchPlan(same).hash);
		const changed = controller.prepareAdmissionArguments({
			...structuredClone(base),
			intent: { read_roots: ["src/", "tests/"] },
		});
		notStrictEqual(controller.describeDispatchPlan(first).hash, controller.describeDispatchPlan(changed).hash);
		const widened = controller.prepareAdmissionArguments({
			tasks: [{ task: "outside", intent: { read_roots: ["docs/"] } }],
			intent: { read_roots: ["src/"] },
		});
		match(preparationError(widened), /intent_scope_widening.*docs\//u);
	});

	it("refuses ambiguous, undeclared, unsupported-mode, and unsupported-runtime verification before approval", () => {
		match(
			preparationError(
				admission().prepareAdmissionArguments({
					task: "work",
					gate: "test",
					intent: { verification: [{ check: "test" }] },
				}),
			),
			/gate_and_intent_verification_conflict/u,
		);
		match(
			preparationError(admission().prepareAdmissionArguments({ task: "work", gate: "not-declared" })),
			/verification_check_undeclared.*not-declared/u,
		);
		const reviewController = admission();
		const reviewed = reviewController.prepareAdmissionArguments({
			task: "work",
			gate: "test",
			review: true,
			intent: { expected_outputs: ["scope audit"] },
		});
		strictEqual(reviewed[DISPATCH_PLAN_PREPARATION_ERROR_ARGUMENT], undefined);
		const reviewPlan = reviewController.state.trustedResolvedPlans.get(reviewed);
		const reviewer = reviewPlan?.tasks.find((task) => task.role === "reviewer");
		match(reviewer?.task ?? "", /Declared Result Requirements.*scope audit.*test must pass/su);
		match(
			preparationError(
				admission().prepareAdmissionArguments({ task: "work", gate: "test", mode: "compete", candidates: 2 }),
			),
			/verification_unsupported_for_mode/u,
		);
		match(
			preparationError(admission("claude-code").prepareAdmissionArguments({ task: "work", gate: "test" })),
			/verification_unsupported_runtime/u,
		);
	});

	it("copies intent write roots into the enforcement field and refuses a contradictory set", () => {
		const intent = normalizeDispatchIntent({ write_roots: ["src/tools"] }, declared);
		ok(intent.ok);
		const inherited = validateJobSpec({ agentId: "coder", task: "work", intent: intent.intent });
		ok(inherited.ok);
		deepStrictEqual(inherited.spec.writeRoots, [join(process.cwd(), "src/tools")]);
		const directoryIntent = normalizeDispatchIntent({ write_roots: ["src/tools/"] }, declared);
		ok(directoryIntent.ok);
		const directory = validateJobSpec({ agentId: "coder", task: "work", intent: directoryIntent.intent });
		ok(directory.ok);
		deepStrictEqual(directory.spec.writeRoots, [`${join(process.cwd(), "src/tools")}/`]);
		const contradiction = validateJobSpec({
			agentId: "coder",
			task: "work",
			intent: intent.intent,
			writeRoots: ["src/domains"],
		});
		ok(!contradiction.ok);
		ok(contradiction.errors.includes("intent_write_roots_contradiction"));
	});
});

describe("host-run dispatch verification", () => {
	it("records pass, rejection output, memo hits, and tree-change misses", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-host-verification-"));
		const stateDir = mkdtempSync(join(tmpdir(), "clio-host-verification-state-"));
		execFileSync("git", ["init", "-q", root]);
		execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
		execFileSync("git", ["-C", root, "config", "user.name", "Clio Test"]);
		writeFileSync(join(root, "value.txt"), "one\n", "utf8");
		execFileSync("git", ["-C", root, "add", "value.txt"]);
		execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
		const request = {
			resolvedVerification: [
				{
					check: "pass",
					argv: [process.execPath, "-e", "process.stdout.write('host pass')"],
					cwd: root,
					timeoutMs: 10_000,
				},
			],
		};
		const first = await runHostVerification({ runId: "run-1", request, workerSuccessful: true, stateDir });
		strictEqual(first?.status, "verified");
		strictEqual(first?.checks[0]?.memo, false);
		const second = await runHostVerification({ runId: "run-2", request, workerSuccessful: true, stateDir });
		strictEqual(second?.status, "verified");
		strictEqual(second?.checks[0]?.memo, true);
		strictEqual(second?.checks[0]?.evidenceRunId, "run-1");
		writeFileSync(join(root, "value.txt"), "two\n", "utf8");
		const third = await runHostVerification({ runId: "run-3", request, workerSuccessful: true, stateDir });
		strictEqual(third?.checks[0]?.memo, false);

		const rejected = await runHostVerification({
			runId: "run-4",
			workerSuccessful: true,
			stateDir,
			request: {
				resolvedVerification: [
					{
						check: "fail",
						argv: [process.execPath, "-e", "process.stderr.write('failure tail'); process.exit(7)"],
						cwd: root,
						timeoutMs: 10_000,
					},
				],
			},
		});
		strictEqual(rejected?.status, "rejected");
		strictEqual(rejected?.checks[0]?.exitCode, 7);
		match(rejected?.checks[0]?.outputTail ?? "", /failure tail/u);
		ok(readFileSync(rejected?.checks[0]?.artifactPath ?? "", "utf8").includes("failure tail"));
		deepStrictEqual(await runHostVerification({ runId: "run-5", request, workerSuccessful: false, stateDir }), {
			status: "skipped",
			reason: "worker_not_successful",
			checks: [],
		});
	});

	it("preserves both memo records when runs finalize concurrently", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-host-verification-concurrent-"));
		const stateDir = mkdtempSync(join(tmpdir(), "clio-host-verification-concurrent-state-"));
		execFileSync("git", ["init", "-q", root]);
		execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
		execFileSync("git", ["-C", root, "config", "user.name", "Clio Test"]);
		writeFileSync(join(root, "value.txt"), "one\n", "utf8");
		execFileSync("git", ["-C", root, "add", "value.txt"]);
		execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
		const requestFor = (check: string) => ({
			resolvedVerification: [
				{
					check,
					argv: [process.execPath, "-e", `setTimeout(() => process.stdout.write('${check}'), 20)`],
					cwd: root,
					timeoutMs: 10_000,
				},
			],
		});
		const [first, second] = await Promise.all([
			runHostVerification({ runId: "concurrent-1", request: requestFor("one"), workerSuccessful: true, stateDir }),
			runHostVerification({ runId: "concurrent-2", request: requestFor("two"), workerSuccessful: true, stateDir }),
		]);
		strictEqual(first?.checks[0]?.memo, false);
		strictEqual(second?.checks[0]?.memo, false);
		const memo = JSON.parse(readFileSync(join(stateDir, "dispatch-verification-memo.json"), "utf8")) as {
			entries: Array<{ runId: string }>;
		};
		deepStrictEqual(memo.entries.map((entry) => entry.runId).sort(), ["concurrent-1", "concurrent-2"]);
	});

	it("runs without memoization outside a Git workspace", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-host-verification-nongit-"));
		const stateDir = mkdtempSync(join(tmpdir(), "clio-host-verification-nongit-state-"));
		writeFileSync(join(root, ".git"), "gitdir: missing\n", "utf8");
		const result = await runHostVerification({
			runId: "non-git",
			workerSuccessful: true,
			stateDir,
			request: {
				resolvedVerification: [
					{
						check: "non-git-pass",
						argv: [process.execPath, "-e", "process.stdout.write('non-git pass')"],
						cwd: root,
						timeoutMs: 10_000,
					},
				],
			},
		});
		strictEqual(result?.status, "verified");
		strictEqual(result?.checks[0]?.memo, false);
		strictEqual(result?.checks[0]?.exitCode, 0);
	});

	it("classifies rejection with the failing check and suppresses retry", () => {
		const rejected = hostVerificationRejection({
			status: "rejected",
			checks: [
				{
					check: "contracts",
					argv: ["npm", "run", "test"],
					cwd: "/workspace",
					exitCode: 7,
					durationMs: 42,
					memo: false,
					outputTail: "failed",
				},
			],
		});
		deepStrictEqual(rejected, {
			outcomeCode: "host_verification_rejected",
			detail: "host verification check 'contracts' rejected with exit code 7",
		});
		strictEqual(isDeterministicOutcomeCode(rejected?.outcomeCode), true);
	});
});
