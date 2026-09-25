import { strictEqual } from "node:assert/strict";
import { test } from "node:test";

import { ToolNames } from "../../src/core/tool-names.js";
import { createSafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";

// BT-002, with ORCH-003 as supporting evidence. A damage-control rule anchored
// with `$` only sees the end of the whole command string, so a chained
// `git restore . && echo RESTORED` hid its destructive segment: at yolo it ran
// with no card and discarded a dirty tracked edit, and the audit recorded
// `bash-shell-operators` rather than the damage-control rail. The same hole is
// open behind `;`, `|`, a redirection, a newline, a `$(...)` substitution and
// `sh -c`. Rules are checked against each executable segment now.
const engine = createSafetyPolicyEngine({ cwd: process.cwd() });

function decide(command: string, posture: "default" | "yolo" | "confirmed") {
	return engine.evaluate({ tool: ToolNames.Bash, args: { command, cwd: "." } }, posture);
}

function asksBothLevels(command: string): void {
	for (const posture of ["default", "yolo"] as const) {
		const decision = decide(command, posture);
		strictEqual(decision.kind, "ask", `${posture} ${JSON.stringify(command)}: ${decision.reasonCode}`);
		strictEqual(
			decision.reasonCode.startsWith("damage-control:"),
			true,
			`${posture} ${JSON.stringify(command)}: ${decision.reasonCode}`,
		);
	}
}

// The verbatim command from the BT-002 repro, which discarded `lib/math.js`.
test("BT-002: the chained restore asks at both levels through the damage-control rail", () => {
	asksBothLevels("git restore . && echo RESTORED");
	asksBothLevels('git restore . && echo "EXIT:$?"');
});

test("every shell operator that can follow a damage-control command still asks", () => {
	for (const command of [
		"git restore .; echo done",
		"git restore . || true",
		"git restore . > /dev/null",
		"git restore .|cat",
		"git restore .\necho ok",
		"git restore . # keep going",
		"echo ready && git restore . && echo done",
		"git checkout -- . && echo ok",
	]) {
		asksBothLevels(command);
	}
});

// ORCH-005 covers the double-quoted form in damage-control-scan-args.test.ts.
test("a damage-control command hidden in a substitution or an inner shell still asks", () => {
	for (const command of [
		"$(git restore .)",
		"echo $(git restore .)",
		'sh -c "git restore ."',
		"bash -c 'git restore .'",
	]) {
		asksBothLevels(command);
	}
});

// BT-002 `suspect`: spellings of "restore everything" that the anchored pattern
// never covered, chained and bare.
test("the pathspec spellings of a whole-worktree restore ask too", () => {
	for (const command of [
		"git restore ./",
		"git restore -- .",
		"git restore --worktree .",
		"git restore :/",
		"git restore ./ && echo ok",
		"git restore -- . ; echo ok",
	]) {
		asksBothLevels(command);
	}
});

test("a one-shot confirmation admits the chained command", () => {
	const decision = decide("git restore . && echo RESTORED", "confirmed");
	strictEqual(decision.kind, "allow", decision.reasonCode);
});

// Hard blocks are not part of the ask rail. Chaining must not soften one, and
// the segment scan must not turn one into a mere confirmation.
test("hard blocks stay blocks behind every operator", () => {
	for (const command of [
		"rm -rf build && echo ok",
		"echo ready && git reset --hard HEAD~1",
		"git clean -fd; echo ok",
		'sh -c "rm -rf build"',
		"git push --force origin main | cat",
	]) {
		const decision = decide(command, "yolo");
		strictEqual(decision.kind, "block", `${JSON.stringify(command)}: ${decision.reasonCode}`);
	}
});

// Segments come from the original text, so a rule cannot fire on a word that
// only looks like a command inside a quoted argument.
test("quoted text that merely spells a damage-control command does not ask", () => {
	for (const command of ['echo "git restore ."', "echo 'git restore . && x'", "git commit -m 'git restore .'"]) {
		const decision = decide(command, "yolo");
		strictEqual(decision.kind, "allow", `${JSON.stringify(command)}: ${decision.reasonCode}`);
	}
});

test("ordinary chained work still runs without a confirmation", () => {
	for (const command of ["git status --short && echo ok", "cd pkg && ls -la", "echo one; echo two"]) {
		const decision = decide(command, "yolo");
		strictEqual(decision.kind, "allow", `${JSON.stringify(command)}: ${decision.reasonCode}`);
	}
});
