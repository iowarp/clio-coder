import { match, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import {
	PROACTIVE_MEMORY_EVAL_TASKS,
	type ProactiveMemoryEvalTrial,
	renderProactiveMemoryEvalReport,
	runProactiveMemoryEval,
	summarizeProactiveMemoryEval,
} from "../../src/domains/eval/proactive-memory.js";
import { type TaskMemoryPolicyDecision, taskMemoryTelemetryRecord } from "../../src/domains/memory/index.js";

const ZERO_DELTA = {
	status: { added: 0, updated: 0, deleted: 0 },
	knowledge: { added: 0, updated: 0, deleted: 0 },
	procedural: { added: 0, updated: 0, deleted: 0 },
} as const;

function step(decision: TaskMemoryPolicyDecision, citedEntries: number, tokens = 5, latencyMs = 2) {
	return taskMemoryTelemetryRecord(
		{
			triggerReasons: ["manual"],
			tier: "llm",
			bankDelta: ZERO_DELTA,
			decision,
			citedEntries,
			inputTokens: tokens,
			outputTokens: 0,
			latencyMs,
		},
		new Date("2026-07-13T12:00:00.000Z"),
	);
}

describe("contracts/proactive-memory A/B harness", () => {
	it("runs the fixed three-task matrix end to end for any target and reports measured overhead", async () => {
		const calls: string[] = [];
		const report = await runProactiveMemoryEval({
			target: { id: "custom-local-target", model: "custom-local-model" },
			async run(request) {
				calls.push(`${request.variant}:${request.task.id}:${request.target.id}:${request.target.model}`);
				const taskIndex = PROACTIVE_MEMORY_EVAL_TASKS.findIndex((task) => task.id === request.task.id);
				const pass =
					request.variant === "baseline" ? taskIndex === 2 : request.variant === "rules" ? taskIndex !== 1 : true;
				const memorySteps =
					request.variant === "baseline"
						? []
						: request.variant === "rules"
							? taskIndex === 0
								? [step("injected", 1, 0, 1)]
								: [step("silent", 0, 0, 1)]
							: taskIndex < 2
								? [step("injected", 1)]
								: [step("silent", 0)];
				return {
					pass,
					actionInputTokens: 60,
					actionOutputTokens: 40,
					actionLatencyMs: 100,
					memorySteps,
				};
			},
		});

		strictEqual(PROACTIVE_MEMORY_EVAL_TASKS.length, 3);
		strictEqual(calls.length, 9);
		strictEqual(report.tasks, 3);
		strictEqual(report.target.id, "custom-local-target");
		const baseline = report.variants.find((row) => row.variant === "baseline");
		const rules = report.variants.find((row) => row.variant === "rules");
		const llm = report.variants.find((row) => row.variant === "llm");
		ok(baseline && rules && llm);
		strictEqual(baseline.passRate, 1 / 3);
		strictEqual(rules.passRate, 2 / 3);
		strictEqual(rules.injectedReminders, 1);
		strictEqual(rules.citedReminders, 1);
		strictEqual(rules.addedTokens, 0);
		strictEqual(rules.addedLatencyMs, 3);
		strictEqual(llm.passRate, 1);
		strictEqual(llm.injectedReminders, 2);
		strictEqual(llm.citedReminderRate, 1);
		strictEqual(llm.addedTokens, 15);
		strictEqual(llm.addedLatencyMs, 6);
		strictEqual(llm.alwaysNoisyRegression, false);
		match(renderProactiveMemoryEvalReport(report), /llm\s+3\/3 \(100\.0%\)\s+2\s+2\/2\s+\+15/u);
	});

	it("marks always-on reminders as a regression when pass rate only ties", () => {
		const trials: ProactiveMemoryEvalTrial[] = [];
		for (const variant of ["baseline", "rules", "llm"] as const) {
			for (const task of PROACTIVE_MEMORY_EVAL_TASKS) {
				trials.push({
					taskId: task.id,
					variant,
					pass: task.id === "healthy-trajectory-silence",
					actionTokens: 100,
					memoryTokens: variant === "baseline" ? 0 : 5,
					totalTokens: variant === "baseline" ? 100 : 105,
					actionLatencyMs: 100,
					memoryLatencyMs: variant === "baseline" ? 0 : 2,
					totalLatencyMs: variant === "baseline" ? 100 : 102,
					injectedReminders: variant === "baseline" ? 0 : 1,
					citedReminders: variant === "baseline" ? 0 : 1,
					error: null,
				});
			}
		}
		const summaries = summarizeProactiveMemoryEval(trials);
		strictEqual(summaries.find((row) => row.variant === "baseline")?.alwaysNoisyRegression, false);
		strictEqual(summaries.find((row) => row.variant === "rules")?.alwaysNoisyRegression, true);
		strictEqual(summaries.find((row) => row.variant === "llm")?.alwaysNoisyRegression, true);
	});

	it("fails a malformed trial closed without aborting the rest of the matrix", async () => {
		const report = await runProactiveMemoryEval({
			target: { id: "dynamo", model: "qwopus3.6-35b-a3b-coder-mtp" },
			async run(request) {
				return {
					pass: true,
					actionInputTokens: request.variant === "rules" && request.task.id === PROACTIVE_MEMORY_EVAL_TASKS[0]?.id ? -1 : 1,
					actionOutputTokens: 1,
					actionLatencyMs: 1,
					memorySteps: [],
				};
			},
		});
		strictEqual(report.trials.length, 9);
		const failed = report.trials.find((trial) => trial.error !== null);
		ok(failed);
		match(failed.error ?? "", /actionInputTokens/u);
	});
});
