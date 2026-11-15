import { ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { templateToolConstraints, turnScopeGuidance } from "../../src/core/turn-constraints.js";

test("a narrowed scope that keeps bash beside the file tools says what the file tools are for", () => {
	const guidance = turnScopeGuidance(
		templateToolConstraints({ name: "desk:advance", allowedTools: ["read", "grep", "find", "ls", "bash", "write"] }),
	);
	ok(
		guidance.includes(
			"bash is admitted for the commands this task runs; use read and grep for files and find/ls through gateway for listings, not shell commands.",
		),
		guidance,
	);
	strictEqual(
		turnScopeGuidance(templateToolConstraints({ name: "x", allowedTools: ["bash", "write"] })).includes("admitted for"),
		false,
	);
});
