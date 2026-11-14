import assert from "node:assert/strict";
import { test } from "node:test";
import { answeredInOverview, answeredTurns, RENAME_AFTER_ANSWER, renameBlocker } from "../client/shell/shell-model.js";

test("a task can be renamed once it is saved or CLIO Coder has answered in it", () => {
	assert.equal(renameBlocker({ saved: false, answered: 0 }), RENAME_AFTER_ANSWER);
	assert.equal(renameBlocker({ saved: false, answered: 1 }), null);
	assert.equal(renameBlocker({ saved: true, answered: 0 }), null);
});

test("answered turns count only finished answers, never the running one", () => {
	assert.equal(answeredTurns([{ status: "succeeded" }, { status: "running" }, { status: "failed" }]), 1);
	assert.equal(answeredInOverview({ turnCount: 6, currentTurnId: null }), 6);
	assert.equal(answeredInOverview({ turnCount: 1, currentTurnId: "t1" }), 0);
	assert.equal(answeredInOverview({ turnCount: 0, currentTurnId: "t1" }), 0);
});
