import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { runContextClear } from "../domains/context/index.js";

const HELP = `Usage:
  clio context reset [--all] [--yes]

Clear accumulated project context owned by the context engine:
.clio/codewiki.json, .clio/state.json, .clio/handoffs/, and .clio/proposals/.

Preserves by default: CLIO.md, .clio/agents/, .clio/skills/, and .clio/wiki/.

Options:
  --all       also remove CLIO.md after a second confirmation
  --yes, -y   answer every confirmation, required when stdin is not a terminal
`;

function hasFlag(args: ReadonlyArray<string>, name: string): boolean {
	return args.includes(name);
}

async function confirm(question: string): Promise<boolean> {
	if (!input.isTTY) return false;
	const rl = createInterface({ input, output });
	try {
		const answer = await rl.question(question);
		const normalized = answer.trim().toLowerCase();
		return normalized === "y" || normalized === "yes";
	} finally {
		rl.close();
	}
}

export async function runContextClearCommand(args: string[]): Promise<number> {
	if (hasFlag(args, "--help") || hasFlag(args, "-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	for (const arg of args) {
		if (arg !== "--all" && arg !== "--yes" && arg !== "-y") {
			process.stderr.write(`clio context reset: unknown flag ${arg}\n`);
			process.stdout.write(HELP);
			return 2;
		}
	}
	const all = hasFlag(args, "--all");
	const assumeYes = hasFlag(args, "--yes") || hasFlag(args, "-y");
	// Without a terminal there is nobody to answer, and the prompt resolves
	// false, so the reset reports a cancellation the caller never asked for.
	// Say which flag turns that into an answer instead of leaving it to be
	// discovered.
	if (!assumeYes && !input.isTTY) {
		process.stderr.write("clio context reset: stdin is not a terminal; pass --yes to confirm non-interactively\n");
	}
	const answer = (question: string): Promise<boolean> => (assumeYes ? Promise.resolve(true) : confirm(question));
	try {
		await runContextClear({
			cwd: process.cwd(),
			all,
			io: {
				stdout: (s) => process.stdout.write(s),
				stderr: (s) => process.stderr.write(s),
			},
			confirmContext: () =>
				answer("Clear .clio/codewiki.json, .clio/state.json, .clio/handoffs/, and .clio/proposals/? [y/N] "),
			confirmAll: () => answer("Also remove CLIO.md? [y/N] "),
		});
		return 0;
	} catch (err) {
		process.stderr.write(`clio context reset failed: ${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	}
}
