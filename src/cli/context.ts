import { runContextRefresh } from "../domains/context/index.js";

const HELP = `Usage:
  clio context refresh

Rebuild the codewiki index and restamp the CLIO.md fingerprint footer
(gitHead/treeHash/loc) without touching any handbook prose. Use
\`clio context-init\` to regenerate or update the handbook itself.
`;

export async function runContextCommand(args: string[]): Promise<number> {
	const sub = args[0];
	if (sub === "--help" || sub === "-h" || sub === undefined) {
		process.stdout.write(HELP);
		return sub === undefined ? 2 : 0;
	}
	if (sub !== "refresh") {
		process.stderr.write(`clio context: unknown subcommand ${sub}\n`);
		process.stdout.write(HELP);
		return 2;
	}
	for (const arg of args.slice(1)) {
		process.stderr.write(`clio context refresh: unknown flag ${arg}\n`);
		process.stdout.write(HELP);
		return 2;
	}
	try {
		await runContextRefresh({
			cwd: process.cwd(),
			io: {
				stdout: (s) => process.stdout.write(s),
				stderr: (s) => process.stderr.write(s),
			},
		});
		return 0;
	} catch (err) {
		process.stderr.write(`clio context refresh failed: ${err instanceof Error ? err.message : String(err)}\n`);
		return 1;
	}
}
