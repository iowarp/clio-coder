#!/usr/bin/env node
// Only argument parsing and boot tracing load statically. Every subcommand is
// imported dynamically through the command registry (see `dispatch`), so a bare `clio`
// (interactive) or `clio --version` pays for its own module graph and nothing
// else — this is the highest-value cut of the cold module-load tax. Code
// splitting (tsup.config.ts) keeps each command's transitive heavy externals in
// its own chunk.
import { traceBoot } from "../core/boot-trace.js";
import { extractGlobalFlags, parseFlags, printError } from "./argv.js";

const HELP = `Clio Coder command line

Coding agent for HPC and scientific-software work, part of IOWarp's CLIO ecosystem of agentic
science. CLIO stands for Context Layer for Input/Output, named for the Greek muse of history.

Usage:
  clio                      start interactive repository chat
  clio acp                  serve Clio as an ACP v1 agent over stdio
  clio run [flags] <task>   run one headless main-agent turn
  clio --version, -v        print the Clio Coder version
  clio --api-key <key>      override the active target API key for this run
  clio --no-context-files, -nc  skip CLIO.md project-context injection
  clio configure            interactive first-run/configuration wizard
  clio targets              list configured targets, health, auth, and capabilities
  clio targets add          add a target interactively or via flags
  clio targets use <id>     set chat and fleet defaults to a target
  clio targets profile      set a named fleet profile
  clio targets remove <id>  remove a target
  clio targets rename <old> <new>  rename a target
  clio models [search]      list models for configured targets
  clio auth list|status|login|logout [target-or-runtime]
  clio doctor [--fix]       diagnose state; --fix creates or repairs it
  clio paths [--json]       print resolved config/data/cache directories
  clio reset                recover or wipe Clio Coder state
  clio context              show project context status (CLIO.md, preload, codewiki)
  clio context init [--yes] [--preview|--heuristic]  explore the repo and bootstrap CLIO.md and codewiki
  clio context refresh [--wiki]  re-index the codewiki and optionally update the Markdown wiki
  clio context wiki [--update] [--status] [--depth auto|simple|medium|detailed] [--target <id>] [--model <id>]
  clio context reset [--all] [--yes]  clear accumulated project context artifacts
  clio context index [--json]  build the codewiki index without model calls
  clio uninstall            remove all Clio Coder state; --remove-binary also unlinks the launcher
  clio upgrade              upgrade Clio Coder and run pending migrations
  clio agents               list discovered agent recipes
  clio fleet list|run|status  repo-owned fleet contracts and dispatch status
  clio evidence             build, list, or inspect evidence artifacts
  clio eval                 run, report, or compare local eval task files
  clio memory               list, propose, approve, reject, or prune memory
  clio usage report         cross-session usage facts and opportunities (experimental)
  clio trace                query or view the durable dispatch trace mirror
  clio extensions           install, list, enable, disable, or remove extension packages
  clio skills               list, inspect, validate, or install skills
  clio docs [topic]         serve bundled HTML docs on 127.0.0.1 (--no-open to skip browser)
  clio dev <command>        harness instruments; run 'clio dev' for the list
  clio --help, -h           this message
  clio --help --all         this message plus every command under 'clio dev'
`;

/**
 * Commands that answer a question about the harness rather than about the
 * user's own work.
 *
 * Nothing here is removed or deprecated. An agent driving Clio over bash can
 * reach a wider surface than a person reading a help screen can hold, so the
 * capability stays and only the default listing shrinks: every name below still
 * resolves at the top level, and `clio --help --all` prints all of it.
 */
const DEV_COMMANDS: ReadonlyArray<{ name: string; summary: string }> = [
	{ name: "components", summary: "list, snapshot, or diff harness components" },
	{ name: "evolve", summary: "create, validate, or summarize change manifests" },
	{ name: "share", summary: "export or import Clio project/resource archives" },
];

const DEV_HELP = `Clio Coder harness instruments

Usage:
${DEV_COMMANDS.map((entry) => `  clio dev ${entry.name.padEnd(20)}${entry.summary}`).join("\n")}

Each also resolves without the 'dev' prefix, so existing scripts and agent
callers keep working. The prefix exists so the default help stays the set of
commands a person needs to read.
`;

