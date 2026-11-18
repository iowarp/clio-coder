import { joinLineContinuations, shellStatusMasked } from "../domains/safety/protected-artifacts.js";

/**
 * Whether a bash command's exit status speaks for the whole command. The bash
 * tool runs under `pipefail`, so a pipeline's status covers every stage and an
 * `&&` chain stops at its first failure. After `;`, `||`, `&`, a newline, a `!`
 * inversion, or a step switching `pipefail` off in any quoting, the status is not
 * the command's own: a live run read `exitCode:0` for
 * `node check.mjs; echo "exit=$?"` as the suite's. A backslash-newline continues the line, so it separates
 * nothing (x7-4).
 */
export function shellExitSpeaksForCommand(command: string): boolean {
	const bare = joinLineContinuations(command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, ""))
		.replace(/&&|\|&|\d?>&\d|&>/g, " ")
		.replace(/;\s*$/, "");
	if (shellStatusMasked(command)) return false;
	return !/[;&\n]|\|\|/.test(bare.trim());
}
