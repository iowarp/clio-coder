import assert from "node:assert/strict";
import { test } from "node:test";
import { HOST_READ_ONLY_SOURCES } from "../../src/tools/registry.js";

test("a run --read-only refusal tells the operator to rerun without the flag", () => {
	const remedy = HOST_READ_ONLY_SOURCES.run.remedy;
	assert.match(remedy, /rerun this task without the --read-only flag/);
	// A remedy ending on the flag was relayed as "--read-only flag removed".
	assert.doesNotMatch(remedy, /\(clio-coder run --read-only\)/);
});
