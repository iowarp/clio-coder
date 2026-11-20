import { dirname } from "node:path";
import { renderHerdrThemeBlock } from "../domains/mux/yazi/theme.js";
import { writeCliFailure } from "./kit/json-out.js";
import type { ErrorSlug } from "./kit/slugs.js";
import { runToolsCommand } from "./tools.js";

const HELP = `clio-coder panes install [--if-missing] [--force] [--json]
clio-coder panes theme

install  Install the pane host CLIO Coder runs its panes in (herdr, Apache-2.0).
         This is an alias for \`clio-coder tools install herdr\`; the toolchain
         command is where every pinned external program is managed. The
         installer provisions it, and CLIO Coder installs a new pin on launch
         after an upgrade. Run this when the installer could not fetch it or
         after \`npm install -g\`; a launch without it says so once. With
         --if-missing nothing is downloaded when CLIO Coder's own pinned copy is
         already installed. A herdr of your own on PATH is never used to host
         CLIO Coder's panes and is never touched. --json prints one document,
         the tools install --json shape, whether or not anything was downloaded.
theme    Print CLIO Coder's theme tokens as a herdr [theme.custom] block for
         your own herdr config. CLIO Coder already themes its own private pane
         host.
`;

const INSTALL_FLAGS: ReadonlySet<string> = new Set(["--if-missing", "--force", "-f", "--json"]);

function usageFailure(path: ReadonlyArray<string>, slug: ErrorSlug, message: string, json: boolean): number {
	writeCliFailure({ path, slug, message, json });
	return 2;
}

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
	const json = argv.includes("--json");
	const [subcommand, ...rest] = argv;
	if (subcommand === undefined) {
		process.stderr.write(HELP);
		return 2;
	}
	if (subcommand === "theme") {
		if (rest.length > 0) {
			return usageFailure(["panes", "theme"], "usage", `takes no arguments, got: ${rest.join(" ")}`, json);
		}
		process.stdout.write(renderHerdrThemeBlock());
		return 0;
	}
	if (subcommand !== "install") {
		const unknownFlag = subcommand.startsWith("-");
		return usageFailure(
			["panes"],
			unknownFlag ? "unknown_flag" : "unknown_command",
			unknownFlag ? `unknown flag: ${subcommand}` : `unknown command: ${subcommand}`,
			json,
		);
	}
	const unknown = rest.find((arg) => !INSTALL_FLAGS.has(arg));
	if (unknown !== undefined) {
		const unknownFlag = unknown.startsWith("-");
		return usageFailure(
			["panes", "install"],
			unknownFlag ? "unknown_flag" : "usage",
			unknownFlag ? `unknown flag: ${unknown}` : `unexpected argument: ${unknown}`,
			json,
		);
	}
	if (rest.includes("--if-missing")) {
		const { resolveVendoredBinary } = await import("../domains/toolchain/index.js");
		const vendored = resolveVendoredBinary("herdr");
		if (vendored !== null) {
			// The warm path prints the same document a cold install does, with
			// skipped: true, so a caller parses one shape either way.
			if (json) {
				const document = {
					ok: true,
					id: "herdr",
					version: vendored.version,
					dir: dirname(vendored.binaryPath),
					binaries: [vendored.binaryPath],
					documents: [],
					skipped: true,
					pruned: [],
					message: `herdr ${vendored.version} already installed at ${vendored.binaryPath}; nothing downloaded`,
				};
				process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
				return 0;
			}
			process.stdout.write(`herdr ${vendored.version} already installed at ${vendored.binaryPath}; nothing downloaded\n`);
			return 0;
		}
	}
	return runToolsCommand(["install", "herdr", ...rest.filter((arg) => arg !== "--if-missing")]);
}
