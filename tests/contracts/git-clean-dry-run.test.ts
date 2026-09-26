import { strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { createSafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";

it("git clean previews run while forced deletion remains blocked", () => {
	const engine = createSafetyPolicyEngine({ cwd: process.cwd() });
	for (const level of ["default", "yolo"] as const) {
		for (const flags of [
			"-nd",
			"-ndx",
			"-ndf",
			"-dn",
			"-d -n",
			"--dry-run",
			"-fdn",
			"-f -d -n",
			"-n -f -d",
			"-fd --dry-run",
			"--dry-run --force -d",
			"-d --dry-run",
		]) {
			strictEqual(
				engine.evaluate({ tool: "bash", args: { command: `git clean ${flags}` } }, level).kind,
				"allow",
				`${level} ${flags}`,
			);
		}
		for (const flags of ["-fd", "-df", "-xfd", "-f -d", "--force -d", "-f", "-ffdx"]) {
			strictEqual(
				engine.evaluate({ tool: "bash", args: { command: `git clean ${flags}` } }, level).kind,
				"block",
				`${level} ${flags}`,
			);
		}
		strictEqual(
			engine.evaluate({ tool: "bash", args: { command: "git clean -nd && git clean -fd" } }, level).kind,
			"block",
		);
	}
});

it("git clean path operands cannot masquerade as a dry-run flag", () => {
	const engine = createSafetyPolicyEngine({ cwd: process.cwd() });
	for (const level of ["default", "yolo"] as const) {
		strictEqual(engine.evaluate({ tool: "bash", args: { command: "git clean -fd -- -n" } }, level).kind, "block");
		strictEqual(engine.evaluate({ tool: "bash", args: { command: "git clean -fd -- --dry-run" } }, level).kind, "block");
	}
});
