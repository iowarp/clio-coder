import { runShellCommand } from "../runners/external-command.js";

export interface CommandVerifierResult {
	pass: boolean;
	exitCode: number;
	stdout: string;
	stderr: string;
	wallTimeMs: number;
}

export async function runCommandVerifiers(
	commands: ReadonlyArray<string>,
	cwd: string,
	timeoutMs: number,
	env?: NodeJS.ProcessEnv,
): Promise<CommandVerifierResult> {
	let stdout = "";
	let stderr = "";
	let wallTimeMs = 0;
	for (const command of commands) {
		const result = await runShellCommand(command, cwd, timeoutMs, env);
		stdout += result.stdout;
		stderr += result.stderr;
		wallTimeMs += result.wallTimeMs;
		if (result.exitCode !== 0) return { pass: false, exitCode: result.exitCode, stdout, stderr, wallTimeMs };
	}
	return { pass: true, exitCode: 0, stdout, stderr, wallTimeMs };
}
