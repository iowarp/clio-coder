import { renderHerdrThemeBlock } from "../domains/mux/yazi/theme.js";
import { printError } from "./shared.js";
import { runToolsCommand } from "./tools.js";

const HELP = `clio-coder panes install [--if-missing] [--force] [--json]
clio-coder panes theme

install  Install the pane host Clio runs its panes in (herdr, Apache-2.0). This
         is an alias for \`clio-coder tools install herdr\`; the toolchain
         command is where every pinned external program is managed. The
         installer provisions it and Clio installs it on launch when it is
         missing, so this is only needed to repair or pre-fetch it. With
         --if-missing nothing is downloaded when Clio's own pinned copy is
         already installed. A herdr of your own on PATH is never used to host
         Clio's panes and is never touched.
theme    Print Clio's theme tokens as a herdr [theme.custom] block for your own
         herdr config. Clio's private pane host is themed by Clio already.
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
	if (rest.includes("--if-missing")) {
		const { resolveVendoredBinary } = await import("../domains/toolchain/index.js");
		const vendored = resolveVendoredBinary("herdr");
		if (vendored !== null) {
			process.stdout.write(`herdr ${vendored.version} already installed at ${vendored.binaryPath}; nothing downloaded\n`);
			return 0;
		}
	}
	return runToolsCommand(["install", "herdr", ...rest.filter((arg) => arg !== "--if-missing")]);
}
