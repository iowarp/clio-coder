import type { TaskMemoryTelemetryRecord } from "../memory/task-memory-telemetry.js";

export const PROACTIVE_MEMORY_EVAL_VARIANTS = ["baseline", "rules", "llm"] as const;
export type ProactiveMemoryEvalVariant = (typeof PROACTIVE_MEMORY_EVAL_VARIANTS)[number];

export interface ProactiveMemoryEvalTarget {
	id: string;
	model: string;
}

export interface ProactiveMemoryEvalTask {
	id: string;
	prompt: string;
	expectedSignal: "repeated_failure" | "post_compaction" | "silence";
}

/** Small fixed behavioral set; adapters may execute it in any isolated workspace. */
export const PROACTIVE_MEMORY_EVAL_TASKS: ReadonlyArray<ProactiveMemoryEvalTask> = [
	{
		id: "repeat-failure-recovery",
		prompt: "Recover after the same tool action fails twice without repeating that failed action a third time.",
		expectedSignal: "repeated_failure",
	},
	{
		id: "post-compaction-constraint",
		prompt: "After compaction, preserve and act on the previously recorded task constraint.",
		expectedSignal: "post_compaction",
	},
	{
		id: "healthy-trajectory-silence",
		prompt: "Complete a healthy short trajectory without an irrelevant memory reminder.",
		expectedSignal: "silence",
	},
];

export interface ProactiveMemoryEvalRunRequest {
	variant: ProactiveMemoryEvalVariant;
	task: ProactiveMemoryEvalTask;
	/** The adapter uses this route for the LLM tier; other tiers must not call it. */
	target: ProactiveMemoryEvalTarget;
}

export interface ProactiveMemoryEvalRunOutput {
	pass: boolean;
	actionInputTokens: number;
	actionOutputTokens: number;
	actionLatencyMs: number;
	memorySteps: ReadonlyArray<TaskMemoryTelemetryRecord>;
}

export type ProactiveMemoryEvalRunner = (
	request: ProactiveMemoryEvalRunRequest,
) => Promise<ProactiveMemoryEvalRunOutput>;

export interface ProactiveMemoryEvalTrial {
	taskId: string;
	variant: ProactiveMemoryEvalVariant;
	pass: boolean;
	actionTokens: number;
	memoryTokens: number;
	totalTokens: number;
	actionLatencyMs: number;
	memoryLatencyMs: number;
	totalLatencyMs: number;
	injectedReminders: number;
	citedReminders: number;
	error: string | null;
}

export interface ProactiveMemoryEvalVariantSummary {
	variant: ProactiveMemoryEvalVariant;
	runs: number;
	passed: number;
	passRate: number;
	injectedReminders: number;
	citedReminders: number;
	uncitedReminders: number;
	remindersPerTask: number;
	citedReminderRate: number;
	totalTokens: number;
	addedTokens: number;
	totalLatencyMs: number;
	addedLatencyMs: number;
	alwaysNoisyRegression: boolean;
}

export interface ProactiveMemoryEvalReport {
	target: ProactiveMemoryEvalTarget;
	tasks: number;
	trials: ProactiveMemoryEvalTrial[];
	variants: ProactiveMemoryEvalVariantSummary[];
}

export interface RunProactiveMemoryEvalOptions {
	target: ProactiveMemoryEvalTarget;
	run: ProactiveMemoryEvalRunner;
	tasks?: ReadonlyArray<ProactiveMemoryEvalTask>;
}

/**
 * Run matched baseline/rules/LLM trials. The runner owns workspace/model
 * execution; this harness owns fixed ordering, measurement, and regression
 * semantics so any configured local target can be compared consistently.
 */
export async function runProactiveMemoryEval(
	options: RunProactiveMemoryEvalOptions,
): Promise<ProactiveMemoryEvalReport> {
	const target = validatedTarget(options.target);
	const tasks = options.tasks ?? PROACTIVE_MEMORY_EVAL_TASKS;
	if (tasks.length < 3) throw new Error("proactive-memory eval requires at least three tasks");
	const ids = new Set<string>();
	for (const task of tasks) {
		if (!task.id.trim() || ids.has(task.id)) throw new Error(`invalid or duplicate proactive-memory task id: ${task.id}`);
		ids.add(task.id);
	}

	const trials: ProactiveMemoryEvalTrial[] = [];
	for (const variant of PROACTIVE_MEMORY_EVAL_VARIANTS) {
		for (const task of tasks) {
			try {
				const output = await options.run({ variant, task, target });
				trials.push(trialFromOutput(task.id, variant, output));
			} catch (error) {
				trials.push(failedTrial(task.id, variant, error));
			}
		}
	}
	return {
		target,
		tasks: tasks.length,
		trials,
		variants: summarizeProactiveMemoryEval(trials),
	};
}

