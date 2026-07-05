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
		"--target",
		shellQuote(target.id),
		...(target.model === undefined ? [] : ["--model", shellQuote(target.model)]),
		...(target.thinking === undefined ? [] : ["--thinking", shellQuote(target.thinking)]),
		shellQuote(prompt),
	];
	const result = await runShellCommand(`${process.execPath} ${args.join(" ")}`, cwd, runner.timeoutMs ?? timeoutMs);
	const tokens = tokensFromJsonl(result.stdout);
	return {
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
			"verifier.exitCode": result.exitCode,
		},
		artifacts: { stdout: result.stdout, stderr: result.stderr },
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

function numberField(record: Record<string, unknown>, field: string): number {
	const value = record[field];
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
