import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { FINISH_CONTRACT_EVIDENCE_TAGS } from "../../src/domains/evidence/finish-contract-map.js";
import { composeTrustStatus } from "../../src/domains/evidence/trust-status.js";
import { assessFinishContract } from "../../src/domains/safety/finish-contract.js";
import { builtin } from "../../src/tools/builtin-tool-catalog.js";
import { limitationTool } from "../../src/tools/limitation.js";
import { validateBuiltinToolPolicy } from "../../src/tools/policy.js";

const SOURCE = { source: "builtin" } as never;

function userMessage(turnId: string): unknown {
	return { kind: "message", role: "user", turnId, payload: { text: "change the file" } };
}

function assistantMessage(turnId: string, text: string): unknown {
	return { kind: "message", role: "assistant", turnId, payload: { text, stopReason: "stop" } };
}

function toolCall(toolCallId: string, name: string, args: Record<string, unknown>): unknown {
	return { kind: "message", role: "tool_call", turnId: toolCallId, payload: { name, toolCallId, args } };
}

function toolResult(toolCallId: string, toolName: string, isError: boolean): unknown {
	return {
		kind: "message",
		role: "tool_result",
		turnId: toolCallId,
		payload: { toolName, toolCallId, isError, result: isError ? { kind: "error" } : { kind: "ok" } },
	};
}

/** A window that mutated one file and recorded no validation evidence. */
function mutationWindow(): unknown[] {
	return [
		userMessage("user-1"),
		toolCall("write-1", ToolNames.Write, { path: "src/thing.ts", content: "x" }),
		toolResult("write-1", ToolNames.Write, false),
	];
}