export function summarizeProactiveMemoryEval(
	trials: ReadonlyArray<ProactiveMemoryEvalTrial>,
): ProactiveMemoryEvalVariantSummary[] {
	const baselineByTask = new Map(
		trials.filter((trial) => trial.variant === "baseline").map((trial) => [trial.taskId, trial]),
	);
	const baselinePassRate = passRate(trials.filter((trial) => trial.variant === "baseline"));
	return PROACTIVE_MEMORY_EVAL_VARIANTS.map((variant) => {
		const selected = trials.filter((trial) => trial.variant === variant);
		const passed = selected.filter((trial) => trial.pass).length;
		const injectedReminders = sum(selected, (trial) => trial.injectedReminders);
		const citedReminders = sum(selected, (trial) => trial.citedReminders);
		const totalTokens = sum(selected, (trial) => trial.totalTokens);
		const totalLatencyMs = sum(selected, (trial) => trial.totalLatencyMs);
		const addedTokens = sum(selected, (trial) => {
			const baseline = baselineByTask.get(trial.taskId);
			return baseline === undefined ? trial.totalTokens : trial.totalTokens - baseline.totalTokens;
		});
		const addedLatencyMs = sum(selected, (trial) => {
			const baseline = baselineByTask.get(trial.taskId);
			return baseline === undefined ? trial.totalLatencyMs : trial.totalLatencyMs - baseline.totalLatencyMs;
		});
		const currentPassRate = selected.length === 0 ? 0 : passed / selected.length;
		return {
			variant,
			runs: selected.length,
			passed,
			passRate: currentPassRate,
			injectedReminders,
			citedReminders,
			uncitedReminders: Math.max(0, injectedReminders - citedReminders),
			remindersPerTask: selected.length === 0 ? 0 : injectedReminders / selected.length,
			citedReminderRate: injectedReminders === 0 ? 0 : citedReminders / injectedReminders,
			totalTokens,
			addedTokens,
			totalLatencyMs,
			addedLatencyMs,
			alwaysNoisyRegression:
				variant !== "baseline" &&
				selected.length > 0 &&
				injectedReminders >= selected.length &&
				currentPassRate <= baselinePassRate,
		};
	});
}

export function renderProactiveMemoryEvalReport(report: ProactiveMemoryEvalReport): string {
	const lines = [
		`proactive-memory eval: ${report.tasks} tasks · target ${report.target.id} · model ${report.target.model}`,
		"variant   pass       reminders  cited  added tokens  added latency  verdict",
	];
	for (const row of report.variants) {
		lines.push(
			[
				row.variant.padEnd(9),
				`${row.passed}/${row.runs} (${(row.passRate * 100).toFixed(1)}%)`.padEnd(10),
				String(row.injectedReminders).padEnd(10),
				`${row.citedReminders}/${row.injectedReminders}`.padEnd(6),
				signed(row.addedTokens).padEnd(13),
				`${signed(Math.round(row.addedLatencyMs))}ms`.padEnd(14),
				row.alwaysNoisyRegression ? "REGRESSION: always noisy without a pass-rate gain" : "measured",
			].join(" "),
		);
	}
	return `${lines.join("\n")}\n`;
}

function trialFromOutput(
	taskId: string,
	variant: ProactiveMemoryEvalVariant,
	output: ProactiveMemoryEvalRunOutput,
): ProactiveMemoryEvalTrial {
	const actionInput = metric(output.actionInputTokens, "actionInputTokens");
	const actionOutput = metric(output.actionOutputTokens, "actionOutputTokens");
	const actionLatencyMs = finiteMetric(output.actionLatencyMs, "actionLatencyMs");
	if (variant === "baseline" && output.memorySteps.length > 0) {
		throw new Error("baseline proactive-memory trial emitted memory telemetry");
	}
	const memoryTokens = sum(output.memorySteps, (step) => step.tokenCost.total);
	const memoryLatencyMs = sum(output.memorySteps, (step) => step.latencyMs);
	const injected = output.memorySteps.filter((step) => step.decision === "injected");
	const citedReminders = injected.filter((step) => step.citedEntries > 0).length;
	const actionTokens = actionInput + actionOutput;
	return {
		taskId,
		variant,
		pass: output.pass,
		actionTokens,
		memoryTokens,
		totalTokens: actionTokens + memoryTokens,
		actionLatencyMs,
		memoryLatencyMs,
		totalLatencyMs: actionLatencyMs + memoryLatencyMs,
		injectedReminders: injected.length,
		citedReminders,
		error: null,
	};
}

function failedTrial(taskId: string, variant: ProactiveMemoryEvalVariant, error: unknown): ProactiveMemoryEvalTrial {
	return {
		taskId,
		variant,
		pass: false,
		actionTokens: 0,
		memoryTokens: 0,
		totalTokens: 0,
		actionLatencyMs: 0,
		memoryLatencyMs: 0,
		totalLatencyMs: 0,
		injectedReminders: 0,
		citedReminders: 0,
		error: error instanceof Error ? error.message : String(error),
	};
}

function validatedTarget(target: ProactiveMemoryEvalTarget): ProactiveMemoryEvalTarget {
	const id = target.id.trim();
	const model = target.model.trim();
	if (!id || !model) throw new Error("proactive-memory eval requires a target id and model id");
	return { id, model };
}

function passRate(trials: ReadonlyArray<ProactiveMemoryEvalTrial>): number {
	return trials.length === 0 ? 0 : trials.filter((trial) => trial.pass).length / trials.length;
}

function sum<T>(items: ReadonlyArray<T>, value: (item: T) => number): number {
	return items.reduce((total, item) => total + value(item), 0);
}

function metric(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative safe integer`);
	return value;
}

function finiteMetric(value: number, name: string): number {
	if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative finite number`);
	return value;
}

function signed(value: number): string {
	return `${value >= 0 ? "+" : ""}${value}`;
}
