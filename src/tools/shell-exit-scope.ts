/**
 * Whether a bash command's exit status speaks for the whole command. The bash
 * tool runs under `pipefail`, so a pipeline's status covers every stage and an
 * `&&` chain stops at its first failure. After `;`, `||`, `&`, a newline, or
 * `set +o pipefail` the status is only the last command's: a live run read
 * `exitCode:0` for `node check.mjs; echo "exit=$?"` as the suite's.
 */
export function shellExitSpeaksForCommand(command: string): boolean {
	const bare = command
		.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "")
		.replace(/&&|\|&|\d?>&\d|&>/g, " ")
		.replace(/;\s*$/, "");
	if (/\bset\s+\+o\s+pipefail\b/.test(bare)) return false;
	return !/[;&\n]|\|\|/.test(bare.trim());
}
