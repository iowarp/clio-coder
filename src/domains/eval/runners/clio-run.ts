import {
	dispatchCountFromJsonl,
	evidenceMetricsFromReceipt,
	receiptFromRunJsonStdout,
	scoutDispatchCountFromJsonl,
	wikiStaleAcknowledgedFromJsonl,
} from "../metrics/evidence.js";
import type { EvalRunnerV2, EvalSuiteTargetV2 } from "../schema/suite.js";
import { type EvalRunnerOutput, runShellCommand, shellQuote } from "./external-command.js";

export async function runClioRunRunner(
	runner: EvalRunnerV2,
	cwd: string,
	clioEntry: string,
	timeoutMs: number,
	target: EvalSuiteTargetV2,
): Promise<EvalRunnerOutput> {
	const prompt = runner.prompt ?? "";
	const args = [
		shellQuote(clioEntry),
		"run",
		"--json",
		...(runner.agent === undefined ? [] : ["--agent", shellQuote(runner.agent)]),
		"--target",
		shellQuote(target.id),
		...(target.model === undefined ? [] : ["--model", shellQuote(target.model)]),
		...(target.thinking === undefined ? [] : ["--thinking", shellQuote(target.thinking)]),
		shellQuote(prompt),
	];
	const result = await runShellCommand(`${process.execPath} ${args.join(" ")}`, cwd, runner.timeoutMs ?? timeoutMs);
	const tokens = tokensFromJsonl(result.stdout);
	const toolMetricStream = result.metricJsonl.length > 0 ? result.metricJsonl : result.stdout;
	const tools = toolCallMetricsFromJsonl(toolMetricStream);
	// Evidence metrics resolve only from the sealed receipt the --agent path
	// prints; a runner without a receipt leaves them absent so any gate on
	// them fails closed instead of reading prose labels.
	const receipt = receiptFromRunJsonStdout(result.stdout);
	return {
		assignmentId: receipt === null ? null : (receipt.lineage?.rootRunId ?? receipt.runId),
		terminalReceiptDigest: receipt?.integrity.digest ?? null,
		exitCode: result.exitCode,
		stdout: result.stdout,
		stderr: result.stderr,
		wallTimeMs: result.wallTimeMs,
		metrics: {
			"latency.wallMs": result.wallTimeMs,
			"tokens.input": tokens.input,
			"tokens.output": tokens.output,
			"tokens.total": tokens.total,
			"tokens.cacheRead": tokens.cacheRead,
			"tokens.cacheWrite": tokens.cacheWrite,
			"tools.totalCalls": tools.totalCalls,
			"tools.failed": tools.failed,
			"tools.blocked": tools.blocked,
			"verifier.exitCode": result.exitCode,
			"dispatch.count": dispatchCountFromJsonl(toolMetricStream),
			"dispatch.scoutCount": scoutDispatchCountFromJsonl(toolMetricStream),
			"wiki.staleAcknowledged": wikiStaleAcknowledgedFromJsonl(toolMetricStream),
			...(receipt === null ? {} : evidenceMetricsFromReceipt(receipt)),
			...(receipt === null
				? {}
				: { "evidence.qualityLabel": receipt.quality.typedValidations.length > 0 ? "measured" : "unmeasured" }),
		},
		artifacts: {
			stdout: result.stdout,
			stderr: result.stderr,
			...(receipt === null ? {} : { receipt: JSON.stringify(receipt) }),
		},
	};
}

function tokensFromJsonl(stdout: string): {
	input: number;
	output: number;
	total: number;
	cacheRead: number;
	cacheWrite: number;
} {
	const totals = { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 };
	for (const line of stdout.split(/\r?\n/)) {
		if (line.trim().length === 0) continue;
		try {
			const parsed = JSON.parse(line) as Record<string, unknown>;
			const message = isRecord(parsed.message) ? parsed.message : parsed;
			const usage = isRecord(message.usage) ? message.usage : undefined;
			if (usage === undefined) continue;
			totals.input = Math.max(totals.input, numberField(usage, "inputTokens"));
			totals.output = Math.max(totals.output, numberField(usage, "outputTokens"));
			totals.total = Math.max(totals.total, numberField(usage, "totalTokens"));
			totals.cacheRead = Math.max(totals.cacheRead, numberField(usage, "cacheReadTokens"));
			totals.cacheWrite = Math.max(totals.cacheWrite, numberField(usage, "cacheWriteTokens"));
		} catch {}
	}
	return totals;
}

type ToolCallMetrics = {
	totalCalls: number;
	failed: number;
	blocked: number;
};

type ToolOutcome = "ok" | "error" | "blocked";

/** Fold the terminal tool events emitted by `clio run --json`. */
export function toolCallMetricsFromJsonl(stdout: string): ToolCallMetrics {
	const executionEnds: ToolCallMetrics = { totalCalls: 0, failed: 0, blocked: 0 };
	const canonicalFinishes: ToolCallMetrics = { totalCalls: 0, failed: 0, blocked: 0 };
	const seenExecutionEnds = new Set<string>();
	const seenCanonicalFinishes = new Set<string>();

	for (const line of stdout.split(/\r?\n/)) {
		if (line.trim().length === 0) continue;
		let event: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(line);
			if (!isRecord(parsed)) continue;
			event = parsed;
		} catch {
			continue;
		}

		if (event.type === "tool_execution_end") {
			const callId = stringField(event, "toolCallId");
			if (callId !== undefined) {
				if (seenExecutionEnds.has(callId)) continue;
				seenExecutionEnds.add(callId);
			}
			recordToolOutcome(executionEnds, toolOutcome(event) ?? (event.isError === true ? "error" : "ok"));
			continue;
		}

		if (event.type !== "clio_tool_finish" || !isRecord(event.payload)) continue;
		const outcome = toolOutcome(event.payload);
		if (outcome === undefined) continue;
		const callId = stringField(event.payload, "toolCallId") ?? stringField(event, "toolCallId");
		if (callId !== undefined) {
			if (seenCanonicalFinishes.has(callId)) continue;
			seenCanonicalFinishes.add(callId);
		}
		recordToolOutcome(canonicalFinishes, outcome);
	}

	// Some runtimes emit both pi's execution end and Clio's richer finish
	// event for the same call. Prefer the finish stream wholesale so a call is
	// counted once and blocked admissions stay distinct from execution errors.
	return canonicalFinishes.totalCalls > 0 ? canonicalFinishes : executionEnds;
}

function recordToolOutcome(metrics: ToolCallMetrics, outcome: ToolOutcome): void {
	metrics.totalCalls += 1;
	if (outcome === "error") metrics.failed += 1;
	else if (outcome === "blocked") metrics.blocked += 1;
}

function toolOutcome(record: Record<string, unknown>): ToolOutcome | undefined {
	const outcome = record.outcome;
	return outcome === "ok" || outcome === "error" || outcome === "blocked" ? outcome : undefined;
}

function numberField(record: Record<string, unknown>, field: string): number {
	const value = record[field];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
	const value = record[field];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
