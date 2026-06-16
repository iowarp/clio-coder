import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import claudeCodeRuntime from "../../src/domains/providers/runtimes/claude/claude-code.js";
import { claudeSdkPermissionModeForAutonomy, claudeSdkToolsForAutonomy } from "../../src/engine/claude/sdk-runtime.js";
import {
	buildClaudeCodeArgs,
	claudeSubprocessPermissionConfigForAutonomy,
} from "../../src/engine/claude/subprocess-runtime.js";
import {
	type EvaluateClaudeToolPermissionInput,
	emitClaudeToolPermissionDecision,
	evaluateClaudeToolPermission,
} from "../../src/engine/claude/tool-safety.js";
import type { ClioWorkerEvent } from "../../src/engine/worker-events.js";
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

describe("contracts/claude subprocess permission gate", () => {
	it("only opens dangerous bypass under full-auto plus the explicit environment gate", () => {
		for (const autonomy of ["read-only", "suggest", "auto-edit", "full-auto"] as const) {
			const config = claudeSubprocessPermissionConfigForAutonomy(autonomy, {});
			strictEqual(config.dangerousBypass, false, `${autonomy} must not bypass by default`);
			strictEqual(config.permissionMode === "bypassPermissions", false, `${autonomy} must not use bypass by default`);
			ok(!config.extraArgs.includes("--allow-dangerously-skip-permissions"));
			ok(!config.extraArgs.includes("--dangerously-skip-permissions"));
		}

		const suggestWithEnv = claudeSubprocessPermissionConfigForAutonomy("suggest", {
			CLIO_ALLOW_EXTERNAL_FULL_ACCESS: "1",
		});
		strictEqual(suggestWithEnv.dangerousBypass, false);
		strictEqual(suggestWithEnv.permissionMode === "bypassPermissions", false);

		const fullAutoWithEnv = claudeSubprocessPermissionConfigForAutonomy("full-auto", {
			CLIO_ALLOW_EXTERNAL_FULL_ACCESS: "1",
		});
		strictEqual(fullAutoWithEnv.dangerousBypass, true);
		strictEqual(fullAutoWithEnv.permissionMode, "bypassPermissions");
		ok(fullAutoWithEnv.extraArgs.includes("--allow-dangerously-skip-permissions"));
		ok(!fullAutoWithEnv.extraArgs.includes("--dangerously-skip-permissions"));
	});

	it("does not pass Clio session ids as Claude Code session ids", () => {
		const base = {
			systemPrompt: "",
			agentId: "contract",
			task: "hello",
			target: { id: "contract", runtime: "claude-code" },
			runtime: claudeCodeRuntime,
			wireModelId: "sonnet",
			allowedTools: [],
		};
		const invalid = buildClaudeCodeArgs({ ...base, sessionId: "clio-session-1" });
		ok(!invalid.includes("--session-id"));
		const valid = buildClaudeCodeArgs({ ...base, sessionId: "16046247-76ac-4095-8ed2-fcc4635e7334" });
		ok(valid.includes("--session-id"));
	});
});
