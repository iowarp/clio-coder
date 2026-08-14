import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";

import claudeCodeRuntime from "../../src/domains/providers/runtimes/claude/claude-code.js";
import type { ToolCallAuditInput } from "../../src/domains/safety/audit.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import { buildAgyArgs } from "../../src/engine/antigravity/subprocess-runtime.js";
import {
	claudeSdkPermissionModeForAutonomy,
	claudeSdkToolsForAutonomy,
	createClaudeWorkerBudgetGate,
	decideClaudeSdkToolUseOnce,
} from "../../src/engine/claude/sdk-runtime.js";
import {
	buildClaudeCodeArgs,
	claudeSubprocessPermissionConfigForAutonomy,
} from "../../src/engine/claude/subprocess-runtime.js";
import {
	type ClaudeToolPermissionDecision,
	claudeToolsOutsideProfile,
	type EvaluateClaudeToolPermissionInput,
	emitClaudeToolPermissionDecision,
	evaluateClaudeToolPermission,
} from "../../src/engine/claude/tool-safety.js";
import type { ClioWorkerEvent } from "../../src/engine/worker-events.js";
import type { WorkerRunInput } from "../../src/engine/worker-runtime.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";

describe("contracts/claude runtimes safety bridge", () => {
	function decide(
		toolName: string,
		input: Record<string, unknown>,
		autonomy: EvaluateClaudeToolPermissionInput["autonomy"],
	) {
		const request: EvaluateClaudeToolPermissionInput = {
			toolName,
			input,
			safety: createWorkerSafety({ cwd: process.cwd() }),
			cwd: process.cwd(),
		};
		if (autonomy !== undefined) request.autonomy = autonomy;
		return evaluateClaudeToolPermission(request);
	}

	it("routes Claude SDK tool permissions through the current Clio autonomy matrix", () => {
		const readOnlyRead = decide("Read", { file_path: "README.md" }, "read-only");
		strictEqual(readOnlyRead.kind, "allow");
		strictEqual(readOnlyRead.decision.classification.actionClass, "read");

		const readOnlyWrite = decide("Write", { file_path: "tmp/claude-test.txt", content: "x" }, "read-only");
		strictEqual(readOnlyWrite.kind, "deny");
		strictEqual(readOnlyWrite.decision.kind, "block");
		strictEqual(readOnlyWrite.decision.classification.actionClass, "write");

		const suggestWrite = decide("Write", { file_path: "tmp/claude-test.txt", content: "x" }, "suggest");
		strictEqual(suggestWrite.kind, "deny");
		strictEqual(suggestWrite.permissionRequired, true);
		strictEqual(suggestWrite.decision.kind, "ask");

		const autoEditWrite = decide(
			"Edit",
			{ file_path: "tmp/claude-test.txt", old_string: "a", new_string: "b" },
			"auto-edit",
		);
		strictEqual(autoEditWrite.kind, "allow");
		strictEqual(autoEditWrite.decision.classification.actionClass, "write");

		const recognizedExecute = decide("Bash", { command: "pwd" }, "auto-edit");
		strictEqual(recognizedExecute.kind, "allow");
		strictEqual(recognizedExecute.decision.classification.actionClass, "execute");

		const unrecognizedAutoEdit = decide("Bash", { command: 'node -e "console.log(1)"' }, "auto-edit");
		strictEqual(unrecognizedAutoEdit.kind, "deny");
		strictEqual(unrecognizedAutoEdit.permissionRequired, true);
		strictEqual(unrecognizedAutoEdit.decision.kind, "ask");

		const unrecognizedFullAuto = decide("Bash", { command: 'node -e "console.log(1)"' }, "full-auto");
		strictEqual(unrecognizedFullAuto.kind, "allow");

		const systemModify = decide("Bash", { command: "sudo true" }, "full-auto");
		strictEqual(systemModify.kind, "deny");
		strictEqual(systemModify.permissionRequired, true);
		strictEqual(systemModify.decision.kind, "ask");
		strictEqual(systemModify.decision.classification.actionClass, "system_modify");
		strictEqual(systemModify.decision.policy?.reasonCode, "system-modify-confirm");
		strictEqual(systemModify.decision.policy?.policySource, "builtin-classifier");
	});

	it("emits autonomy:<level> reasonCode on the clio_tool_finish telemetry for read-only denials", () => {
		const events: ClioWorkerEvent[] = [];
		const decision = emitClaudeToolPermissionDecision({
			toolName: "Write",
			input: { file_path: "tmp/claude-test.txt", content: "x" },
			safety: createWorkerSafety({ cwd: process.cwd() }),
			cwd: process.cwd(),
			autonomy: "read-only",
			emit: (event) => events.push(event),
		});
		strictEqual(decision.kind, "deny");

		const finish = events.find((event) => event.type === "clio_tool_finish");
		ok(finish && finish.type === "clio_tool_finish");
		strictEqual(finish.payload.decision, "blocked");
		strictEqual(finish.payload.outcome, "blocked");
		// The final reasonCode must describe the autonomy axis, not repeat the
		// policy engine's net-pass "allowed". Matches the native registry audit.
		strictEqual(finish.payload.reasonCode, "autonomy:read-only");

		const allowEvents: ClioWorkerEvent[] = [];
		emitClaudeToolPermissionDecision({
			toolName: "Read",
			input: { file_path: "README.md" },
			safety: createWorkerSafety({ cwd: process.cwd() }),
			cwd: process.cwd(),
			autonomy: "read-only",
			emit: (event) => allowEvents.push(event),
		});
		const allowFinish = allowEvents.find((event) => event.type === "clio_tool_finish");
		ok(allowFinish && allowFinish.type === "clio_tool_finish");
		strictEqual(allowFinish.payload.decision, "allowed");
		strictEqual(allowFinish.payload.reasonCode, "allowed");

		const systemModifyEvents: ClioWorkerEvent[] = [];
		const systemModify = emitClaudeToolPermissionDecision({
			toolName: "Bash",
			input: { command: "sudo true" },
			safety: createWorkerSafety({ cwd: process.cwd() }),
			cwd: process.cwd(),
			autonomy: "full-auto",
			emit: (event) => systemModifyEvents.push(event),
		});
		strictEqual(systemModify.kind, "deny");
		ok(systemModify.kind === "deny" && systemModify.permissionRequired);
		const systemModifyFinish = systemModifyEvents.find((event) => event.type === "clio_tool_finish");
		ok(systemModifyFinish && systemModifyFinish.type === "clio_tool_finish");
		strictEqual(systemModifyFinish.payload.decision, "permission_requested");
		strictEqual(systemModifyFinish.payload.reasonCode, "system-modify-confirm");
		strictEqual(systemModifyFinish.payload.policySource, "builtin-classifier");
		strictEqual(systemModifyFinish.payload.ruleId, "system-modify-confirm");
	});

	it("keeps SDK permission mode open for the Clio all-tool gate", () => {
		strictEqual(claudeSdkPermissionModeForAutonomy("read-only"), "default");
		strictEqual(claudeSdkPermissionModeForAutonomy("suggest"), "default");
		strictEqual(claudeSdkPermissionModeForAutonomy("auto-edit"), "default");
		strictEqual(claudeSdkPermissionModeForAutonomy("full-auto"), "default");
		deepStrictEqual(claudeSdkToolsForAutonomy("read-only"), { type: "preset", preset: "claude_code" });
		deepStrictEqual(claudeSdkToolsForAutonomy("auto-edit"), { type: "preset", preset: "claude_code" });
	});
});

