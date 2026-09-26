import { strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { createSafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";

it("force-with-lease uses ordinary command rails while unconditional force stays blocked", () => {
	const engine = createSafetyPolicyEngine({ cwd: process.cwd() });
	for (const level of ["default", "yolo"] as const) {
		for (const command of [
			"git push --force-with-lease",
			"git push origin main --force-with-lease",
			"git push --force-with-lease=refs/heads/main:abc",
		]) {
			strictEqual(engine.evaluate({ tool: "bash", args: { command } }, level).kind, "allow", `${level}: ${command}`);
		}
		for (const command of [
			"git push --force",
			"git push origin main --force",
			"git push -f",
			"git push --forc",
			"git push origin +main",
		]) {
			strictEqual(engine.evaluate({ tool: "bash", args: { command } }, level).kind, "block", `${level}: ${command}`);
		}
	}
});
