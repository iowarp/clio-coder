import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { planFacts, readDispatchPlan } from "../../src/interactive/dispatch-plan-summary.js";
import { describeDispatchPlan } from "../../src/tools/dispatch-plan.js";

test("the plan-card task preview keeps line breaks and tabs, and still neutralizes other control characters", () => {
	const view = describeDispatchPlan({
		tasks: [{ agent: "scout", task: "Survey the soil\nthen report\twith\u001b[31m colour" }],
	});
	const line = view.text.split("\n").find((row) => row.includes("task_preview="));
	ok(line, "the plan has a task line");
	ok(line.includes("task_preview="), "the preview stays on its one plan line");
	const summary = readDispatchPlan(view.text);
	ok(summary, "the card reads the plan");
	strictEqual(summary.members[0]?.task, "Survey the soil\nthen report with?[31m colour");
	const fact = planFacts(summary).find((entry) => entry.value.includes("Survey"));
	deepStrictEqual(fact?.value.split("\n").length, 2, "the card value carries a real line break");
});
