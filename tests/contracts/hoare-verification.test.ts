import { deepStrictEqual, match, ok, strictEqual, throws } from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { verifierVerdict } from "../../src/cli/run-output.js";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import {
	type DeclaredProof,
	HOARE_ASSURANCES,
	HOARE_STATUSES,
	type HoareAssurance,
	type HoareObligation,
	hoarePasses,
} from "../../src/core/hoare.js";
import {
	parseResultContract,
	parseVerifierResult,
	type ResultContract,
	type VerifierCheck,
	validateResultContract,
} from "../../src/domains/agents/result-contract.js";
import { renderFleetNodeTask } from "../../src/domains/dispatch/fleet-node-prompt.js";
import { decideReviewGate } from "../../src/domains/dispatch/gate-decisions.js";
import { groundClaimedValidations } from "../../src/domains/dispatch/validation-grounding.js";
import type { SpawnedWorker } from "../../src/domains/dispatch/worker-spawn.js";
import { createRunEffectsRecorder, recordToolExecutionEffects } from "../../src/domains/safety/run-effects.js";
import { presentWorkerContractAnswer } from "../../src/interactive/renderers/worker-answer.js";
import { loadProjectVerifierCatalog, parseProjectVerifierCatalogText } from "../../src/tools/verify/catalog.js";
import { verifyTool } from "../../src/tools/verify/index.js";
import { captureProofSnapshot, parseDeclaredProof } from "../../src/tools/verify/proof.js";
import { isolateDispatchState, makeDispatchBundle, restoreDispatchState } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";

const roots: string[] = [];
const originalCwd = process.cwd();
const goal = {
	id: "identity.post",
	target: "identity.c:identity",
	kind: "post",
	pre: "x is an int",
	post: "result == x",
	formula: "pre implies result == x",
};
const proof: DeclaredProof = { status: "mechanized", inputs: ["identity.c", "wrapper.py"], goals: [goal] };
const declaration = {
	id: "proof:identity",
	description: "Fixture wrapper, not a real prover",
	command: ["python3", "wrapper.py"],
	cwd: ".",
	timeoutMs: 10_000,
	tags: ["formal"],
	proof,
};
const catalog = JSON.stringify({ version: 2, checks: [declaration] });

function workspace(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "hoare-contract-")));
	roots.push(root);
	mkdirSync(join(root, ".clio-coder"));
	writeFileSync(join(root, ".clio-coder/verifiers.yaml"), catalog);
	writeFileSync(join(root, "identity.c"), "int identity(int x) { return x; }\n");
	writeFileSync(join(root, "wrapper.py"), "print('fixture only: no prover executed')\n");
	process.chdir(root);
	return root;
}