describe("contracts/external CLI worker tool-profile enforcement", () => {
	// Regression for BUG-1 (battletest-pipeline-adhoc): a coder worker dispatched
	// with tool_profile minimal-local on the claude-sdk target ran bash. The
	// admitted surface must be enforced at the Clio mediation layer, not left to
	// the external CLI to honor.
	const minimalLocal = new Set<string>(["read", "grep", "find", "ls", "git", "context", "code_nav"]);

	function decideWithProfile(
		toolName: string,
		input: Record<string, unknown>,
		allowedTools: ReadonlySet<string>,
		autonomy: EvaluateClaudeToolPermissionInput["autonomy"] = "full-auto",
	) {
		const request: EvaluateClaudeToolPermissionInput = {
			toolName,
			input,
			safety: createWorkerSafety({ cwd: process.cwd() }),
			cwd: process.cwd(),
			allowedTools,
		};
		if (autonomy !== undefined) request.autonomy = autonomy;
		return evaluateClaudeToolPermission(request);
	}

	function auditingSafety(rows: ToolCallAuditInput[]): SafetyContract {
		const safety = createWorkerSafety({ cwd: process.cwd() });
		return {
			...safety,
			audit: {
				recordCount: () => rows.length,
				recordToolCall: (input) => rows.push(input),
			},
		};
	}

	it("denies an out-of-profile Bash call before the safety net (minimal-local excludes bash)", () => {
		// Under full-auto a recognized `pwd` would otherwise be allowed; the
		// profile gate must deny it because bash is outside minimal-local.
		const decision = decideWithProfile("Bash", { command: "pwd" }, minimalLocal);
		strictEqual(decision.kind, "deny");
		strictEqual(decision.permissionRequired, false);
		strictEqual(decision.decision.kind, "block");
		strictEqual(decision.reasonCode, "tool-profile");
	});

	it("records an audit row for out-of-profile Claude SDK tool calls when an audit sink is present", () => {
		const rows: ToolCallAuditInput[] = [];
		const decision = evaluateClaudeToolPermission({
			toolName: "Bash",
			input: { command: "pwd" },
			safety: auditingSafety(rows),
			cwd: process.cwd(),
			autonomy: "full-auto",
			allowedTools: minimalLocal,
		});

		strictEqual(decision.kind, "deny");
		strictEqual(rows.length, 1);
		strictEqual(rows[0]?.tool, "bash");
		strictEqual(rows[0]?.decision, "denied");
		strictEqual(rows[0]?.reasonCode, "tool-profile");
	});

	it("still allows in-profile tools under the same profile", () => {
		const decision = decideWithProfile("Read", { file_path: "README.md" }, minimalLocal, "read-only");
		strictEqual(decision.kind, "allow");
		strictEqual(decision.decision.classification.actionClass, "read");
	});

	it("emits a blocked clio_tool_finish with the tool-profile reasonCode for out-of-profile calls", () => {
		const events: ClioWorkerEvent[] = [];
		const decision = emitClaudeToolPermissionDecision({
			toolName: "Bash",
			input: { command: "pwd" },
			safety: createWorkerSafety({ cwd: process.cwd() }),
			cwd: process.cwd(),
			autonomy: "full-auto",
			allowedTools: minimalLocal,
			emit: (event) => events.push(event),
		});
		strictEqual(decision.kind, "deny");
		const finish = events.find((event) => event.type === "clio_tool_finish");
		ok(finish && finish.type === "clio_tool_finish");
		strictEqual(finish.payload.tool, "bash");
		strictEqual(finish.payload.outcome, "blocked");
		strictEqual(finish.payload.decision, "blocked");
		strictEqual(finish.payload.reasonCode, "tool-profile");
	});

	it("computes the SDK disallowedTools list from the admitted surface", () => {
		const disallowed = claudeToolsOutsideProfile(minimalLocal);
		// bash/write/edit/task/todo are outside minimal-local and must be disallowed.
		ok(disallowed.includes("Bash"));
		ok(disallowed.includes("Write"));
		ok(disallowed.includes("Edit"));
		ok(disallowed.includes("MultiEdit"));
		ok(disallowed.includes("WebFetch"));
		ok(disallowed.includes("Task"));
		ok(disallowed.includes("TodoWrite"));
		// read/grep/find/ls stay available.
		ok(!disallowed.includes("Read"));
		ok(!disallowed.includes("Grep"));
		ok(!disallowed.includes("Glob"));
		ok(!disallowed.includes("LS"));
	});

	it("without an allowedTools surface, behavior is unchanged (no profile gate)", () => {
		const request: EvaluateClaudeToolPermissionInput = {
			toolName: "Bash",
			input: { command: "pwd" },
			safety: createWorkerSafety({ cwd: process.cwd() }),
			cwd: process.cwd(),
			autonomy: "full-auto",
		};
		const decision = evaluateClaudeToolPermission(request);
		strictEqual(decision.kind, "allow");
	});

	it("black-box CLI runtimes refuse a narrowing profile they cannot mediate", () => {
		const base: WorkerRunInput = {
			systemPrompt: "",
			agentId: "coder",
			task: "run pwd",
			target: { id: "contract", runtime: "claude-code" } as WorkerRunInput["target"],
			runtime: claudeCodeRuntime,
			wireModelId: "sonnet",
			allowedTools: ["read", "grep", "find", "ls", "git", "context", "code_nav"],
			budget: { toolCalls: 18, readReserve: 4, synthesis: true, hardCap: 50 },
		};

		throws(
			() => buildClaudeCodeArgs({ ...base, toolProfile: "minimal-local" }),
			/cannot enforce tool_profile 'minimal-local'/,
		);
		throws(() => buildClaudeCodeArgs({ ...base, toolProfile: "science-local" }), /cannot enforce tool_profile/);
		throws(() => buildAgyArgs({ ...base, toolProfile: "minimal-local" }), /cannot enforce tool_profile/);

		// full-agent and no profile impose no narrowing, so they build normally.
		ok(Array.isArray(buildClaudeCodeArgs({ ...base, toolProfile: "full-agent" })));
		ok(Array.isArray(buildClaudeCodeArgs(base)));
		ok(Array.isArray(buildAgyArgs({ ...base, toolProfile: "full-agent" })));
	});

	it("enforces canonical SDK budget counting, read reserve, and synthesis transition", () => {
		let boundaries = 0;
		let hardCaps = 0;
		const gate = createClaudeWorkerBudgetGate(
			{ toolCalls: 4, readReserve: 2, synthesis: true, hardCap: 6 },
			() => {
				boundaries += 1;
			},
			() => {
				hardCaps += 1;
			},
		);
		strictEqual(gate.attempt("grep").kind, "allow");
		strictEqual(gate.admit("grep").kind, "allow");
		strictEqual(gate.attempt("find").kind, "allow");
		strictEqual(gate.admit("find").kind, "allow");
		matchBudgetDeny(gate.attempt("bash"), /read reserve/);
		strictEqual(gate.attempt("read").kind, "allow");
		strictEqual(gate.admit("read").kind, "allow");
		strictEqual(gate.attempt("read").kind, "allow");
		strictEqual(gate.admit("read").kind, "allow");
		strictEqual(gate.phaseReached(), true);
		strictEqual(boundaries, 1);
		matchBudgetDeny(gate.attempt("read"), /worker agent budget reached/);
		matchBudgetDeny(gate.attempt("read"), /workerToolCallCap reached/);
		strictEqual(hardCaps, 1);
	});

	it("does not spend a one-call agent budget on an out-of-profile denial", () => {
		const gate = createClaudeWorkerBudgetGate(
			{ toolCalls: 1, readReserve: 0, synthesis: true, hardCap: 3 },
			() => {},
			() => {},
		);
		const denied = evaluateClaudeToolPermission({
			toolName: "Bash",
			input: { command: "pwd" },
			safety: createWorkerSafety({ cwd: process.cwd() }),
			cwd: process.cwd(),
			autonomy: "full-auto",
			allowedTools: new Set(["read"]),
			budgetGate: gate,
		});
		strictEqual(denied.kind, "deny");
		strictEqual(denied.reasonCode, "tool-profile");
		const allowed = evaluateClaudeToolPermission({
			toolName: "Read",
			input: { file_path: "README.md" },
			safety: createWorkerSafety({ cwd: process.cwd() }),
			cwd: process.cwd(),
			autonomy: "read-only",
			allowedTools: new Set(["read"]),
			budgetGate: gate,
		});
		strictEqual(allowed.kind, "allow");
		strictEqual(gate.phaseReached(), true);
	});

	it("does not spend a one-call agent budget on a safety denial", () => {
		const gate = createClaudeWorkerBudgetGate(
			{ toolCalls: 1, readReserve: 0, synthesis: true, hardCap: 3 },
			() => {},
			() => {},
		);
		const denied = evaluateClaudeToolPermission({
			toolName: "Read",
			input: { file_path: "credentials.yaml" },
			safety: createWorkerSafety({ cwd: process.cwd() }),
			cwd: process.cwd(),
			autonomy: "read-only",
			allowedTools: new Set(["read"]),
			budgetGate: gate,
		});
		strictEqual(denied.kind, "deny");
		strictEqual(denied.decision.kind, "block");
		const allowed = evaluateClaudeToolPermission({
			toolName: "Read",
			input: { file_path: "README.md" },
			safety: createWorkerSafety({ cwd: process.cwd() }),
			cwd: process.cwd(),
			autonomy: "read-only",
			allowedTools: new Set(["read"]),
			budgetGate: gate,
		});
		strictEqual(allowed.kind, "allow");
	});

	it("does not spend a one-call agent budget on an autonomy denial", () => {
		const gate = createClaudeWorkerBudgetGate(
			{ toolCalls: 1, readReserve: 0, synthesis: true, hardCap: 3 },
			() => {},
			() => {},
		);
		const denied = evaluateClaudeToolPermission({
			toolName: "Write",
			input: { file_path: "tmp/claude-test.txt", content: "x" },
			safety: createWorkerSafety({ cwd: process.cwd() }),
			cwd: process.cwd(),
			autonomy: "read-only",
			allowedTools: new Set(["write", "read"]),
			budgetGate: gate,
		});
		strictEqual(denied.kind, "deny");
		strictEqual(denied.reasonCode, "autonomy:read-only");
		const allowed = evaluateClaudeToolPermission({
			toolName: "Read",
			input: { file_path: "README.md" },
			safety: createWorkerSafety({ cwd: process.cwd() }),
			cwd: process.cwd(),
			autonomy: "read-only",
			allowedTools: new Set(["write", "read"]),
			budgetGate: gate,
		});
		strictEqual(allowed.kind, "allow");
	});

	it("reserve denials preserve admitted read slots while still consuming hard attempts", () => {
		let hardCaps = 0;
		const gate = createClaudeWorkerBudgetGate(
			{ toolCalls: 2, readReserve: 1, synthesis: true, hardCap: 3 },
			() => {},
			() => {
				hardCaps += 1;
			},
		);
		strictEqual(gate.attempt("grep").kind, "allow");
		strictEqual(gate.admit("grep").kind, "allow");
		matchBudgetDeny(gate.attempt("bash"), /read reserve/);
		strictEqual(gate.attempt("read").kind, "allow");
		strictEqual(gate.admit("read").kind, "allow");
		strictEqual(gate.phaseReached(), true);
		matchBudgetDeny(gate.attempt("read"), /workerToolCallCap reached/);
		strictEqual(hardCaps, 1);
	});

	it("keeps a delivery-capable agent writing past its soft budget, bounded by the cap", () => {
		// The SDK gate mirrors the native guard: the soft budget ends discovery,
		// not the run's own product, and hardCap is the delivery phase's bound.
		// Refusing delivery at the budget is what left the wiki documenter with
		// zero successful writes in a whole pass.
		let boundaries = 0;
		let hardCaps = 0;
		const gate = createClaudeWorkerBudgetGate(
			{ toolCalls: 2, readReserve: 0, synthesis: true, hardCap: 4 },
			() => {
				boundaries += 1;
			},
			() => {
				hardCaps += 1;
			},
			["write"],
		);
		strictEqual(gate.attempt("grep").kind, "allow");
		strictEqual(gate.admit("grep").kind, "allow");
		strictEqual(gate.attempt("write").kind, "allow");
		strictEqual(gate.admit("write").kind, "allow");
		strictEqual(boundaries, 0, "a delivery-capable agent is not locked at its soft budget");
		strictEqual(gate.phaseReached(), false);
		// Discovery is over; delivery continues. The denial still consumes a hard
		// attempt, which is this gate's existing rule.
		matchBudgetDeny(gate.attempt("grep"), /worker discovery budget reached \(2\)/);
		strictEqual(gate.attempt("write").kind, "allow");
		strictEqual(gate.admit("write").kind, "allow");
		// hardCap is the ending: four attempts landed, the fifth aborts the run.
		matchBudgetDeny(gate.attempt("write"), /workerToolCallCap reached \(4\)/);
		strictEqual(hardCaps, 1);
	});

	it("counts duplicate PreToolUse and canUseTool mediation as one logical attempt", () => {
		const gate = createClaudeWorkerBudgetGate(
			{ toolCalls: 1, readReserve: 0, synthesis: true, hardCap: 1 },
			() => {},
			() => {},
		);
		const handled = new Map<string, ClaudeToolPermissionDecision>();
		let evaluations = 0;
		const decide = () => {
			evaluations += 1;
			return evaluateClaudeToolPermission({
				toolName: "Read",
				input: { file_path: "README.md" },
				safety: createWorkerSafety({ cwd: process.cwd() }),
				cwd: process.cwd(),
				autonomy: "read-only",
				allowedTools: new Set(["read"]),
				budgetGate: gate,
			});
		};
		strictEqual(decideClaudeSdkToolUseOnce(handled, "tool-1", decide).kind, "allow");
		strictEqual(decideClaudeSdkToolUseOnce(handled, "tool-1", decide).kind, "allow");
		strictEqual(evaluations, 1);
	});
});

