import { strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { evaluateClaudeToolCall, mapClaudeToolName } from "../../../src/engine/sdk-policy-bridge.js";
import { createWorkerSafety } from "../../../src/engine/worker-tools.js";

describe("engine/sdk-policy-bridge: mapClaudeToolName", () => {
	const cases: Array<[string, string | null]> = [
		["Bash", "bash"],
		["Edit", "edit"],
		["MultiEdit", "edit"],
		["Write", "write"],
		["Read", "read"],
		["NotebookRead", "read"],
		["Grep", "grep"],
		["Glob", "glob"],
		["LS", "ls"],
		["WebFetch", "web_fetch"],
		["WebSearch", "web_search"],
		["Task", "dispatch"],
		["AskUserQuestion", null],
		["ExitPlanMode", null],
		["TodoWrite", null],
		["UnknownTool", null],
	];
	for (const [claude, clio] of cases) {
		it(`maps ${claude} -> ${clio ?? "null"}`, () => {
			strictEqual(mapClaudeToolName(claude), clio);
		});
	}
});

describe("engine/sdk-policy-bridge: evaluateClaudeToolCall", () => {
	const cwd = mkdtempSync(join(tmpdir(), "clio-sdk-bridge-"));
	const safety = createWorkerSafety({ cwd });

	after(() => rmSync(cwd, { recursive: true, force: true }));

	it("allows benign Bash via builtin allowlist", () => {
		const result = evaluateClaudeToolCall("Bash", { command: "ls -la", cwd }, "default", safety);
		strictEqual(result.decision, "allow", `reason=${result.reason}`);
	});

	it("blocks Bash with shell operators in default mode", () => {
		const result = evaluateClaudeToolCall("Bash", { command: "echo hi | cat", cwd }, "default", safety);
		strictEqual(result.decision, "block");
	});

	it("returns ask for an unmapped Claude tool", () => {
		const result = evaluateClaudeToolCall("MysteryTool", { foo: 1 }, "default", safety);
		strictEqual(result.decision, "ask");
		strictEqual(result.clioToolName, null);
	});

	it("blocks Bash with git push --force regardless of mode (hard block)", () => {
		const result = evaluateClaudeToolCall("Bash", { command: "git push --force", cwd }, "super", safety);
		strictEqual(result.decision, "block");
	});

	it("allows arbitrary Bash in super mode via mode-elevation", () => {
		const result = evaluateClaudeToolCall("Bash", { command: "node cleanup.js", cwd }, "super", safety);
		strictEqual(result.decision, "allow");
	});
});
