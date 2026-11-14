import assert from "node:assert/strict";
import { test } from "node:test";
import { type Notice, problemHeading, problemNotice, withNotice } from "../client/design/notification-model.js";
import { ProblemCode } from "../contracts/common.js";

test("a problem titled with its own code gets a heading a person can act on", () => {
	assert.equal(problemHeading({ code: "conflict", title: "conflict" }), "Not possible right now");
	assert.equal(problemHeading({ code: "upstream_acp", title: "upstream acp" }), "CLIO Coder engine problem");
	assert.equal(problemHeading({ code: "validation", title: "" }), "Check the input");
	// The client's own titles already read as headings and are kept.
	assert.equal(problemHeading({ code: "unavailable", title: "Server unavailable" }), "Server unavailable");
	// A code the table does not know still starts with a capital.
	assert.equal(problemHeading({ code: "rate_limited", title: "rate limited" }), "Rate limited");
});

test("every problem code has its own non-empty heading", () => {
	for (const member of ProblemCode.anyOf) {
		const code = member.const;
		const heading = problemHeading({ code, title: code.replaceAll("_", " ") });
		assert.ok(heading.trim().length > 0, code);
		assert.notEqual(heading, code.replaceAll("_", " "), code);
	}
});

test("three identical unscoped problems are one notice counted three times", () => {
	const problem = { code: "validation", title: "validation", detail: "Name is required.", instance: "req-1" };
	let list: Notice[] = [];
	for (let at = 0; at < 3; at += 1) {
		const repeat = { ...problem, instance: `req-${at}` };
		list = withNotice(list, { ...problemNotice(list, repeat, undefined, `fresh-${at}`), ttl: null, at });
	}
	assert.equal(list.length, 1);
	assert.equal(list[0]?.occurrences, 3);
	assert.equal(list[0]?.title, "Check the input");
	// A different detail is a different problem.
	const other = { ...problem, detail: "Path is required." };
	list = withNotice(list, { ...problemNotice(list, other, undefined, "fresh-x"), ttl: null, at: 3 });
	assert.equal(list.length, 2);
});

test("a scoped problem only repeats within its scope, and the list keeps the newest five", () => {
	const problem = { code: "unavailable", title: "unavailable", detail: "Down.", instance: "req" };
	let list: Notice[] = [];
	list = withNotice(list, { ...problemNotice(list, problem, "sessions", "a"), ttl: null, at: 0 });
	list = withNotice(list, { ...problemNotice(list, problem, "workspaces", "b"), ttl: null, at: 1 });
	assert.deepEqual(
		list.map((notice) => notice.id),
		["a", "b"],
	);
	for (let at = 0; at < 6; at += 1) {
		list = withNotice(list, { id: `n-${at}`, tone: "info", title: `Notice ${at}`, ttl: null, at: 2 + at });
	}
	assert.deepEqual(
		list.map((notice) => notice.id),
		["n-1", "n-2", "n-3", "n-4", "n-5"],
	);
});
