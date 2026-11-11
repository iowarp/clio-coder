import assert from "node:assert/strict";
import { test } from "node:test";
import { admissionRefusedFrame } from "../../src/cli/run.js";

test("run --agent --json carries an admission_refused frame for a refused dispatch", () => {
	const frame = admissionRefusedFrame({ json: true, agentId: "coder" }, "admission refused: no route", true, 2);
	assert.deepEqual(frame, {
		type: "admission_refused",
		agentId: "coder",
		message: "admission refused: no route",
		exitCode: 2,
	});
});

test("no admission_refused frame in text mode or for a failure that was not a refusal", () => {
	assert.equal(admissionRefusedFrame({ json: false, agentId: "coder" }, "admission refused", true, 2), null);
	assert.equal(admissionRefusedFrame({ json: true, agentId: "coder" }, "worker crashed", false, 1), null);
});
