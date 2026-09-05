import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { finishContractEvidenceTags } from "../../src/domains/evidence/finish-contract-map.js";
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

	it("projects the limitation kind onto the completion-evidence tag", () => {
		deepStrictEqual(finishContractEvidenceTags("limitation"), ["completion-evidence"]);
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
