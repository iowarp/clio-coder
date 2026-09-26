import assert from "node:assert/strict";
import { test } from "node:test";
import { handoffDone, handoffRefusal } from "../client/chat/handoff-model.js";

test("a handoff refusal names what happened and keeps the service's own sentence", () => {
	assert.deepEqual(
		handoffRefusal({ status: "refused", level: "warn", code: "stale", reason: "draw it up again. Nothing was written" }),
		{ tone: "warning", title: "The conversation moved on", detail: "Draw it up again. Nothing was written." },
	);
	assert.equal(
		handoffRefusal({ status: "refused", level: "error", code: "novel", reason: "x." }).title,
		"Clio Coder refused the handoff",
	);
	assert.equal(handoffRefusal({ status: "refused", level: "error", code: "provider", reason: "x" }).tone, "error");
});

test("a committed handoff warns only when a step after the seed failed", () => {
	assert.equal(handoffDone([]).warning, null);
	assert.match(
		handoffDone(["handoff note failed: disk full"]).warning?.detail ?? "",
		/disk full\. The new conversation is seeded/,
	);
});
