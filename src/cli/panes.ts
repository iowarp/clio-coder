import { renderHerdrThemeBlock } from "../domains/mux/yazi/theme.js";
import { printError } from "./shared.js";
import { runToolsCommand } from "./tools.js";

const HELP = `clio-coder panes install [--if-missing] [--force] [--json]
clio-coder panes theme
clio-coder panes workspace on|off|ask|status

install  Install the pane multiplexer Clio drives. This is an alias for
         \`clio-coder tools install herdr\`; the toolchain command is where every
         pinned external program is managed, and \`clio-coder tools status herdr\`
         explains which copy Clio would run. With --if-missing nothing is
         downloaded when a usable copy already resolves, when you declined the
         workspace or when interface.panes.enabled is off, which is how the
         installer and background updates provision it without duplicating your
         own herdr or reversing your answer.
workspace
         The remembered answer to "open Clio Coder in a workspace?", which bare
         \`clio-coder\` asks once. on accepts, off declines, ask forgets the
         answer so the question is asked again, status shows the answer and what
         the next launch will do. The answer is kept in Clio's state directory;
         settings.yaml is never written. With interface.panes.enabled set to
         auto Clio never starts a workspace whatever is remembered. --no-panes,
         a non-interactive terminal, and a Clio already inside a pane host or
         tmux always stay in the plain terminal and never ask.
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
	if (subcommand === "workspace") return runWorkspaceConsentCommand(rest);
	if (subcommand !== "install") {
		printError(`unknown panes command: ${subcommand}`);
		process.stderr.write(HELP);
		return 2;
	}
	if (rest.includes("--if-missing")) {
		const { resolveToolBinary } = await import("../domains/toolchain/index.js");
		const resolution = resolveToolBinary("herdr");
		if (resolution.binaryPath !== null) {
			process.stdout.write(
				`herdr ${resolution.version ?? resolution.entry?.version ?? ""} already resolves at ${resolution.binaryPath}; nothing downloaded\n`,
			);
			return 0;
		}
		// A remembered no and an `off` in settings both outlive every update; `panes workspace on` and plain
		// `panes install` are the ways back.
		const { readWorkspaceConsent, workspaceOutcome } = await import("./workspace-consent.js");
		const { readLayeredSettings } = await import("../core/settings-layers.js");
		const consent = await readWorkspaceConsent();
		const setting = readLayeredSettings(process.cwd()).settings.interface.panes.enabled;
		const declined = consent?.decision === "declined";
		if (declined || (setting === "off" && workspaceOutcome(setting, consent).kind === "plain")) {
			process.stdout.write(
				`workspace not downloaded: ${declined ? "you declined it earlier" : "interface.panes.enabled is off"} (\`clio-coder panes workspace on\` turns workspaces on)\n`,
			);
			return 0;
		}
	}
	return runToolsCommand(["install", "herdr", ...rest.filter((arg) => arg !== "--if-missing")]);
}

const WORKSPACE_EXCLUSIONS =
	"--no-panes, a non-interactive terminal, and a Clio already inside a pane host or tmux always stay in the plain terminal.";

async function runWorkspaceConsentCommand(rest: ReadonlyArray<string>): Promise<number> {
	const [verb, ...extra] = rest;
	if (verb === undefined || extra.length > 0 || !["on", "off", "ask", "status"].includes(verb)) {
		printError("usage: clio-coder panes workspace on|off|ask|status");
		return 2;
	}
	const { clearWorkspaceConsent, readWorkspaceConsent, workspaceOutcome, writeWorkspaceConsent } = await import(
		"./workspace-consent.js"
	);
	const { readLayeredSettings } = await import("../core/settings-layers.js");
	// The effective value for this directory, the same one a launch here reads.
	const setting = readLayeredSettings(process.cwd()).settings.interface.panes.enabled;
	try {
		if (verb === "on") await writeWorkspaceConsent("accepted", setting);
		if (verb === "off") await writeWorkspaceConsent("declined", setting);
		if (verb === "ask") await clearWorkspaceConsent();
	} catch (error) {
		printError(`could not update the remembered answer: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
	const consent = await readWorkspaceConsent();
	const outcome = workspaceOutcome(setting, consent);
	const remembered =
		consent === null
			? "none"
			: `${consent.decision} (while interface.panes.enabled was ${consent.setting || "unrecorded"}${consent.decidedAt ? `, ${consent.decidedAt}` : ""})`;
	const next =
		outcome.kind === "open"
			? "opens this project's workspace"
			: outcome.kind === "ask"
				? "asks once, then follows the answer"
				: "stays in the plain terminal";
	process.stdout.write(
		[
			`remembered answer        ${remembered}`,
			`interface.panes.enabled  ${setting}`,
			`bare clio-coder          ${next}: ${outcome.reason}`,
			WORKSPACE_EXCLUSIONS,
			"",
		].join("\n"),
	);
	return 0;
}
