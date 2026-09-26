import { strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { createSafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";

it("review round 2 G: git word quoting, global options and continuations retain destructive rails", () => {
	const engine = createSafetyPolicyEngine({ cwd: process.cwd() });
	for (const [command, expected] of [
		["git -C . clean -fd", "block"],
		["git --git-dir=.git --work-tree=. clean -fd", "block"],
		["git -c k=v reset --hard", "block"],
		['"git" clean -fd', "block"],
		['g"i"t clean -fd', "block"],
		['git c"lean" -fd', "block"],
		['git clean "-fd"', "block"],
		['echo "git stash clear"; git s"tash" clear', "block"],
		['git restore "."', "ask"],
		["git restore './'", "ask"],
		['git checkout -- "."', "ask"],
		["git \\\nclean -fd", "block"],
	] as const)
		for (const level of ["default", "yolo"] as const)
			strictEqual(engine.evaluate({ tool: "bash", args: { command } }, level).kind, expected, command);
});

it("review round 2 G: combined and abbreviated destructive git flags cannot bypass rules", () => {
	const engine = createSafetyPolicyEngine({ cwd: process.cwd() });
	for (const command of ["git clean -xfd", "git reset --har", "git push --forc"])
		for (const level of ["default", "yolo"] as const)
			strictEqual(engine.evaluate({ tool: "bash", args: { command } }, level).kind, "block", command);
});
