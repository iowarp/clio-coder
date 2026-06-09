import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";

import { runContextClear } from "../domains/context/index.js";

const HELP = `Usage:
  clio context-clear [--all]

Clear accumulated project context owned by the context engine:
.clio/codewiki.json, .clio/state.json, and .clio/handoffs/.

Preserves user-authored project assets by default:
CLIO.md, .clio/agents/, and .clio/skills/.

Options:
  --all       also remove CLIO.md after a second confirmation
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
		if (arg !== "--all") {
			process.stderr.write(`clio context-clear: unknown flag ${arg}\n`);
			process.stdout.write(HELP);
			return 2;
		}
	}
	const all = hasFlag(args, "--all");
	try {
		await runContextClear({
			cwd: process.cwd(),
			all,
			io: {
				stdout: (s) => process.stdout.write(s),
				stderr: (s) => process.stderr.write(s),
			},
			confirmContext: () => confirm("Clear .clio/codewiki.json, .clio/state.json, and .clio/handoffs/? [y/N] "),
			confirmAll: () => confirm("Also remove CLIO.md? [y/N] "),
		});
		return 0;
	} catch (err) {
		process.stderr.write(`clio context-clear failed: ${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	}
}