function helpText(all: boolean): string {
	return all ? `${HELP}\n${DEV_HELP}` : HELP;
}

/** Engines floor from package.json; npm only warns on EBADENGINE, so the CLI
 * states the requirement itself instead of failing with an arbitrary syntax
 * or API error on old Node versions. */
const MIN_NODE = [22, 19, 0] as const;

interface CliBootOptions {
	apiKey?: string;
	noContextFiles?: boolean;
	noSkills?: boolean;
	skillPaths?: string[];
}

type CommandHandler = (subArgs: string[], bootOptions: CliBootOptions) => Promise<number>;

function nodeVersionError(): string | null {
	const parts = process.versions.node.split(".").map((part) => Number.parseInt(part, 10));
	for (let i = 0; i < MIN_NODE.length; i += 1) {
		const actual = parts[i] ?? 0;
		const wanted = MIN_NODE[i] ?? 0;
		if (actual > wanted) return null;
		if (actual < wanted) {
			return `clio requires Node.js >=${MIN_NODE.join(".")}; this is ${process.versions.node}. Upgrade Node and retry.`;
		}
	}
	return null;
}

async function main(argv: string[]): Promise<number> {
	// First application statement after the static import graph resolved: the
	// elapsed here is the cold module-load tax (see CLIO_TRACE_BOOT).
	traceBoot("cli entry");
	const versionError = nodeVersionError();
	if (versionError !== null) {
		printError(versionError);
		return 1;
	}
	const {
		apiKey,
		noContextFiles,
		noSkills,
		skillPaths,
		rest,
		error: globalFlagError,
	} = extractGlobalFlags(argv, isCommandToken);
	if (globalFlagError) {
		printError(globalFlagError);
		return 2;
	}
	const { flags, positional } = parseFlags(rest);
	const subcommand = positional[0];
	const subcommandIndex = rest.findIndex((arg) => !arg.startsWith("-"));
	const firstArg = rest[0];
	if (firstArg === "--help" || firstArg === "-h" || ((flags.has("help") || flags.has("h")) && !subcommand)) {
		process.stdout.write(helpText(flags.has("all")));
		return 0;
	}
	if (flags.has("version") || flags.has("v")) {
		const { runVersionCommand } = await import("./version.js");
		return runVersionCommand();
	}

	const subArgs = subcommandIndex === -1 ? [] : rest.slice(subcommandIndex + 1);
	const bootOptions = {
		...(apiKey === undefined ? {} : { apiKey }),
		...(noContextFiles ? { noContextFiles: true } : {}),
		...(noSkills ? { noSkills: true } : {}),
		...(skillPaths.length > 0 ? { skillPaths } : {}),
	};
	if (!subcommand) {
		const { runClioCommand } = await import("./clio.js");
		return runClioCommand(bootOptions);
	}

	return dispatch(subcommand, subArgs, bootOptions);
}

/**
 * The dispatcher is also the command-recognition source used by top-level
 * value flags. Every dynamic import stays a literal so tsup can split command
 * graphs, while adding a command in one place cannot leave --api-key/--skill
 * free to swallow it as a value.
 */
const extensionsCommand: CommandHandler = async (subArgs) =>
	(await import("./extensions.js")).runExtensionsCommand(subArgs);

