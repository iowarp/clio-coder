import { strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { parseScoutResult, validateResultContract } from "../../src/domains/agents/result-contract.js";
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
			citations: [{ path: "src/a.ts", line: 4 }],
			needsSplit: true,
			proposedSubtasks: ["Inspect src/a.ts"],
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
