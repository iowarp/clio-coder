import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { EvalRunnerV2 } from "../schema/suite.js";
import { type EvalRunnerOutput, runShellCommand, shellQuote } from "./external-command.js";

export async function runContextInitRunner(
	runner: EvalRunnerV2,
	cwd: string,
	clioEntry: string,
	timeoutMs: number,
): Promise<EvalRunnerOutput> {
	const extraArgs = runner.args ?? [];
	const command = [process.execPath, clioEntry, "context", "init", "--yes", "--json", ...extraArgs]
		.map(shellQuote)
		.join(" ");
	const result = await runShellCommand(command, cwd, runner.timeoutMs ?? timeoutMs);
	const payload = parseInitPayload(result.stdout);
	const candidateGeneration = recordField(payload, "generation");
	const generation = isValidGenerationPayload(payload, candidateGeneration) ? candidateGeneration : null;
	const payloadError = generation ? null : "context-init runner did not receive a valid JSON generation result";
	const exitCode = result.exitCode === 0 && payloadError ? 1 : result.exitCode;
	const stderr = payloadError
		? `${result.stderr}${result.stderr.endsWith("\n") || result.stderr.length === 0 ? "" : "\n"}${payloadError}\n`
		: result.stderr;
	const scout = recordField(generation, "scout");
	const tokens = recordField(scout, "tokens");
	const clioMdPath = join(cwd, "CLIO.md");
	const clioMdBytes = existsSync(clioMdPath) ? statSync(clioMdPath).size : 0;
	return {
		exitCode,
		stdout: result.stdout,
		stderr,
		wallTimeMs: result.wallTimeMs,
		metrics: {
			"latency.wallMs": result.wallTimeMs,
			"latency.modelMs": numberField(scout, "durationMs"),
			"tokens.input": numberField(tokens, "input"),
			"tokens.output": numberField(tokens, "output"),
			"tokens.total": numberField(tokens, "total"),
			"tokens.cacheRead": numberField(tokens, "cacheRead"),
			"tokens.cacheWrite": numberField(tokens, "cacheWrite"),
			"tools.totalCalls": numberField(scout, "toolCalls"),
			"tools.failed": numberField(scout, "toolFailures"),
			"tools.blocked": numberField(scout, "toolBlocked"),
			"context.clioMdBytes": clioMdBytes,
			"context.initMode": stringField(generation, "mode") ?? "unknown",
			"context.initParserOutcome": stringField(generation, "parserOutcome") ?? "unknown",
			"context.initFallback": stringField(generation, "fallbackReason") !== null,
			"context.initPromptBytes": numberField(scout, "promptBytes"),
			"context.initOutputBytes": numberField(scout, "outputBytes"),
			"verifier.exitCode": exitCode,
		},
		artifacts: { stdout: result.stdout, stderr },
	};
}

const GENERATION_MODES = new Set(["scout", "heuristic", "existing"]);
const PARSER_OUTCOMES = new Set(["parsed", "rejected", "not-run"]);

function isNonnegativeFiniteNumber(value: unknown): boolean {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isValidScoutPayload(value: unknown): boolean {
	const scout = recordField(value);
	if (!scout) return false;
	for (const key of ["durationMs", "promptBytes", "outputBytes"] as const) {
		if (!isNonnegativeFiniteNumber(scout[key])) return false;
	}
	for (const key of ["toolCalls", "toolFailures", "toolBlocked"] as const) {
		if (scout[key] !== undefined && !isNonnegativeFiniteNumber(scout[key])) return false;
	}
	const tokens = recordField(scout, "tokens");
	if (scout.tokens !== undefined && !tokens) return false;
	if (tokens) {
		for (const key of ["total", "input", "output", "cacheRead", "cacheWrite", "reasoning"] as const) {
			if (tokens[key] !== undefined && !isNonnegativeFiniteNumber(tokens[key])) return false;
		}
	}
	return true;
}

function isValidGenerationPayload(
	payload: Record<string, unknown> | null,
	generation: Record<string, unknown> | null,
): generation is Record<string, unknown> {
	if (payload?.version !== 1 || !generation) return false;
	const mode = generation.mode;
	const parserOutcome = generation.parserOutcome;
	if (typeof mode !== "string" || !GENERATION_MODES.has(mode)) return false;
	if (typeof parserOutcome !== "string" || !PARSER_OUTCOMES.has(parserOutcome)) return false;
	if (
		generation.fallbackReason !== undefined &&
		(typeof generation.fallbackReason !== "string" || generation.fallbackReason.trim().length === 0)
	) {
		return false;
	}
	const scoutPresent = generation.scout !== undefined;
	if (scoutPresent && !isValidScoutPayload(generation.scout)) return false;
	if (mode === "scout" && (parserOutcome !== "parsed" || !scoutPresent)) return false;
	if ((parserOutcome === "parsed" || parserOutcome === "rejected") && !scoutPresent) return false;
	return true;
}

function parseInitPayload(stdout: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(stdout);
		return recordField(parsed);
	} catch {
		return null;
	}
}

function recordField(value: unknown, field?: string): Record<string, unknown> | null {
	const selected =
		field && typeof value === "object" && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)[field]
			: value;
	return typeof selected === "object" && selected !== null && !Array.isArray(selected)
		? (selected as Record<string, unknown>)
		: null;
}

function numberField(value: unknown, field: string): number {
	const record = recordField(value);
	const selected = record?.[field];
	return typeof selected === "number" && Number.isFinite(selected) ? selected : 0;
}

function stringField(value: unknown, field: string): string | null {
	const record = recordField(value);
	const selected = record?.[field];
	return typeof selected === "string" && selected.length > 0 ? selected : null;
}
