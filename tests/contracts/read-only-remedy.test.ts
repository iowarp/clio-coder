import assert from "node:assert/strict";
import { test } from "node:test";
import { acpHostReadOnlySource, HOST_READ_ONLY_SOURCES } from "../../src/tools/registry.js";

test("a run --read-only refusal tells the operator to rerun without the flag", () => {
	const remedy = HOST_READ_ONLY_SOURCES.run.remedy;
	assert.match(remedy, /rerun this task without the --read-only flag/);
	// A remedy ending on the flag was relayed as "--read-only flag removed".
	assert.doesNotMatch(remedy, /\(clio-coder run --read-only\)/);
});

// TC-1 Q4: an `acp --read-only` denial told the model the client set readOnly and could lift it.
test("an acp --read-only refusal names the server flag and never sends the model to the client", () => {
	const server = HOST_READ_ONLY_SOURCES[acpHostReadOnlySource(true)];
	assert.match(server.detail, /clio-coder acp --read-only/);
	assert.match(server.remedy, /restart the ACP server without the --read-only flag/);
	assert.doesNotMatch(`${server.detail} ${server.remedy}`, /ACP client (?:set|must)/);
	assert.match(HOST_READ_ONLY_SOURCES[acpHostReadOnlySource(false)].detail, /ACP client set readOnly/);
});
