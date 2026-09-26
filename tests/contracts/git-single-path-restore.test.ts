import { strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { createSafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";

it("single-path source restores follow normal git rails and whole-tree restores still ask", () => {
	const engine = createSafetyPolicyEngine({ cwd: process.cwd() });
	for (const level of ["default", "yolo"] as const) {
		for (const command of [
			"git restore --source=HEAD~1 f",
			"git restore --source HEAD~1 -- f",
			"git restore -s HEAD~1 f",
			"git restore f",
		]) {
			strictEqual(engine.evaluate({ tool: "bash", args: { command } }, level).kind, "allow", `${level}: ${command}`);
		}
		for (const command of [
			"git branch -d x",
			"git restore --staged .",
			"git restore --source=HEAD~1 .",
			"git restore --source HEAD~1 -- ./",
		]) {
			strictEqual(engine.evaluate({ tool: "bash", args: { command } }, level).kind, "ask", `${level}: ${command}`);
		}
	}
});
