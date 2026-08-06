import type { EvalSuiteTargetV2 } from "../schema/suite.js";
import { type EvalRunnerOutput, runShellCommand, shellQuote } from "./external-command.js";

export async function runContextIndexRunner(
	cwd: string,
	clioEntry: string,
	timeoutMs: number,
	target: EvalSuiteTargetV2,
	env?: NodeJS.ProcessEnv,
): Promise<EvalRunnerOutput> {
	const result = await runShellCommand(
		`${shellQuote(process.execPath)} ${shellQuote(clioEntry)} context index --json`,
		cwd,
		timeoutMs,
		env,
	);
	const parsed = parseContextIndexOutput(result.stdout);
	return {
		assignmentId: null,
		terminalReceiptDigest: null,
		exitCode: result.exitCode,
		stdout: result.stdout,
		stderr: result.stderr,
		wallTimeMs: result.wallTimeMs,
		metrics: {
			"latency.wallMs": result.wallTimeMs,
			"context.indexedFiles": parsed.indexedSourceFiles ?? 0,
			"context.coverage": parsed.coverage ?? 0,
			"context.structuralHash": parsed.structuralHash ?? null,
			"verifier.exitCode": result.exitCode,
		},
		artifacts: {
			stdout: result.stdout,
			stderr: result.stderr,
			target: target.id,
		},
	};
}

function parseContextIndexOutput(stdout: string): {
	indexedSourceFiles?: number;
	coverage?: number;
	structuralHash?: string;
} {
	try {
		const parsed = JSON.parse(stdout) as Record<string, unknown>;
		const metrics: { indexedSourceFiles?: number; coverage?: number; structuralHash?: string } = {};
		if (typeof parsed.indexedSourceFiles === "number") metrics.indexedSourceFiles = parsed.indexedSourceFiles;
		if (typeof parsed.coverage === "number") metrics.coverage = parsed.coverage;
		if (typeof parsed.structuralHash === "string") metrics.structuralHash = parsed.structuralHash;
		return metrics;
	} catch {
		return {};
	}
}
