import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { runBootstrap } from "../domains/context/index.js";

const HELP = `Usage:
  clio init [--yes]

Bootstrap or refresh CLIO.md for the current project.
`;

function hasFlag(args: ReadonlyArray<string>, name: string): boolean {
	return args.includes(name);
}

async function confirmGitignore(assumeYes: boolean): Promise<boolean> {
	if (assumeYes) return true;
	if (!input.isTTY) return false;
	const rl = createInterface({ input, output });
	try {
		const answer = await rl.question("Add .clio/ to .gitignore? [y/N] ");
		return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
	} finally {
		rl.close();
	}
}

export async function runInitCommand(args: string[]): Promise<number> {
	if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	const assumeYes = hasFlag(args, "--yes") || hasFlag(args, "-y");
	await runBootstrap({
		cwd: process.cwd(),
		io: {
			stdout: (s) => process.stdout.write(s),
			stderr: (s) => process.stderr.write(s),
		},
		confirmGitignore: () => confirmGitignore(assumeYes),
	});
	return 0;
}
