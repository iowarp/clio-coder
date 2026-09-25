import { strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { ToolNames } from "../../src/core/tool-names.js";
import { createSafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";

// BT-001. The damage-control scan joined every tool argument into one string,
// so a rule anchored with `$` stopped matching as soon as the model supplied a
// second argument. `git restore .` with a `cwd` ran at both levels, and the
// authored `git checkout -- .` confirm rail fell through to the classifier's
// unconditional git_destructive block. The rule must see the command itself,
// whatever else the call carries.
const engine = createSafetyPolicyEngine({ cwd: process.cwd() });

function decide(args: Record<string, unknown>, posture: "default" | "yolo" | "confirmed") {
	return engine.evaluate({ tool: ToolNames.Bash, args }, posture);
}

const EXTRA_ARGS: ReadonlyArray<Record<string, unknown>> = [
	{},
	{ cwd: "." },
	{ timeout_ms: 30_000 },
	{ cwd: "pkg", timeout_ms: 30_000, output_policy: "summary" },
];

test("an anchored damage-control ask rule survives the call's other arguments", () => {
	for (const command of ["git restore .", "git checkout -- ."]) {
		for (const extra of EXTRA_ARGS) {
			for (const posture of ["default", "yolo"] as const) {
				const decision = decide({ command, ...extra }, posture);
				strictEqual(decision.kind, "ask", `${posture} ${command} ${JSON.stringify(extra)}: ${decision.reasonCode}`);
			}
			const confirmed = decide({ command, ...extra }, "confirmed");
			strictEqual(confirmed.kind, "allow", `confirmed ${command} ${JSON.stringify(extra)}: ${confirmed.reasonCode}`);
		}
	}
});

// The unanchored rules already matched inside the joined blob. They are here so
// a future change to the scan cannot quietly drop them.
test("unanchored damage-control ask rules still ask at both levels", () => {
	for (const command of ["git stash drop", "git branch -D feature", "truncate -s 0 notes.txt"]) {
		for (const posture of ["default", "yolo"] as const) {
			const decision = decide({ command, cwd: "." }, posture);
			strictEqual(decision.kind, "ask", `${posture} ${command}: ${decision.reasonCode}`);
		}
	}
});

// Hard blocks are not part of the ask rail and must stay final at yolo, with
// the extra arguments that defeated the anchors above.
test("hard blocks stay blocks whatever the call's other arguments are", () => {
	for (const command of ["rm -rf build", "git reset --hard HEAD~1", "git clean -fd", "sudo rm /etc/hosts"]) {
		for (const extra of EXTRA_ARGS) {
			const decision = decide({ command, ...extra }, "yolo");
			strictEqual(decision.kind, "block", `yolo ${command} ${JSON.stringify(extra)}: ${decision.reasonCode}`);
		}
	}
});

// Offering the command as its own scan candidate must not turn ordinary work
// into a confirmation. A recognized command still runs at both levels.
test("a recognized command still runs without a confirmation", () => {
	for (const extra of EXTRA_ARGS) {
		for (const posture of ["default", "yolo"] as const) {
			const decision = decide({ command: "git status --short", ...extra }, posture);
			strictEqual(decision.kind, "allow", `${posture} ${JSON.stringify(extra)}: ${decision.reasonCode}`);
		}
	}
});