describe("finish contract: the limitation receipt replaces the prose regex", () => {
	it("settles ok/explicit_limitation on a mutation plus a successful limitation receipt", () => {
		const entries = [
			...mutationWindow(),
			toolCall("lim-1", ToolNames.Limitation, {
				scope: "tests could not run",
				reason: "no-runner",
				paths: ["src/thing.ts"],
			}),
			toolResult("lim-1", ToolNames.Limitation, false),
			assistantMessage("assistant-1", "Edited src/thing.ts."),
		];
		const assessment = assessFinishContract({ sessionEntries: entries, assistantTurnId: "assistant-1" });
		strictEqual(assessment.kind, "ok");
		strictEqual(assessment.reason, "explicit_limitation");
		deepStrictEqual(assessment.mutatedPaths, ["src/thing.ts"]);
		strictEqual(assessment.evidence.length, 1);
		const [evidence] = assessment.evidence;
		strictEqual(evidence?.kind, "limitation");
		strictEqual(evidence?.turnId, "lim-1");
		ok(evidence?.summary.includes("tests could not run"), evidence?.summary);
		ok(evidence?.summary.includes("reason=no-runner"), evidence?.summary);
	});

	it("still engages when the limitation call errored, so a rejected call leaves no receipt", () => {
		const entries = [
			...mutationWindow(),
			toolCall("lim-1", ToolNames.Limitation, { scope: "tests could not run", reason: "nope" }),
			toolResult("lim-1", ToolNames.Limitation, true),
			assistantMessage("assistant-1", "Edited src/thing.ts; tests not verified."),
		];
		const assessment = assessFinishContract({ sessionEntries: entries, assistantTurnId: "assistant-1" });
		strictEqual(assessment.kind, "engage");
		strictEqual(assessment.reason, "unvalidated_mutation");
		deepStrictEqual(assessment.evidence, []);
	});

	it("engages on prose such as 'not verified' when no limitation receipt exists", () => {
		const entries = [
			...mutationWindow(),
			assistantMessage(
				"assistant-1",
				"Edited src/thing.ts. Tests: not run. This change is not verified and could not be tested.",
			),
		];
		const assessment = assessFinishContract({ sessionEntries: entries, assistantTurnId: "assistant-1" });
		strictEqual(assessment.kind, "engage");
		strictEqual(assessment.reason, "unvalidated_mutation");
	});

	it("ignores a limitation receipt that landed before the last user message", () => {
		const entries = [
			toolCall("lim-0", ToolNames.Limitation, { scope: "earlier turn", reason: "blocked" }),
			toolResult("lim-0", ToolNames.Limitation, false),
			...mutationWindow(),
			assistantMessage("assistant-1", "Edited src/thing.ts."),
		];
		const assessment = assessFinishContract({ sessionEntries: entries, assistantTurnId: "assistant-1" });
		strictEqual(assessment.kind, "engage");
	});

	it("keeps validation evidence ahead of a limitation receipt in the decision order", () => {
		const entries = [
			...mutationWindow(),
			toolCall("bash-1", ToolNames.Bash, { command: "npm test" }),
			toolResult("bash-1", ToolNames.Bash, false),
			toolCall("lim-1", ToolNames.Limitation, { scope: "lint skipped", reason: "out-of-scope" }),
			toolResult("lim-1", ToolNames.Limitation, false),
			assistantMessage("assistant-1", "Done."),
		];
		const assessment = assessFinishContract({ sessionEntries: entries, assistantTurnId: "assistant-1" });
		strictEqual(assessment.kind, "ok");
		strictEqual(assessment.reason, "validation_evidence");
	});

	it("accepts a successful native Node test receipt after an edit but not a failed test", () => {
		for (const isError of [false, true]) {
			const entries = [
				...mutationWindow(),
				toolCall("node-test", ToolNames.Bash, { command: "node --test sum.test.mjs" }),
				toolResult("node-test", ToolNames.Bash, isError),
				assistantMessage("assistant-1", "Test run completed."),
			];
			const assessment = assessFinishContract({ sessionEntries: entries, assistantTurnId: "assistant-1" });
			strictEqual(assessment.reason, isError ? "unvalidated_mutation" : "validation_evidence");
		}
	});

	it("requires verified and validated canonical dispatch evidence, not just a zero exit code", () => {
		const trusted = composeTrustStatus({
			artifactIntegrity: {
				state: "verified",
				source: { kind: "receipt_integrity_verification", id: "run-1" },
				authority: { kind: "clio", id: "receipt-integrity" },
				artifacts: [],
			},
			validationGrounding: {
				state: "validated",
				source: { kind: "run_receipt", id: "run-1" },
				authority: { kind: "validator", id: "receipt-quality" },
				artifacts: [],
			},
		});
		const run = { runId: "run-1", agentId: "verifier", exitCode: 0, trustStatus: trusted };
		const failed = {
			...run,
			trustStatus: { ...trusted, validationGrounding: { ...trusted.validationGrounding, state: "failed" } },
		};
		const candidates: Array<{ details: Record<string, unknown>; passed: boolean }> = [
			{ details: run, passed: true },
			{ details: { runs: [run], failedCount: 0 }, passed: true },
			{ details: failed, passed: false },
			{ details: { runs: [run, failed], failedCount: 0 }, passed: false },
			{ details: { ...run, trustStatus: null }, passed: false },
			{ details: { ...run, trustStatus: composeTrustStatus() }, passed: false },
			{
				details: {
					...run,
					trustStatus: { ...trusted, validationGrounding: { ...trusted.validationGrounding, state: "ungrounded" } },
				},
				passed: false,
			},
			{
				details: {
					...run,
					trustStatus: { ...trusted, artifactIntegrity: { ...trusted.artifactIntegrity, state: "failed" } },
				},
				passed: false,
			},
			// Preserve compatibility for historical ledgers without canonical trust fields.
			{ details: { runId: "old", agentId: "verifier", exitCode: 0 }, passed: true },
		];
		for (const { details, passed } of candidates) {
			const entries = [
				...mutationWindow(),
				toolCall("dispatch-1", ToolNames.Dispatch, { agent_id: "verifier", task: "Verify the edit" }),
				{
					kind: "message",
					role: "tool_result",
					payload: { toolName: "dispatch", toolCallId: "dispatch-1", result: { details } },
				},
				assistantMessage("assistant-1", "Review finished."),
			];
			const assessment = assessFinishContract({ sessionEntries: entries, assistantTurnId: "assistant-1" });
			strictEqual(assessment.reason, passed ? "validation_evidence" : "unvalidated_mutation", JSON.stringify(details));
		}
	});

	it("projects the limitation kind onto the completion-evidence tag", () => {
		deepStrictEqual(FINISH_CONTRACT_EVIDENCE_TAGS.limitation, ["completion-evidence"]);
	});
});

describe("the limitation tool", () => {
	it("rejects a reason outside the enum", async () => {
		const result = await limitationTool.run({ scope: "tests could not run", reason: "because" });
		strictEqual(result.kind, "error");
		ok(result.kind === "error" && result.message.includes("reason must be one of"), JSON.stringify(result));
	});

	it("rejects an empty scope", async () => {
		const result = await limitationTool.run({ scope: "  ", reason: "blocked" });
		strictEqual(result.kind, "error");
	});

	it("records scope, reason, and paths in the result details", async () => {
		const result = await limitationTool.run({
			scope: "integration tests need a database",
			reason: "environment",
			paths: ["src/db.ts", "src/db.ts", " tests/db.test.ts "],
		});
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") return;
		deepStrictEqual(result.details?.limitation, {
			scope: "integration tests need a database",
			reason: "environment",
			paths: ["src/db.ts", "tests/db.test.ts"],
		});
		ok(result.output.startsWith("limitation recorded: "), result.output);
	});

	it("is read class, parallel, and agrees with the classifier and plane table", () => {
		strictEqual(limitationTool.baseActionClass, "read");
		strictEqual(limitationTool.executionMode, "parallel");
		const errors = validateBuiltinToolPolicy([builtin(limitationTool, SOURCE)]).filter((error: string) =>
			error.includes(ToolNames.Limitation),
		);
		deepStrictEqual(errors, []);
	});
});
