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

type Posture = "default" | "yolo" | "confirmed";

interface Row {
	/** The old per-case test title, so a failure reads as it did. */
	name: string;
	commands: string[];
	postures: Posture[];
	/** `ask` must come from the damage-control rail; `ruleId` pins which rule decided. */
	kind: "ask" | "block" | "allow";
	ruleId?: string;
}

const BOTH: Posture[] = ["default", "yolo"];

const rows: Row[] = [
	// The verbatim command from the BT-002 repro, which discarded `lib/math.js`.
	{
		name: "BT-002: the chained restore asks at both levels through the damage-control rail",
		commands: ["git restore . && echo RESTORED", 'git restore . && echo "EXIT:$?"'],
		postures: BOTH,
		kind: "ask",
	},
	{
		name: "every shell operator that can follow a damage-control command still asks",
		commands: [
			"git restore .; echo done",
			"git restore . || true",
			"git restore . > /dev/null",
			"git restore .|cat",
			"git restore .\necho ok",
			"git restore . # keep going",
			"echo ready && git restore . && echo done",
			"git checkout -- . && echo ok",
		],
		postures: BOTH,
		kind: "ask",
	},
	// ORCH-005 covers the double-quoted form in damage-control-scan-args.test.ts.
	{
		name: "a damage-control command hidden in a substitution or an inner shell still asks",
		commands: ["$(git restore .)", "echo $(git restore .)", 'sh -c "git restore ."', "bash -c 'git restore .'"],
		postures: BOTH,
		kind: "ask",
	},
	// BT-002 `suspect`: spellings of "restore everything" that the anchored
	// pattern never covered, chained and bare.
	{
		name: "the pathspec spellings of a whole-worktree restore ask too",
		commands: [
			"git restore ./",
			"git restore -- .",
			"git restore --worktree .",
			"git restore :/",
			"git restore ./ && echo ok",
			"git restore -- . ; echo ok",
		],
		postures: BOTH,
		kind: "ask",
	},
	{
		name: "a one-shot confirmation admits the chained command",
		commands: ["git restore . && echo RESTORED"],
		postures: ["confirmed"],
		kind: "allow",
	},
	// Hard blocks are not part of the ask rail. Chaining must not soften one, and
	// the segment scan must not turn one into a mere confirmation.
	{
		name: "hard blocks stay blocks behind every operator",
		commands: [
			"rm -rf build && echo ok",
			"echo ready && git reset --hard HEAD~1",
			"git clean -fd; echo ok",
			'sh -c "rm -rf build"',
			"git push --force origin main | cat",
		],
		postures: ["yolo"],
		kind: "block",
	},
	// F1: an earlier confirmation rule matched the first segment and hid the hard
	// block on the second, so a confirmed posture admitted the project deletion.
	{
		name: "F1: a hard block in a later segment outranks an earlier confirmation rule",
		commands: [
			"gcloud iam policies list; firebase projects:delete example",
			"gcloud iam policies list && firebase projects:delete example",
		],
		postures: ["default", "yolo", "confirmed"],
		kind: "block",
		ruleId: "firebase-projects-delete",
	},
	// Segments come from the original text, so a rule cannot fire on a word that
	// only looks like a command inside a quoted argument.
	{
		name: "quoted text that merely spells a damage-control command does not ask",
		commands: ['echo "git restore ."', "echo 'git restore . && x'", "git commit -m 'git restore .'"],
		postures: ["yolo"],
		kind: "allow",
	},
	{
		name: "ordinary chained work still runs without a confirmation",
		commands: ["git status --short && echo ok", "cd pkg && ls -la", "echo one; echo two"],
		postures: ["yolo"],
		kind: "allow",
	},
];

test("damage-control rules judge every executable segment of a shell command", () => {
	for (const row of rows) {
		for (const command of row.commands) {
			for (const posture of row.postures) {
				const decision = engine.evaluate({ tool: ToolNames.Bash, args: { command, cwd: "." } }, posture);
				const label = `${row.name}: ${posture} ${JSON.stringify(command)}: ${decision.reasonCode}`;
				strictEqual(decision.kind, row.kind, label);
				if (row.kind === "ask") strictEqual(decision.reasonCode.startsWith("damage-control:"), true, label);
				if (row.ruleId !== undefined) strictEqual(decision.ruleId, row.ruleId, label);
			}
		}
	}
});
