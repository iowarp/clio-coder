/**
 * `clio-coder interop`, the read half of external coding agent detection.
 *
 * Reviewing and wiring a detected agent as a delegation peer is an interactive
 * mutation and stays on `configure --interop`. This command family carries the
 * read only, and its one subcommand is the fixed projection a GUI host may run.
 */

import { runInteropInspect } from "./interop-inspect.js";
import { printError } from "./shared.js";

const HELP = `clio-coder interop <subcommand>

Detected external coding agents and how far each one is wired.

Subcommands:
  inspect --json                emit the detected agent inventory with no native paths

Notes:
  inspect writes nothing and runs no foreign executable. Wiring a detected agent
  as a delegation peer is an explicit review: run \`clio-coder configure --interop\`.
`;

export async function runInteropCommand(args: ReadonlyArray<string>): Promise<number> {
	const sub = args[0];
	if (sub === undefined || sub === "--help" || sub === "-h") {
		process.stdout.write(HELP);
		return sub === undefined ? 2 : 0;
	}
	if (sub === "inspect") return await runInteropInspect(args.slice(1));
	printError(`unknown interop command: ${sub}`);
	process.stdout.write(HELP);
	return 2;
}
