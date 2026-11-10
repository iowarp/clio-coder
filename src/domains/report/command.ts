import { runCommandVector } from "../../core/safe-exec.js";

export interface ReportCommandResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

/** One subprocess, no shell. Injected so tests never run a real `gh` or reach GitHub. */
export type ReportCommandRunner = (
	file: string,
	args: ReadonlyArray<string>,
	options: { timeoutMs: number; env?: Record<string, string>; cwd?: string },
) => Promise<ReportCommandResult>;

export const runReportCommand: ReportCommandRunner = async (file, args, options) => {
	const result = await runCommandVector(file, args, {
		timeoutMs: options.timeoutMs,
		killGraceMs: 500,
		...(options.env !== undefined ? { env: options.env } : {}),
		...(options.cwd !== undefined ? { cwd: options.cwd, workspaceRoot: options.cwd } : {}),
	});
	return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, timedOut: result.timedOut };
};
