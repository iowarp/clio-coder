import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { shellQuote } from "../../../core/shell-quote.js";
import type { EvalRunnerV2, EvalSuiteTargetV2 } from "../schema/suite.js";
import { type EvalRunnerOutput, runShellCommand } from "./external-command.js";

export async function runContextInitRunner(
	runner: EvalRunnerV2,
	cwd: string,
	clioEntry: string,
	timeoutMs: number,
	target: EvalSuiteTargetV2,
	env?: NodeJS.ProcessEnv,
): Promise<EvalRunnerOutput> {
	const extraArgs = runner.args ?? [];
	const command = [
		process.execPath,
		clioEntry,
		"context",
		"init",
		"--yes",
		"--json",
		"--target",
		target.id,
		...(target.model === undefined ? [] : ["--model", target.model]),
		...(target.thinking === undefined ? [] : ["--thinking", target.thinking]),
		...extraArgs,
	]
		.map(shellQuote)
		.join(" ");
	const result = await runShellCommand(command, cwd, runner.timeoutMs ?? timeoutMs, env);
	const payload = parseInitPayload(result.stdout);
	const candidateGeneration = recordField(payload, "generation");
	const generation = isValidGenerationPayload(payload, candidateGeneration) ? candidateGeneration : null;
	const routeError = generation ? generationRouteError(generation, target) : null;
	const payloadError = generation ? routeError : "context-init runner did not receive a valid JSON generation result";
	const exitCode = result.exitCode === 0 && payloadError ? 1 : result.exitCode;
	const stderr = payloadError
		? `${result.stderr}${result.stderr.endsWith("\n") || result.stderr.length === 0 ? "" : "\n"}${payloadError}\n`
		: result.stderr;
	const run = recordField(generation, "run");
	const tokens = recordField(run, "tokens");
	const effectiveTarget = stringField(run, "targetId");
	const effectiveModel = stringField(run, "wireModelId");
	const effectiveRuntime = stringField(run, "runtimeId");
	const effectiveRuntimeKind = stringField(run, "runtimeKind");
	const effectiveThinking = stringField(run, "thinkingLevel");
	const structuredOutputMode = stringField(run, "structuredOutputMode");
	const clioMdPath = join(cwd, "CLIO-CODER.md");
	const clioMdBytes = existsSync(clioMdPath) ? statSync(clioMdPath).size : 0;
	return {
		assignmentId: null,
		terminalReceiptDigest: null,
		exitCode,
		stdout: result.stdout,
		stderr,
		wallTimeMs: result.wallTimeMs,
		metrics: {
			"latency.wallMs": result.wallTimeMs,
			"latency.modelMs": numberField(run, "durationMs"),
			"tokens.input": numberField(tokens, "input"),
			"tokens.output": numberField(tokens, "output"),
			"tokens.total": numberField(tokens, "total"),
			"tokens.cacheRead": numberField(tokens, "cacheRead"),
			"tokens.cacheWrite": numberField(tokens, "cacheWrite"),
			"tools.totalCalls": numberField(run, "toolCalls"),
			"tools.failed": numberField(run, "toolFailures"),
			"tools.blocked": numberField(run, "toolBlocked"),
			"context.clioMdBytes": clioMdBytes,
			"context.initMode": stringField(generation, "mode") ?? "unknown",
			"context.initParserOutcome": stringField(generation, "parserOutcome") ?? "unknown",
			"context.initFallback": stringField(generation, "fallbackReason") !== null,
			"context.initPromptBytes": numberField(run, "promptBytes"),
			"context.initOutputBytes": numberField(run, "outputBytes"),
			"context.initTargetId": effectiveTarget,
			"context.initModelId": effectiveModel,
			"context.initRuntimeId": effectiveRuntime,
			"context.initRuntimeKind": effectiveRuntimeKind,
			"context.initThinkingLevel": effectiveThinking,
			"context.initStructuredOutputMode": structuredOutputMode,
			"verifier.exitCode": exitCode,
		},
		artifacts: {
			stdout: result.stdout,
			stderr,
			requestedTarget: target.id,
			requestedModel: target.model ?? null,
			requestedThinking: target.thinking ?? null,
			effectiveTarget,
			effectiveModel,
			effectiveRuntime,
			effectiveThinking,
			bootstrapRunId: stringField(run, "runId"),
		},
	};
}

const GENERATION_MODES = new Set(["model", "heuristic", "existing"]);
const PARSER_OUTCOMES = new Set(["parsed", "rejected", "not-run"]);

function isNonnegativeFiniteNumber(value: unknown): boolean {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isValidRunPayload(value: unknown): boolean {
	const run = recordField(value);
	if (!run) return false;
	for (const key of ["durationMs", "promptBytes", "outputBytes"] as const) {
		if (!isNonnegativeFiniteNumber(run[key])) return false;
	}
	if (run.structuredOutputMode !== "native-schema" && run.structuredOutputMode !== "prompt-parser") return false;
	for (const key of ["toolCalls", "toolFailures", "toolBlocked"] as const) {
		if (run[key] !== undefined && !isNonnegativeFiniteNumber(run[key])) return false;
	}
	const tokens = recordField(run, "tokens");
	if (run.tokens !== undefined && !tokens) return false;
	if (tokens) {
		for (const key of ["total", "input", "output", "cacheRead", "cacheWrite", "reasoning"] as const) {
			if (tokens[key] !== undefined && !isNonnegativeFiniteNumber(tokens[key])) return false;
		}
	}
	return true;
}

function hasReceiptIdentity(run: Record<string, unknown> | null): boolean {
	if (!run) return false;
	return ["runId", "targetId", "wireModelId", "runtimeId", "runtimeKind", "thinkingLevel"].every(
		(key) => typeof run[key] === "string" && (run[key] as string).trim().length > 0,
	);
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
	const runPresent = generation.run !== undefined;
	if (runPresent && !isValidRunPayload(generation.run)) return false;
	const run = recordField(generation, "run");
	if (mode === "model" && (parserOutcome !== "parsed" || !hasReceiptIdentity(run))) return false;
	if ((parserOutcome === "parsed" || parserOutcome === "rejected") && !runPresent) return false;
	if (parserOutcome === "rejected" && !hasReceiptIdentity(run)) return false;
	return true;
}

function generationRouteError(generation: Record<string, unknown>, target: EvalSuiteTargetV2): string | null {
	const run = recordField(generation, "run");
	if (!run) return null;
	const actualTarget = stringField(run, "targetId");
	const actualModel = stringField(run, "wireModelId");
	const actualThinking = stringField(run, "thinkingLevel");
	if (actualTarget !== null && actualTarget !== target.id) {
		return `context-init runner requested target '${target.id}' but the bootstrap receipt used '${actualTarget}'`;
	}
	if (target.model !== undefined && actualModel !== null && actualModel !== target.model) {
		return `context-init runner requested model '${target.model}' but the bootstrap receipt used '${actualModel}'`;
	}
	if (target.thinking !== undefined && actualThinking !== null && actualThinking !== target.thinking) {
		return `context-init runner requested thinking '${target.thinking}' but the bootstrap receipt used '${actualThinking}'`;
	}
	return null;
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

function numberField(value: unknown, field: string): number | null {
	const record = recordField(value);
	const selected = record?.[field];
	return typeof selected === "number" && Number.isFinite(selected) ? selected : null;
}

function stringField(value: unknown, field: string): string | null {
	const record = recordField(value);
	const selected = record?.[field];
	return typeof selected === "string" && selected.length > 0 ? selected : null;
}
