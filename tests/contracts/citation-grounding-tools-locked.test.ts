import assert from "node:assert/strict";
import { test } from "node:test";
import type { MiddlewareHookInput } from "../../src/domains/middleware/index.js";
import { createCitationGroundingRegistration } from "../../src/domains/safety/citation-grounding.js";

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
