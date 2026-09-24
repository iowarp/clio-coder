import { match, strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { bashTool, lastActivePytestTest } from "../../src/tools/bash.js";

it("reports the last announced pytest test when a bounded run times out", async () => {
	const command = "printf 'tests/test_commands.py::TestProcessCommand::test_process_json\\n'; sleep 5; : pytest";
	const result = await bashTool.run({ command, timeout_ms: 250 });
	strictEqual(result.kind, "error");
	if (result.kind !== "error") return;
	match(result.message, /timed out after 250ms; validation did not finish/u);
	match(result.message, /Last active pytest test: tests\/test_commands\.py::TestProcessCommand::test_process_json/u);
	match(result.message, /Narrow the test selection/u);
	strictEqual(result.details?.lastActiveTest, "tests/test_commands.py::TestProcessCommand::test_process_json");
	strictEqual(result.details?.timedOut, true);
});

it("does not infer a pytest test from unrelated timed-out output", () => {
	strictEqual(lastActivePytestTest("npm run build", "tests/test_commands.py::test_process_json"), null);
});