afterEach(() => {
	process.chdir(originalCwd);
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function report(status: HoareObligation["status"] = "mechanized", assurance: HoareAssurance = "mechanized") {
	const { id, ...fields } = goal;
	const passed = hoarePasses(assurance, status);
	return {
		verdict: passed ? "pass" : "fail",
		assurance,
		checks: [
			{
				name: id,
				passed,
				evidence: "Fixture contract: return the input; no ambient assumptions.",
				obligation: {
					...fields,
					status,
					...(status === "mechanized" || status === "modeled" ? { check: declaration.id } : {}),
				},
			},
		] satisfies [VerifierCheck],
	};
}

function validate(
	value: unknown,
	effects?: ReturnType<typeof createRunEffectsRecorder>,
	contract: ResultContract = { kind: "verifier-report", assurance: "mechanized" },
) {
	return validateResultContract({
		contract,
		output: JSON.stringify(value),
		cwd: process.cwd(),
		networkAllowed: false,
		filesystem: { readFile: () => null },
		...(effects === undefined ? {} : { observedRunEffects: effects.snapshot() }),
	});
}

function result(root: string, declared: DeclaredProof = proof) {
	return {
		details: {
			kind: "ok",
			proof: { check: declaration.id, proof: declared, snapshot: captureProofSnapshot(root, declared.inputs) },
		},
	};
}

function record(root: string, tool = "verify") {
	const effects = createRunEffectsRecorder(root);
	effects.start("call-1", tool, { check: declaration.id });
	effects.checkOutcome("call-1", "ok");
	effects.finish("call-1", false, result(root));
	return effects;
}

describe("Hoare contract honesty", () => {
	it("rejects an unobserved machine claim and accepts explicit unknown/fail repair", (t) => {
		const invalid = validate(report());
		strictEqual(invalid.conformance, "fail");
		match(invalid.reason ?? "", /unknown.*passed false.*verdict fail/u);
		const repaired = validate(report("unknown"));
		strictEqual(repaired.conformance, "pass");
		strictEqual(repaired.quality, "fail");
		t.diagnostic(
			`Rejected: ${invalid.reason}; repaired conformance=${repaired.conformance}, quality=${repaired.quality}`,
		);
	});

	it("accepts only exact observed goal, status and check identities", () => {
		const root = workspace();
		const effects = record(root);
		strictEqual(validate(report(), effects).conformance, "pass");
		for (const changed of [
			{ ...goal, formula: "different property" },
			{ ...goal, pre: "false" },
			{ ...goal, target: "other.c:identity" },
			{ ...goal, id: "another.goal" },
		]) {
			const candidate = report();
			const { id, ...fields } = changed;
			candidate.checks[0] = {
				...candidate.checks[0],
				name: id,
				obligation: { ...candidate.checks[0].obligation, ...fields },
			};
			strictEqual(validate(candidate, effects).conformance, "fail");
		}
		const wrongCheck = report();
		wrongCheck.checks[0].obligation.check = "proof:identity-extra";
		strictEqual(validate(wrongCheck, effects).conformance, "fail");
		strictEqual(validate(report("modeled"), effects).conformance, "fail");
	});

	it("enforces all assurance/status combinations, including assumed", () => {
		for (const assurance of HOARE_ASSURANCES) {
			for (const status of HOARE_STATUSES) {
				const expected =
					status === "mechanized" ||
					(status === "modeled" && assurance !== "mechanized") ||
					(status === "argued" && assurance === "argued");
				const output = report(status, assurance);
				strictEqual(output.checks[0].passed, expected);
				ok(parseVerifierResult(JSON.stringify(output)));
				output.checks[0].passed = !expected;
				output.verdict = expected ? "fail" : "pass";
				strictEqual(parseVerifierResult(JSON.stringify(output)), null);
			}
		}
	});

	it("rejects weaker policy, untyped, duplicate, empty and oversized obligations", () => {
		const output = report("unknown");
		for (const malformed of [
			report("argued", "argued"),
			{ ...output, assurance: undefined },
			{ ...output, checks: [] },
			{ ...output, checks: [output.checks[0], output.checks[0]] },
			{ ...output, checks: [{ name: "g", passed: false, evidence: "missing obligation" }] },
			{ ...output, checks: [{ ...output.checks[0], obligation: { ...output.checks[0].obligation, pre: " " } }] },
			{ ...output, checks: [{ ...output.checks[0], evidence: "x".repeat(32_768) }] },
		])
			strictEqual(validate(malformed).conformance, "fail");
		throws(() => parseResultContract({ kind: "verifier-report", assurance: "tests" }, "fixture"), /assurance/u);
		deepStrictEqual(parseResultContract({ kind: "verifier-report", assurance: "modeled" }, "fixture"), {
			kind: "verifier-report",
			assurance: "modeled",
		});
	});

	it("preserves ordinary verifier reports and does not mistake arguments for executed commands", () => {
		const ordinary = { verdict: "pass", checks: [{ name: "npm test", passed: true, evidence: "exit 0" }] };
		strictEqual(validate(ordinary, undefined, { kind: "verifier-report" }).conformance, "pass");
		strictEqual(
			groundClaimedValidations({
				contractKind: "verifier-report",
				output: JSON.stringify(report("argued", "argued")),
				executedCommands: new Set(),
				executedCheckingCalls: 0,
			}),
			null,
		);
	});

	it("requires paired successful native calls, not listings, bash, missing outcomes or other runs", () => {
		const root = workspace();
		for (const tool of ["bash", "read"]) strictEqual(validate(report(), record(root, tool)).conformance, "fail");
		const effects = createRunEffectsRecorder(root);
		effects.finish("unpaired", false, result(root));
		effects.start("listing", "verify", {});
		effects.checkOutcome("listing", "ok");
		effects.finish("listing", false, result(root));
		effects.start("missing-outcome", "verify", { check: declaration.id });
		effects.finish("missing-outcome", false, result(root));
		strictEqual(validate(report(), effects).conformance, "fail");
		strictEqual(validate(report(), createRunEffectsRecorder(root)).conformance, "fail");
	});

	it("invalidates earlier successes on later failed, blocked or unfinished attempts", () => {
		const root = workspace();
		for (const outcome of ["error", "blocked", null] as const) {
			const effects = record(root);
			effects.start("later", "verify", { check: declaration.id });
			if (outcome !== null) {
				effects.checkOutcome("later", outcome);
				effects.finish("later", true);
			}
			strictEqual(validate(report(), effects).conformance, "fail");
		}
	});

	it("does not resurrect an earlier overlapping call when it finishes last", () => {
		const root = workspace();
		const effects = createRunEffectsRecorder(root);
		effects.start("early", "verify", { check: declaration.id });
		effects.start("late", "verify", { check: declaration.id });
		effects.checkOutcome("late", "error");
		effects.finish("late", true);
		effects.checkOutcome("early", "ok");
		effects.finish("early", false, result(root));
		strictEqual(validate(report(), effects).conformance, "fail");
	});

	it("rechecks source, wrapper and catalog freshness at terminal validation", () => {
		const root = workspace();
		for (const file of ["identity.c", "wrapper.py", ".clio-coder/verifiers.yaml"]) {
			const original = readFileSync(join(root, file));
			const effects = record(root);
			writeFileSync(join(root, file), `${original.toString()}\n`);
			strictEqual(validate(report(), effects).conformance, "fail");
			writeFileSync(join(root, file), original);
		}
		const effects = record(root);
		rmSync(join(root, "wrapper.py"));
		strictEqual(validate(report(), effects).conformance, "fail");
	});

	it("binds gateway native-call evidence through the same paired recorder", () => {
		const root = workspace();
		const effects = createRunEffectsRecorder(root);
		recordToolExecutionEffects(effects, {
			type: "tool_execution_start",
			toolName: "gateway",
			toolCallId: "gateway-1",
			args: { op: "call", capability: "verify", args: { check: declaration.id } },
		});
		effects.checkOutcome("gateway-1", "ok");
		recordToolExecutionEffects(effects, {
			type: "tool_execution_end",
			toolName: "gateway",
			toolCallId: "gateway-1",
			isError: false,
			result: result(root),
		});
		strictEqual(validate(report(), effects).conformance, "pass");
		const chainResult = {
			details: {
				op: "chain",
				chainResults: [
					{
						id: "proof",
						capability: "verify",
						args: { check: declaration.id },
						isError: false,
						result: {
							details: {
								...result(root).details,
								chainAdmission: { outcome: "ok", decision: "allowed", actionClass: "execute" },
							},
						},
					},
				],
			},
		};
		const chain = createRunEffectsRecorder(root);
		const end = {
			type: "tool_execution_end",
			toolName: "gateway",
			toolCallId: "chain",
			result: chainResult,
			isError: false,
		};
		recordToolExecutionEffects(chain, end);
		strictEqual(validate(report(), chain).conformance, "fail", "unpaired chain receipt cannot prove a goal");
		recordToolExecutionEffects(chain, {
			type: "tool_execution_start",
			toolName: "gateway",
			toolCallId: "chain",
			args: { op: "chain", steps: [{ id: "proof", capability: "verify", args: { check: declaration.id } }] },
		});
		recordToolExecutionEffects(chain, end);
		strictEqual(validate(report(), chain).conformance, "pass");
	});

	it("preserves assurance and failed obligations through fleet prompts, repair findings and TUI", () => {
		const output = JSON.stringify(report("unknown"));
		match(
			renderFleetNodeTask("review", "verifier-report", "check", { kind: "verifier-report", assurance: "mechanized" }),
			/"assurance":"mechanized"/u,
		);
		const decision = decideReviewGate({
			group: "hoare",
			cycle: 1,
			terminalCycle: false,
			subjects: [],
			decider: { runId: "review", digest: null },
			correlation: { agent: false, target: false, modelFamily: false, runtime: true, node: true, independent: true },
			output,
			reviewer: { obligationUnmet: false },
		});
		deepStrictEqual(JSON.parse(decision.findings ?? "null"), JSON.parse(output));
		const rendered = presentWorkerContractAnswer(output, { kind: "verifier-report", conformance: "pass" }, true, true);
		match(rendered?.lines.join("\n") ?? "", /\[unknown\]/u);
		match(rendered?.footer ?? "", /assurance mechanized/u);
	});

	it("seals only grounded machine claims and enforces restrictive dispatch despite permissive settings", async () => {
		await isolateDispatchState();
		const root = workspace();
		try {
			for (const scenario of ["unobserved", "unknown", "observed"] as const) {
				const settings = structuredClone(DEFAULT_SETTINGS);
				settings.safety.sandbox = "off";
				settings.safety.sandboxNetwork = true;
				settings.fleet.retry.maxRetries = 0;
				const output = JSON.stringify(report(scenario === "unknown" ? "unknown" : "mechanized"));
				let spawns = 0;
				const bundle = makeDispatchBundle(dispatchStubContext({ settings }), {
					spawnWorker: (spec): SpawnedWorker => {
						spawns++;
						strictEqual(spec.envelope.write.mode, "none");
						strictEqual(spec.sandbox?.mode, "required");
						strictEqual(spec.sandbox?.network, false);
						deepStrictEqual(spec.sandbox?.writableRoots, []);
						return {
							pid: null,
							promise: Promise.resolve({ exitCode: 0, signal: null }),
							heartbeatAt: { current: Date.now(), monotonic: performance.now() },
							abort: () => {},
							send: () => true,
							events: (async function* () {
								if (scenario === "observed") {
									yield {
										type: "tool_execution_start",
										toolCallId: "check",
										toolName: "verify",
										args: { check: declaration.id },
									};
									yield {
										type: "clio_coder_tool_start",
										payload: { tool: "verify", toolCallId: "check", posture: "operating", startedAt: Date.now() },
									};
									yield {
										type: "clio_coder_tool_finish",
										payload: { tool: "verify", toolCallId: "check", posture: "operating", durationMs: 1, outcome: "ok" },
									};
									yield {
										type: "tool_execution_end",
										toolCallId: "check",
										toolName: "verify",
										isError: false,
										result: result(root),
									};
								}
								yield { type: "message_end", message: { role: "assistant", stopReason: "stop", content: output } };
							})(),
						};
					},
				});
				await bundle.extension.start();
				try {
					const run = await bundle.contract.dispatch({
						agentId: "verifier",
						executionRole: "verifier",
						task: "Review identity.c:identity",
						cwd: root,
						requestOrigin: "internal",
						resultContractOverride: { kind: "verifier-report", assurance: "mechanized" },
					});
					const receipt = await run.finalPromise;
					strictEqual(spawns, 1);
					strictEqual(receipt.quality.resultContract?.conformance, scenario === "unobserved" ? "fail" : "pass");
					if (scenario === "unknown") {
						strictEqual(verifierVerdict(receipt)?.verdict, "fail");
						strictEqual(verifierVerdict(receipt)?.failedChecks.length, 1);
					}
					if (scenario === "observed") strictEqual(verifierVerdict(receipt)?.verdict, "pass");
				} finally {
					await bundle.extension.stop?.();
				}
			}
		} finally {
			process.chdir(originalCwd);
			restoreDispatchState();
		}
	});
});

describe("declared proof execution", () => {
	it("accepts version-2 annotations and rejects unsafe or incomplete declarations", () => {
		const root = workspace();
		strictEqual(loadProjectVerifierCatalog(root).ok, true);
		strictEqual(parseProjectVerifierCatalogText(JSON.stringify({ version: 1, checks: [declaration] }), root).ok, false);
		for (const invalid of [
			{ ...proof, goals: [] },
			{ ...proof, goals: [goal, goal] },
			{ ...proof, status: "argued" },
			{ ...proof, inputs: ["wrapper.py"] },
			{ ...proof, inputs: ["../identity.c"] },
			{ ...proof, inputs: ["/identity.c"] },
			{ ...proof, goals: [{ ...goal, unexpected: true }] },
		])
			ok(parseDeclaredProof(invalid) instanceof Error);
		strictEqual(
			parseProjectVerifierCatalogText(
				JSON.stringify({
					version: 2,
					checks: [{ ...declaration, kind: "perf-budget", perf: { maxMs: 100 } }],
				}),
				root,
			).ok,
			false,
		);
	});

	it("fails closed on missing, oversized or symlinked proof inputs", () => {
		const root = workspace();
		throws(() => captureProofSnapshot(root, ["absent.c"]));
		writeFileSync(join(root, "large.c"), Buffer.alloc(1024 * 1024 + 1));
		throws(() => captureProofSnapshot(root, ["large.c"]), /byte limits/u);
		symlinkSync("identity.c", join(root, "alias.c"));
		throws(() => captureProofSnapshot(root, ["alias.c"]), /symbolic link/u);
		mkdirSync(join(root, "dir"));
		symlinkSync(".", join(root, "linked"));
		throws(() => captureProofSnapshot(root, ["linked/identity.c"]), /symbolic link/u);
		throws(() => captureProofSnapshot(root, ["dir"]), /regular file/u);
		throws(() => captureProofSnapshot(root, proof.inputs, "0".repeat(64)), /changed after check resolution/u);
	});

	it("executes a fixture wrapper contained or refuses explicitly, never runs it bare", async (t) => {
		const root = workspace();
		writeFileSync(
			join(root, "wrapper.py"),
			[
				"from pathlib import Path",
				"import os",
				"try:",
				"    Path('identity.c').write_text('unexpected mutation')",
				"except OSError:",
				"    pass",
				"else:",
				"    raise RuntimeError('workspace writable')",
				`assert os.readlink('/proc/self/ns/net') != ${JSON.stringify(process.platform === "linux" ? readlinkSync("/proc/self/ns/net") : "")}`,
				"print('fixture only, containment exercised; not a prover')",
			].join("\n"),
		);
		const execution = await verifyTool.run({ check: declaration.id });
		t.diagnostic(
			execution.kind === "ok"
				? "Native fixture ran with read-only source and a distinct network namespace; no real prover executed."
				: `Native fixture refused: ${execution.message}`,
		);
		strictEqual(readFileSync(join(root, "identity.c"), "utf8"), "int identity(int x) { return x; }\n");
		if (execution.kind === "error") {
			match(execution.message, /sandbox|bwrap|namespace|Operation not permitted/u);
			strictEqual(execution.details?.proof, undefined);
		} else {
			ok(execution.details?.proof);
			const effects = createRunEffectsRecorder(root);
			effects.start("native-fixture", "verify", { check: declaration.id });
			effects.checkOutcome("native-fixture", "ok");
			effects.finish("native-fixture", false, execution);
			strictEqual(validate(report(), effects).conformance, "pass");
		}
	});
});
