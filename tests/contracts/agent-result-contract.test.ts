import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	parseScoutResult,
	resultContractAuthorship,
	validateRecipeResult,
	validateResultContract,
} from "../../src/domains/agents/result-contract.js";
import { resultContractWasDue } from "../../src/domains/dispatch/outcome.js";
import { withReceiptIntegrity } from "../../src/domains/dispatch/receipt-integrity.js";
import { reduceRouteQuality } from "../../src/domains/dispatch/route-quality.js";
import type { RunEnvelope, RunReceiptDraft } from "../../src/domains/dispatch/types.js";

const filesystem = { readFile: (_path: string): string | null => null };

function contract(input: Parameters<typeof validateResultContract>[0]) {
	return validateResultContract(input);
}

function receiptWithQuality(quality: "pass" | "fail" | "unmeasured") {
	const envelope: RunEnvelope = {
		id: "run-verifier",
		agentId: "verifier",
		executionRole: "builder",
		task: "verify",
		targetId: "target",
		wireModelId: "model",
		runtimeId: "runtime",
		runtimeKind: "http",
		startedAt: "2026-01-01T00:00:00.000Z",
		endedAt: "2026-01-01T00:00:01.000Z",
		status: "completed",
		outcome: "succeeded",
		exitCode: 0,
		pid: null,
		heartbeatAt: null,
		receiptPath: "/tmp/run-verifier.json",
		sessionId: null,
		cwd: "/tmp",
		tokenCount: 0,
		costUsd: 0,
	};
	const draft: RunReceiptDraft = {
		runId: envelope.id,
		agentId: envelope.agentId,
		executionRole: "builder",
		task: envelope.task,
		targetId: envelope.targetId,
		wireModelId: envelope.wireModelId,
		runtimeId: envelope.runtimeId,
		runtimeKind: envelope.runtimeKind,
		startedAt: envelope.startedAt,
		endedAt: envelope.endedAt ?? envelope.startedAt,
		outcome: "succeeded",
		exitCode: 0,
		tokenCount: 0,
		costUsd: 0,
		costProvenance: "unknown",
		compiledPromptHash: null,
		staticCompositionHash: null,
		clioVersion: "0.0.0",
		piMonoVersion: "0.0.0",
		platform: "test",
		nodeVersion: "test",
		toolCalls: 0,
		toolStats: [],
		verification: { state: "unverified", basis: "no-validation-tool" },
		routingIntent: {
			posture: "balanced",
			maxCostUsd: null,
			deadlineMs: null,
			minimumQuality: null,
			requiredCapabilities: [],
			locality: "any",
			failover: "none",
		},
		quality: {
			version: 1,
			typedValidations: [],
			responseSchema: { sourceId: null, schemaDigest: null, runtimeEnforceable: false, enforcementPassed: null },
			resultContract: {
				sourceId: "agent-result-contract:verifier-report:test",
				validatorDigest: "a".repeat(64),
				conformance: "pass",
				quality,
			},
		},
		sessionId: null,
	};
	return { receipt: withReceiptIntegrity(draft, envelope), envelope };
}

