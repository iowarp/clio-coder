import { ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	parseScoutResult,
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
});
