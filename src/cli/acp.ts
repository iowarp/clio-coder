import { runClioCommand } from "./clio.js";
import { restoreStdout, takeOverStdout, writeRawStdout } from "./output-guard.js";
import { printError } from "./shared.js";

const HELP = `clio acp

Serve Clio Coder as an Agent Client Protocol v1 agent over stdio.

This command is intended for ACP frontends to spawn. Interactive delegation remains
available through /agents, /delegate, the dispatch board, and receipts.
`;

export async function runAcpCommand(
	args: ReadonlyArray<string>,
	options: { apiKey?: string; noContextFiles?: boolean; noSkills?: boolean; skillPaths?: ReadonlyArray<string> } = {},
): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	if (args.length > 0) {
		printError(`unknown clio acp option: ${args[0] ?? ""}`);
		process.stdout.write(HELP);
		return 2;
	}
	takeOverStdout();
	try {
		return await runClioCommand({
			...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
			...(options.noContextFiles ? { noContextFiles: true } : {}),
			...(options.noSkills ? { noSkills: true } : {}),
			...(options.skillPaths && options.skillPaths.length > 0 ? { skillPaths: options.skillPaths } : {}),
			acp: {
				transportOptions: { write: writeRawStdout },
			},
		});
	} finally {
		restoreStdout();
	}
}