describe("contracts/agent result contract", () => {
	it("architect must produce the declared plan artifact", () => {
		const missing = contract({
			contract: { kind: "architect-plan", path: "PLAN.md" },
			output: "{}",
			cwd: "/repo",
			networkAllowed: false,
			filesystem,
		});
		strictEqual(missing.conformance, "fail");
		const present = contract({
			contract: { kind: "architect-plan", path: "PLAN.md" },
			output: "{}",
			cwd: "/repo",
			networkAllowed: false,
			filesystem: { readFile: (path) => (path === "/repo/PLAN.md" ? "# Plan\n" : null) },
		});
		strictEqual(present.conformance, "pass");
		strictEqual(present.quality, "unmeasured");
	});

	it("scout structured citations validate and prose sentinels do not", () => {
		const structured = JSON.stringify({
			findings: [],
			needsSplit: true,
			proposedSubtasks: [
				{
					id: "inspect-a",
					task: "Inspect src/a.ts",
					dependencies: [],
					expectedResultContract: "scout-report",
					requestedAuthority: "read-only",
				},
			],
		});
		strictEqual(parseScoutResult(structured)?.needsSplit, true);
		strictEqual(
			contract({
				contract: { kind: "scout-report" },
				output: structured,
				cwd: "/repo",
				networkAllowed: false,
				filesystem: { readFile: (path) => (path === "/repo/src/a.ts" ? "one\ntwo\nthree\nfour" : null) },
			}).quality,
			"pass",
		);
		strictEqual(parseScoutResult("SPLIT RECOMMENDATION: prose\n- Inspect src/a.ts"), null);
		strictEqual(
			parseScoutResult(JSON.stringify({ findings: [], needsSplit: true, proposedSubtasks: ["Inspect src/a.ts"] })),
			null,
		);
		strictEqual(
			parseScoutResult(
				JSON.stringify({
					findings: [],
					needsSplit: true,
					proposedSubtasks: [
						{
							id: "inject",
							task: "Inspect",
							dependencies: [],
							expectedResultContract: "scout-report",
							requestedAuthority: "read-only",
							agent: "coder",
						},
					],
				}),
			),
			null,
		);
	});

	it("rejects a scout citation to a real line the run never read", () => {
		const file = "one\ntwo\nthree\nfour\nfive\nsix";
		const filesystem = { readFile: (p: string) => (p === "/repo/src/a.ts" ? file : null) };
		const cited = (line: number) =>
			JSON.stringify({
				findings: [{ claim: "the boundary is declared here", path: "src/a.ts", line }],
				needsSplit: false,
				proposedSubtasks: [],
			});
		// The run read lines 1..3 only. Line 5 exists, so the existence check
		// alone would pass it; grounding is what rejects the approximation.
		const observedReadRanges = new Map([["/repo/src/a.ts", [[1, 3] as const]]]);
		const grounded = contract({
			contract: { kind: "scout-report" },
			output: cited(2),
			cwd: "/repo",
			networkAllowed: false,
			filesystem,
			observedReadRanges,
		});
		strictEqual(grounded.conformance, "pass");
		const drifted = contract({
			contract: { kind: "scout-report" },
			output: cited(5),
			cwd: "/repo",
			networkAllowed: false,
			filesystem,
			observedReadRanges,
		});
		strictEqual(drifted.conformance, "fail");
		ok(drifted.reason?.includes("not grounded in a live read"));
		ok(drifted.reason?.includes("this run read only 1-3"));
		const unread = contract({
			contract: { kind: "scout-report" },
			output: cited(2),
			cwd: "/repo",
			networkAllowed: false,
			filesystem,
			observedReadRanges: new Map(),
		});
		strictEqual(unread.conformance, "fail");
		ok(unread.reason?.includes("this run never read that file"));
		// Absent evidence keeps the weaker existence check; the orchestrator
		// revalidates shape without access to the worker's read spans.
		strictEqual(
			contract({
				contract: { kind: "scout-report" },
				output: cited(5),
				cwd: "/repo",
				networkAllowed: false,
				filesystem,
			}).conformance,
			"pass",
		);
	});

	it("rejects a mutation report naming a path the run never wrote and that does not exist", () => {
		// Receipt 3queklvuxnmb: a git-master run answering a read-only question
		// returned the shape example verbatim, and `src/file.ts` existed nowhere
		// in that repository. Shape alone sealed conformance and quality pass.
		const output = JSON.stringify({
			mutatedPaths: ["src/file.ts"],
			validations: [{ name: "git status check", passed: true, evidence: "master branch with clean working tree" }],
		});
		const readOnlyRun = {
			contract: { kind: "mutation-report" } as const,
			output,
			cwd: "/repo",
			networkAllowed: false,
			filesystem: { readFile: () => null, pathExists: () => false },
			observedRunEffects: {
				mutatedPaths: new Set<string>(),
				failedMutationPaths: new Set<string>(),
				validationCommands: new Set<string>(),
			},
		};
		const fabricated = contract(readOnlyRun);
		strictEqual(fabricated.conformance, "fail");
		ok(fabricated.reason?.includes("never wrote and that does not exist: src/file.ts"));
		ok(fabricated.reason?.includes("this run wrote nothing"));
		// The same report from a run that did write the file is the postcondition
		// the contract exists to certify.
		strictEqual(
			contract({
				...readOnlyRun,
				observedRunEffects: {
					mutatedPaths: new Set(["/repo/src/file.ts"]),
					failedMutationPaths: new Set<string>(),
					validationCommands: new Set(["npm test"]),
				},
			}).conformance,
			"pass",
		);
		// Absent evidence keeps the report's own word, which is what every caller
		// that cannot observe the run's effects still gets.
		strictEqual(
			contract({ contract: { kind: "mutation-report" }, output, cwd: "/repo", networkAllowed: false, filesystem })
				.conformance,
			"pass",
		);
	});

	it("a mutation this run cannot account for is unmeasured rather than passed", () => {
		const output = JSON.stringify({
			mutatedPaths: ["src/generated.ts"],
			validations: [{ name: "npm test", passed: true, evidence: "exit 0" }],
		});
		const run = (effects: {
			mutatedPaths: Set<string>;
			failedMutationPaths?: Set<string>;
			validationCommands: Set<string>;
		}) =>
			contract({
				contract: { kind: "mutation-report" },
				output,
				cwd: "/repo",
				networkAllowed: false,
				// The file is on disk, so it is not a fabrication.
				filesystem: { readFile: () => null, pathExists: (p: string) => p === "/repo/src/generated.ts" },
				observedRunEffects: { failedMutationPaths: new Set<string>(), ...effects },
			});
		// Written through a channel no tool event enumerates (a script the run
		// executed): the postcondition holds, but nothing here measured it.
		const unenumerable = run({ mutatedPaths: new Set(), validationCommands: new Set(["npm test"]) });
		strictEqual(unenumerable.conformance, "pass");
		strictEqual(unenumerable.quality, "unmeasured");
		// A validation the run never ran is not correctness evidence either.
		const unrunValidation = run({ mutatedPaths: new Set(["/repo/src/generated.ts"]), validationCommands: new Set() });
		strictEqual(unrunValidation.conformance, "pass");
		strictEqual(unrunValidation.quality, "unmeasured");
		// Both grounded is the only shape that reaches the routing denominator.
		const grounded = run({
			mutatedPaths: new Set(["/repo/src/generated.ts"]),
			validationCommands: new Set(["npm test"]),
		});
		strictEqual(grounded.quality, "pass");
		const { receipt, envelope } = receiptWithQuality(grounded.quality);
		strictEqual(reduceRouteQuality({ subject: { receipt, envelope }, receipts: [] }).label, "pass");
	});

	it("rejects a mutation report claiming a file whose write this run was refused", () => {
		// Receipt 182h2ai478p5: the coder's edit was denied by the worker
		// permission policy, src/math.js was left byte-identical, and the report
		// still named it. Presence on disk cannot separate that from a real edit;
		// the run's own refused tool result can.
		const refused = contract({
			contract: { kind: "mutation-report" },
			output: JSON.stringify({
				mutatedPaths: ["src/math.js"],
				validations: [{ name: "npm test", passed: true, evidence: "exit 0" }],
			}),
			cwd: "/repo",
			networkAllowed: false,
			filesystem: { readFile: () => "export function add() {}", pathExists: () => true },
			observedRunEffects: {
				mutatedPaths: new Set<string>(),
				failedMutationPaths: new Set(["/repo/src/math.js"]),
				validationCommands: new Set<string>(),
			},
		});
		strictEqual(refused.conformance, "fail");
		ok(refused.reason?.includes("only write this run attempted was refused: src/math.js"));
	});

	it("a self-reported validation failure still seals failed quality", () => {
		// Reporting against your own interest is the one claim here that needs no
		// corroboration, so ungrounded effects must not soften it to unmeasured.
		const failed = contract({
			contract: { kind: "mutation-report" },
			output: JSON.stringify({
				mutatedPaths: [],
				validations: [{ name: "npm test", passed: false, evidence: "1 failing" }],
			}),
			cwd: "/repo",
			networkAllowed: false,
			filesystem: { readFile: () => null, pathExists: () => false },
			observedRunEffects: {
				mutatedPaths: new Set<string>(),
				failedMutationPaths: new Set<string>(),
				validationCommands: new Set<string>(),
			},
		});
		strictEqual(failed.conformance, "pass");
		strictEqual(failed.quality, "fail");
	});

	it("verifier check failure becomes failed quality evidence", () => {
		const validation = contract({
			contract: { kind: "verifier-report" },
			output: JSON.stringify({ verdict: "fail", checks: [{ name: "typecheck", passed: false, evidence: "TS error" }] }),
			cwd: "/repo",
			networkAllowed: false,
			filesystem,
		});
		strictEqual(validation.quality, "fail");
		const { receipt, envelope } = receiptWithQuality(validation.quality);
		strictEqual(reduceRouteQuality({ subject: { receipt, envelope }, receipts: [] }).label, "fail");
	});

	it("artifact existence without a correctness validator is not a quality pass", () => {
		const validation = contract({
			contract: { kind: "architect-plan", path: "PLAN.md" },
			output: "{}",
			cwd: "/repo",
			networkAllowed: false,
			filesystem: { readFile: () => "# Plan" },
		});
		strictEqual(validation.conformance, "pass");
		strictEqual(validation.quality, "unmeasured");
	});

	it("an unreached contract is not-reached rather than failed", () => {
		const unreached = validateRecipeResult({
			contract: { kind: "scout-report" },
			reachedTerminalResult: false,
			output: null,
			cwd: "/repo",
			networkAllowed: false,
			filesystem,
		});
		ok(unreached !== null);
		strictEqual(unreached.applicable, false);
		strictEqual(unreached.fact.conformance, "not-reached");
		strictEqual(unreached.fact.quality, "unmeasured");
		// The contract identity survives so offline replay still knows which
		// postcondition was in force for the attempt that never produced one.
		ok(unreached.fact.sourceId.startsWith("agent-result-contract:scout-report:"));
	});

	it("a due contract with no result is a genuine failure", () => {
		const due = validateRecipeResult({
			contract: { kind: "scout-report" },
			reachedTerminalResult: true,
			output: null,
			cwd: "/repo",
			networkAllowed: false,
			filesystem,
		});
		ok(due !== null);
		ok(due.applicable);
		strictEqual(due.fact.conformance, "fail");
		strictEqual(due.fact.quality, "fail");
	});

	it("infrastructure terminations leave the contract undue", () => {
		// Every shape observed in real route history that produced a fabricated
		// quality failure: operator abort, worker crash, model residency
		// failure, stall kill, and the engine loop guard.
		strictEqual(resultContractWasDue("canceled", null), false);
		strictEqual(resultContractWasDue("failed", null), false);
		strictEqual(resultContractWasDue("failed", "vram_capacity_fit_failure"), false);
		strictEqual(resultContractWasDue("stalled", null), false);
		strictEqual(resultContractWasDue("failed", "loop_guard_tools_disabled_exhausted"), false);
		// The two shapes where the model did get its chance.
		strictEqual(resultContractWasDue("succeeded", null), true);
		strictEqual(resultContractWasDue("failed", "result_contract_exhausted"), true);
	});

	it("external research requires an allowed network posture", () => {
		const input = JSON.stringify({ source: "external", findings: [{ claim: "Fact", evidence: "https://example.test" }] });
		strictEqual(
			contract({ contract: { kind: "research-report" }, output: input, cwd: "/repo", networkAllowed: false, filesystem })
				.conformance,
			"fail",
		);
		strictEqual(
			contract({ contract: { kind: "research-report" }, output: input, cwd: "/repo", networkAllowed: true, filesystem })
				.conformance,
			"pass",
		);
	});

	it("an optional authored field left empty is absent rather than malformed", () => {
		const mutation = (authorship: string) =>
			contract({
				contract: { kind: "mutation-report" },
				output: `{"mutatedPaths":["src/a.ts"],"validations":[{"name":"npm test","passed":true,"evidence":"exit 0"}]${authorship}}`,
				cwd: "/repo",
				networkAllowed: false,
				filesystem,
			});
		// A blank string and an explicit null are how a model spells "I authored
		// no commit message". `resultContractAuthorship` reads both as absent, so
		// validation that failed the run on them ended a finished run over an
		// optional field the agent correctly left empty.
		strictEqual(mutation(',"commitMessage":"","summary":""').conformance, "pass");
		strictEqual(mutation(',"commitMessage":null,"summary":null').conformance, "pass");
		strictEqual(mutation(',"commitMessage":"   "').conformance, "pass");
		strictEqual(mutation("").conformance, "pass");
		// A non-string is still a shape error: only the emptiness spellings are absent.
		const wrongShape = mutation(',"commitMessage":42');
		strictEqual(wrongShape.conformance, "fail");
		ok(wrongShape.reason?.includes("commitMessage must be a string when present"));
	});

	it("an empty authored field reads as no authored message", () => {
		const output = '{"mutatedPaths":[],"validations":[],"commitMessage":"","summary":""}';
		strictEqual(resultContractAuthorship({ kind: "mutation-report" }, output).commitMessage, null);
		strictEqual(resultContractAuthorship({ kind: "mutation-report" }, output).summary, null);
	});
});
