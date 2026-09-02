import { renderHerdrThemeBlock } from "../domains/mux/yazi/theme.js";
import { printError } from "./shared.js";
import { runToolsCommand } from "./tools.js";

const HELP = `clio-coder panes install [--force] [--json]
clio-coder panes theme

install  Install the pane multiplexer Clio drives. This is an alias for
         \`clio-coder tools install herdr\`; the toolchain command is where every
         pinned external program is managed, and \`clio-coder tools status herdr\`
         explains which copy Clio would run.
theme    Print Clio's theme tokens as a herdr [theme.custom] block. herdr styles
         its own chrome from its config.toml and offers no per-pane styling, so
         Clio prints the block for you to paste rather than editing another
         program's configuration. The files pane itself is themed by Clio at open.
`;

/**
 * The user-facing verbs for the pane layer's setup.
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
	if (subcommand === "theme") {
		if (rest.length > 0) {
			printError(`panes theme takes no arguments, got: ${rest.join(" ")}`);
			return 2;
		}
		process.stdout.write(renderHerdrThemeBlock());
		return 0;
	}
	if (subcommand !== "install") {
		printError(`unknown panes command: ${subcommand}`);
		process.stderr.write(HELP);
		return 2;
	}
	return runToolsCommand(["install", "herdr", ...rest]);
}