const COMMAND_HANDLERS = new Map<string, CommandHandler>([
	["acp", async (subArgs, bootOptions) => (await import("./acp.js")).runAcpCommand(subArgs, bootOptions)],
	["auth", async (subArgs) => (await import("./auth.js")).runAuthCommand(subArgs)],
	["config", async (subArgs) => (await import("./config.js")).runConfigCommand(subArgs)],
	["configure", async (subArgs) => (await import("./configure.js")).runConfigureCommand(subArgs)],
	["targets", async (subArgs) => (await import("./targets.js")).runTargetsCommand(subArgs)],
	["models", async (subArgs) => (await import("./models.js")).runModelsCommand(subArgs)],
	["agents", async (subArgs) => (await import("./agents.js")).runAgentsCommand(subArgs)],
	["components", async (subArgs) => (await import("./components.js")).runComponentsCommand(subArgs)],
	["evidence", async (subArgs) => (await import("./evidence.js")).runEvidenceCommand(subArgs)],
	["eval", async (subArgs) => (await import("./eval.js")).runEvalCommand(subArgs)],
	["memory", async (subArgs) => (await import("./memory.js")).runMemoryCommand(subArgs)],
	["usage", async (subArgs) => (await import("./usage.js")).runUsageCommand(subArgs)],
	["trace", async (subArgs) => (await import("./trace.js")).runTraceCommand(subArgs)],
	["evolve", async (subArgs) => (await import("./evolve.js")).runEvolveCommand(subArgs)],
	[
		"dev",
		async (subArgs, bootOptions) => {
			const devSubcommand = subArgs[0];
			if (devSubcommand === undefined || devSubcommand === "--help" || devSubcommand === "-h") {
				process.stdout.write(DEV_HELP);
				return devSubcommand === undefined ? 2 : 0;
			}
			if (!DEV_COMMANDS.some((entry) => entry.name === devSubcommand)) {
				printError(`unknown dev command: ${devSubcommand}`);
				process.stdout.write(DEV_HELP);
				return 2;
			}
			return dispatch(devSubcommand, subArgs.slice(1), bootOptions);
		},
	],
	["extensions", extensionsCommand],
	["ext", extensionsCommand],
	["fleet", async (subArgs) => (await import("./fleet.js")).runFleetCommand(subArgs)],
	["skills", async (subArgs) => (await import("./skills.js")).runSkillsCommand(subArgs)],
	["docs", async (subArgs) => (await import("./docs.js")).runDocsCommand(subArgs)],
	["share", async (subArgs) => (await import("./share.js")).runShareCommand(subArgs)],
	["export", async (subArgs) => (await import("./share.js")).runExportCommand(subArgs)],
	["import", async (subArgs) => (await import("./share.js")).runImportCommand(subArgs)],
	["context", async (subArgs) => (await import("./context.js")).runContextCommand(subArgs)],
	["run", async (subArgs, bootOptions) => (await import("./run.js")).runClioRun(subArgs, bootOptions)],
	["doctor", async (subArgs) => (await import("./doctor.js")).runDoctorCommand(subArgs)],
	["paths", async (subArgs) => (await import("./paths.js")).runPathsCommand(subArgs)],
	["reset", async (subArgs) => (await import("./reset.js")).runResetCommand(subArgs)],
	["uninstall", async (subArgs) => (await import("./uninstall.js")).runUninstallCommand(subArgs)],
	["upgrade", async (subArgs) => (await import("./upgrade.js")).runUpgradeCommand(subArgs)],
	["version", async () => (await import("./version.js")).runVersionCommand()],
	[
		"worker",
		async () => {
			// Internal: the native worker stream server (WorkerSpec on stdin,
			// NDJSON on stdout). The entry module runs main() on import and owns
			// process exit; this settles only on a pre-run import failure.
			await import("../worker/entry.js");
			return 0;
		},
	],
]);

// Retired commands are not dispatchable, but remain command-shaped tombstones
// so top-level value flags cannot consume them and accidentally boot another mode.
const RETIRED_SUBCOMMANDS = new Set<string>(["context-init", "context-index", "context-clear"]);

function isCommandToken(token: string): boolean {
	return COMMAND_HANDLERS.has(token) || RETIRED_SUBCOMMANDS.has(token);
}

/**
 * Route a subcommand to its registered handler, importing only that command's
 * module. Unknown names fail before loading any command graph.
 */
async function dispatch(subcommand: string, subArgs: string[], bootOptions: CliBootOptions): Promise<number> {
	const handler = COMMAND_HANDLERS.get(subcommand);
	if (handler) return handler(subArgs, bootOptions);
	printError(`unknown subcommand: ${subcommand}`);
	process.stdout.write(helpText(false));
	return 2;
}

main(process.argv.slice(2))
	.then((code) => {
		process.exitCode = code;
	})
	.catch((err) => {
		printError(err instanceof Error ? err.message : String(err));
		process.exitCode = 1;
	});