function matchBudgetDeny(value: { kind: string; reason?: string }, pattern: RegExp): void {
	strictEqual(value.kind, "deny");
	ok(pattern.test(value.reason ?? ""));
}

describe("contracts/claude subprocess permission gate", () => {
	it("only opens dangerous bypass under full-auto plus the explicit environment gate", () => {
		for (const autonomy of ["read-only", "auto-edit", "full-auto"] as const) {
			const config = claudeSubprocessPermissionConfigForAutonomy(autonomy, {});
			strictEqual(config.dangerousBypass, false, `${autonomy} must not bypass by default`);
			strictEqual(config.permissionMode === "bypassPermissions", false, `${autonomy} must not use bypass by default`);
			ok(!config.extraArgs.includes("--allow-dangerously-skip-permissions"));
			ok(!config.extraArgs.includes("--dangerously-skip-permissions"));
		}

		throws(() => claudeSubprocessPermissionConfigForAutonomy("suggest", {}), /cannot enforce autonomy 'suggest'/);
		throws(
			() => claudeSubprocessPermissionConfigForAutonomy("suggest", { CLIO_CODER_ALLOW_EXTERNAL_FULL_ACCESS: "1" }),
			/cannot enforce autonomy 'suggest'/,
		);

		const fullAutoWithEnv = claudeSubprocessPermissionConfigForAutonomy("full-auto", {
			CLIO_CODER_ALLOW_EXTERNAL_FULL_ACCESS: "1",
		});
		strictEqual(fullAutoWithEnv.dangerousBypass, true);
		strictEqual(fullAutoWithEnv.permissionMode, "bypassPermissions");
		ok(fullAutoWithEnv.extraArgs.includes("--allow-dangerously-skip-permissions"));
		ok(!fullAutoWithEnv.extraArgs.includes("--dangerously-skip-permissions"));
	});

	it("refuses suggest before building Claude Code args", () => {
		const base = {
			systemPrompt: "",
			agentId: "contract",
			executionRole: "builder",
			task: "hello",
			target: { id: "contract", runtime: "claude-code" },
			runtime: claudeCodeRuntime,
			wireModelId: "sonnet",
			allowedTools: [],
			budget: { toolCalls: 18, readReserve: 0, synthesis: true, hardCap: 50 },
			autonomy: "suggest" as const,
		};
		throws(() => buildClaudeCodeArgs(base), /claude-code runtime cannot enforce autonomy 'suggest'/);
	});

	it("does not pass Clio session ids as Claude Code session ids", () => {
		const base = {
			systemPrompt: "",
			agentId: "contract",
			executionRole: "builder",
			task: "hello",
			target: { id: "contract", runtime: "claude-code" },
			runtime: claudeCodeRuntime,
			wireModelId: "sonnet",
			allowedTools: [],
			budget: { toolCalls: 18, readReserve: 0, synthesis: true, hardCap: 50 },
		};
		const invalid = buildClaudeCodeArgs({ ...base, sessionId: "clio-session-1" });
		ok(!invalid.includes("--session-id"));
		const valid = buildClaudeCodeArgs({ ...base, sessionId: "16046247-76ac-4095-8ed2-fcc4635e7334" });
		ok(valid.includes("--session-id"));
	});
});
