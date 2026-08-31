import { printError } from "./shared.js";
import { runToolsCommand } from "./tools.js";

const HELP = `clio-coder panes install [--force] [--json]

Install the pane multiplexer Clio drives. This is an alias for
\`clio-coder tools install herdr\`; the toolchain command is where every pinned
external program is managed, and \`clio-coder tools status herdr\` explains
which copy Clio would run.
`;

/**
 * The user-facing verb for the pane layer's one setup step.
 *
 * Panes are the feature; herdr is the program behind it. Naming the program in
 * a command an operator types is a leak, so the alias exists and routes to the
 * generic installer rather than the reverse.
 */
export async function runPanesCommand(argv: ReadonlyArray<string> = []): Promise<number> {
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	const [subcommand, ...rest] = argv;
	if (subcommand === undefined) {
		process.stdout.write(HELP);
		return 2;
	}
	if (subcommand !== "install") {
		printError(`unknown panes command: ${subcommand}`);
		process.stderr.write(HELP);
		return 2;
	}
	return runToolsCommand(["install", "herdr", ...rest]);
}
