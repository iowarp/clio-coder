import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import type { MiddlewareHookInput } from "../../src/domains/middleware/index.js";
import { createCitationGroundingRegistration } from "../../src/domains/safety/citation-grounding.js";
import { bashObservedLines } from "../../src/tools/bash-observed-lines.js";
import { isolateClioEnv } from "../harness/scratch-env.js";

function unbackedCitationTurnEnd(toolsLocked: boolean): ReadonlyArray<{ kind: string }> {
	const registration = createCitationGroundingRegistration({ cwd: () => "/workspace" });
	const read: MiddlewareHookInput = {
		hook: "after_tool",
		sessionId: "s1",
		toolName: "read",
		toolArgs: { path: "src/rates.mjs" },
		metadata: { resultKind: "ok" },
	};
	registration.evaluate(read);
	return registration.evaluate({
		hook: "turn_end",
		sessionId: "s1",
		text: "The rounding bug is at src/rates.mjs:42-48.",
		metadata: { stopReason: "stop", userTurnId: "u1", toolsLocked },
	});
}

test("the citation check asks for a numbered re-read while tools are available", () => {
	assert.ok(unbackedCitationTurnEnd(false).length > 0);
});

test("the citation check asks for no tool call once the loop guard has locked tools", () => {
	// The soft budget blocked every further call, so a re-read nudge forced a blocked call 61.
	assert.deepEqual(unbackedCitationTurnEnd(true), []);
});

test("a line a bash grep -n printed for a file it named grounds the citation (bt-29)", async () => {
	const env = await isolateClioEnv("citation-bash-grep-");
	try {
		const cwd = env.dir;
		mkdirSync(path.join(cwd, "logs"));
		writeFileSync(path.join(cwd, "logs", "build.log"), "x\n");
		const log = path.join(cwd, "logs", "build.log");
		const printed = "41238:ERROR [boot] startup aborted: E4127\n41239-context\n";
		const command = "grep -nE 'ERROR|E41' logs/build.log 2>/dev/null | head -50";
		assert.deepEqual(bashObservedLines(command, printed, cwd), { [log]: [41238, 41239] });
		// Fail-closed: no -n, compound commands, sed -n, and paths outside the named operands credit nothing.
		assert.equal(bashObservedLines("grep -E ERROR logs/build.log", printed, cwd), undefined);
		assert.equal(bashObservedLines("grep -n ERROR logs/build.log; echo 41238:x", printed, cwd), undefined);
		assert.equal(bashObservedLines("sed -n 41230,41240p logs/build.log", printed, cwd), undefined);
		assert.equal(bashObservedLines("rg -n ERROR logs", "other/build.log:41238:ERROR\n", cwd), undefined);
		assert.deepEqual(bashObservedLines("rg -n ERROR logs", "logs/build.log:41238:ERROR\n", cwd), { [log]: [41238] });

		const registration = createCitationGroundingRegistration({ cwd: () => cwd });
		registration.evaluate({
			hook: "after_tool",
			sessionId: "s1",
			toolName: "read",
			toolArgs: { path: "logs/build.log" },
			metadata: { resultKind: "ok" },
		});
		// `| head` closing the pipe fails grep under pipefail; the printed lines still count.
		registration.evaluate({
			hook: "after_tool",
			sessionId: "s1",
			toolName: "bash",
			toolArgs: { command },
			toolResultDetails: { observedLines: bashObservedLines(command, printed, cwd) },
			metadata: { resultKind: "error" },
		});
		const turnEnd = (text: string, userTurnId: string) =>
			registration.evaluate({ hook: "turn_end", sessionId: "s1", text, metadata: { stopReason: "stop", userTurnId } });
		assert.deepEqual(turnEnd("The failure is E4127 at logs/build.log, line 41238.", "u1"), []);
		const nudge = turnEnd("The failure is E4127 at logs/build.log, line 41240.", "u2");
		// A model told to keep the answer as it is replied with "citations confirmed" alone (bt-29).
		assert.match(String((nudge[0] as { message?: unknown } | undefined)?.message), /full answer again/u);
	} finally {
		env.restore();
	}
});
