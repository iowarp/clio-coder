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

it("review round 2 G: checkout discard forms and force push refspecs are gated", () => {
	const engine = createSafetyPolicyEngine({ cwd: process.cwd() });
	for (const [command, expected] of [
		["git checkout .", "ask"],
		["git checkout -f", "ask"],
		["git push origin +main", "block"],
	] as const)
		for (const level of ["default", "yolo"] as const)
			strictEqual(engine.evaluate({ tool: "bash", args: { command } }, level).kind, expected, command);
});

it("accepted clean and checkout force prefixes retain destructive rails", () => {
	const engine = createSafetyPolicyEngine({ cwd: process.cwd() });
	for (const flag of ["--f", "--fo", "--for", "--forc"]) {
		for (const level of ["default", "yolo"] as const) {
			for (const command of [`git clean ${flag}`, `git -C . clean ${flag} -d`])
				strictEqual(engine.evaluate({ tool: "bash", args: { command } }, level).kind, "block", command);
			for (const command of [`git checkout ${flag} main`, `git -c k=v checkout ${flag} main`])
				strictEqual(engine.evaluate({ tool: "bash", args: { command } }, level).kind, "ask", command);
			for (const command of [`git clean ${flag} --dry-run`, `git clean ${flag} -nd`])
				strictEqual(engine.evaluate({ tool: "bash", args: { command } }, level).kind, "allow", command);
			strictEqual(
				engine.evaluate({ tool: "bash", args: { command: `git clean ${flag} -- --dry-run` } }, level).kind,
				"block",
			);
		}
	}
});
