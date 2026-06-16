import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";

import { claudeSdkPermissionModeForAutonomy, claudeSdkToolsForAutonomy } from "../../src/engine/claude/sdk-runtime.js";
import { claudeSubprocessPermissionConfigForAutonomy } from "../../src/engine/claude/subprocess-runtime.js";
import {
	type EvaluateClaudeToolPermissionInput,
	evaluateClaudeToolPermission,
} from "../../src/engine/claude/tool-safety.js";
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

	it("keeps SDK permission mode mediated and constrains read-only tools", () => {
		strictEqual(claudeSdkPermissionModeForAutonomy("read-only"), "plan");
		strictEqual(claudeSdkPermissionModeForAutonomy("suggest"), "default");
		strictEqual(claudeSdkPermissionModeForAutonomy("auto-edit"), "default");
		strictEqual(claudeSdkPermissionModeForAutonomy("full-auto"), "default");
		const readOnlyTools = claudeSdkToolsForAutonomy("read-only");
		ok(Array.isArray(readOnlyTools), "read-only SDK tools should be an explicit allow surface");
		ok(readOnlyTools.includes("Read"));
		ok(!readOnlyTools.includes("Bash"));
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
});
