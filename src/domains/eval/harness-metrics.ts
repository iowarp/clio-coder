import type { RunReceipt } from "../dispatch/types.js";
import type { EvalCommandResult, EvalHarnessMetrics, EvalRunRecord } from "./types.js";

export const ZERO_EVAL_HARNESS_METRICS: EvalHarnessMetrics = {
	receiptCount: 0,
	toolCalls: 0,
	retries: 0,
	safetyBlocks: 0,
	correctionLatencyMs: 0,
	validationEvidence: 0,
};

export function evalHarnessMetricsFromCommands(commands: ReadonlyArray<EvalCommandResult>): EvalHarnessMetrics {
	return {
		...ZERO_EVAL_HARNESS_METRICS,
		validationEvidence: commands.filter(
			(command) => command.phase === "verifier" && command.exitCode === 0 && !command.timedOut,
		).length,
	};
}

export function evalHarnessMetricsFromReceipt(
	receipt: RunReceipt,
	extras: Partial<Pick<EvalHarnessMetrics, "retries" | "correctionLatencyMs" | "validationEvidence">> = {},
): EvalHarnessMetrics {
	return {
		receiptCount: 1,
		toolCalls: receipt.toolCalls,
		retries: extras.retries ?? 0,
		safetyBlocks: receipt.safety?.decisions.blocked ?? 0,
		correctionLatencyMs: extras.correctionLatencyMs ?? 0,
		validationEvidence: extras.validationEvidence ?? 0,
	};
}

export function sumEvalHarnessMetrics(records: ReadonlyArray<EvalRunRecord>): EvalHarnessMetrics {
	return records.reduce((total, record) => addEvalHarnessMetrics(total, record.harness), {
		...ZERO_EVAL_HARNESS_METRICS,
	});
}

export function addEvalHarnessMetrics(left: EvalHarnessMetrics, right: EvalHarnessMetrics): EvalHarnessMetrics {
	return {
		receiptCount: left.receiptCount + right.receiptCount,
		toolCalls: left.toolCalls + right.toolCalls,
		retries: left.retries + right.retries,
		safetyBlocks: left.safetyBlocks + right.safetyBlocks,
		correctionLatencyMs: left.correctionLatencyMs + right.correctionLatencyMs,
		validationEvidence: left.validationEvidence + right.validationEvidence,
	};
}

export function subtractEvalHarnessMetrics(left: EvalHarnessMetrics, right: EvalHarnessMetrics): EvalHarnessMetrics {
	return {
		receiptCount: left.receiptCount - right.receiptCount,
		toolCalls: left.toolCalls - right.toolCalls,
		retries: left.retries - right.retries,
		safetyBlocks: left.safetyBlocks - right.safetyBlocks,
		correctionLatencyMs: left.correctionLatencyMs - right.correctionLatencyMs,
		validationEvidence: left.validationEvidence - right.validationEvidence,
	};
}
