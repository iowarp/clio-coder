import { type EvalRunnerOutput, runShellCommand, shellQuote } from "./external-command.js";

export async function runContextInitRunner(
	cwd: string,
	clioEntry: string,
	timeoutMs: number,
): Promise<EvalRunnerOutput> {
	const result = await runShellCommand(
		`${shellQuote(process.execPath)} ${shellQuote(clioEntry)} context-init --yes --heuristic`,
		cwd,
		timeoutMs,
	);
	return {
		exitCode: result.exitCode,
		stdout: result.stdout,
		stderr: result.stderr,
		wallTimeMs: result.wallTimeMs,
		metrics: {
			"latency.wallMs": result.wallTimeMs,
			"verifier.exitCode": result.exitCode,
		},
		artifacts: { stdout: result.stdout, stderr: result.stderr },
	};
}
