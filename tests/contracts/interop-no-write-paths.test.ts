import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { foreignAgentDirs } from "../../src/domains/interop/index.js";
import { createSafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";

describe("contracts/foreign agent directories are never written", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "clio-interop-write-"));
		mkdirSync(join(scratch, ".clio-coder"), { recursive: true });
	});

	afterEach(() => {
		rmSync(scratch, { recursive: true, force: true });
	});

	it("refuses a write into another agent's home directory at every posture", () => {
		const engine = createSafetyPolicyEngine({ cwd: scratch });
		const target = join(homedir(), ".codex", "skills", "x", "SKILL.md");
		for (const posture of [undefined, "confirmed"]) {
			const decision = engine.evaluate({ tool: ToolNames.Write, args: { path: target, content: "x" } }, posture);
			strictEqual(decision.kind, "block", `posture ${posture ?? "default"} allowed the write`);
			strictEqual(decision.reasonCode, "path-policy:noWritePaths");
		}
	});

	it("refuses an edit into another agent's project directory", () => {
		const engine = createSafetyPolicyEngine({ cwd: scratch });
		const decision = engine.evaluate({ tool: ToolNames.Edit, args: { path: ".claude/settings.json" } });
		strictEqual(decision.kind, "block");
		strictEqual(decision.reasonCode, "path-policy:noWritePaths");
	});

	it("still allows reads of a foreign root, which is how skills and rules load", () => {
		const engine = createSafetyPolicyEngine({ cwd: scratch });
		const decision = engine.evaluate({ tool: ToolNames.Read, args: { path: ".claude/skills/x/SKILL.md" } });
		strictEqual(decision.kind, "allow");
	});

	it("leaves Clio's own project directory writable", () => {
		const engine = createSafetyPolicyEngine({ cwd: scratch });
		const decision = engine.evaluate({
			tool: ToolNames.Write,
			args: { path: ".clio-coder/skills/x/SKILL.md", content: "x" },
		});
		strictEqual(decision.kind, "allow");
	});

	it("names every registered agent directory", () => {
		const dirs = foreignAgentDirs();
		for (const expected of [
			"~/.claude/",
			"~/.codex/",
			"~/.gemini/",
			"~/.cursor/",
			"~/.config/opencode/",
			"~/.copilot/",
			"~/.agents/",
		]) {
			ok(dirs.includes(expected), `${expected} is not a protected directory`);
		}
		strictEqual(dirs.includes(".clio-coder/"), false);
	});
});
