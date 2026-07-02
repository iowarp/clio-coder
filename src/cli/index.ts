#!/usr/bin/env node
// Only argument parsing and boot tracing load statically. Every subcommand is
// imported dynamically inside its switch case (see `dispatch`), so a bare `clio`
// (interactive) or `clio --version` pays for its own module graph and nothing
// else — this is the highest-value cut of the cold module-load tax. Code
// splitting (tsup.config.ts) keeps each command's transitive heavy externals in
// its own chunk.
import { traceBoot } from "../core/boot-trace.js";
import { extractApiKeyFlag, extractNoContextFilesFlag, extractSkillsFlags, parseFlags, printError } from "./argv.js";

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
  clio context-clear [--all]  clear accumulated project context artifacts
  clio context-index [--json]  build the codewiki index without model calls
  clio uninstall            remove all Clio Coder state; --remove-binary also unlinks the launcher
  clio upgrade              upgrade Clio Coder and run pending migrations
  clio agents               list discovered agent recipes
  clio fleet list|run|status  repo-owned fleet contracts and dispatch status
  clio components           list, snapshot, or diff harness components
  clio evidence             build, list, or inspect evidence artifacts
  clio eval                 run, report, or compare local eval task files
  clio memory               list, propose, approve, reject, or prune memory
  clio evolve manifest      create, validate, or summarize change manifests
  clio extensions           install, list, enable, disable, or remove extension packages
  clio skills               list, inspect, validate, or create skills
  clio docs [topic]         serve bundled HTML docs on 127.0.0.1 (--no-open to skip browser)
  clio share export|import  export or import Clio project/resource archives
  clio context-init [--yes] [--preview|--heuristic]  explore the repo and bootstrap CLIO.md and codewiki
  clio --help, -h           this message
`;

async function main(argv: string[]): Promise<number> {
	// First application statement after the static import graph resolved: the
	// elapsed here is the cold module-load tax (see CLIO_TRACE_BOOT).
	traceBoot("cli entry");
	const { apiKey, rest: afterApiKey, error: apiKeyError } = extractApiKeyFlag(argv, isRecognizedSubcommand);
	if (apiKeyError) {
		printError(apiKeyError);
		return 2;
	}
	const { noContextFiles, rest: afterNoContextFiles } = extractNoContextFilesFlag(afterApiKey);
	const {
		noSkills,
		skillPaths,
		rest,
		error: skillError,
	} = extractSkillsFlags(afterNoContextFiles, isRecognizedSubcommand);
	if (skillError) {
		printError(skillError);
		return 2;
	}
	const { flags, positional } = parseFlags(rest);
	const subcommand = positional[0];
	const subcommandIndex = rest.findIndex((arg) => !arg.startsWith("-"));
	const firstArg = rest[0];
	if (firstArg === "--help" || firstArg === "-h" || ((flags.has("help") || flags.has("h")) && !subcommand)) {
		process.stdout.write(HELP);
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

// Every subcommand name dispatch() routes. The top-level value flags
// (--api-key, --skill) consult this so they refuse to consume an intended
// subcommand as their value. Keep in sync with the dispatch() switch below.
const RECOGNIZED_SUBCOMMANDS = new Set<string>([
	"acp",
	"auth",
	"config",
	"configure",
	"targets",
	"models",
	"agents",
	"components",
	"evidence",
	"eval",
	"memory",
	"evolve",
	"extensions",
	"ext",
	"fleet",
	"skills",
	"docs",
	"share",
	"export",
	"import",
	"context-init",
	"context-index",
	"context-clear",
	"run",
	"doctor",
	"paths",
	"reset",
	"uninstall",
	"upgrade",
	"version",
]);

function isRecognizedSubcommand(token: string): boolean {
	return RECOGNIZED_SUBCOMMANDS.has(token);
}

/**
 * Route a subcommand to its handler, importing only that command's module. Each
 * case is an isolated dynamic import so the process never loads a command it did
 * not run. Keep every `MODULE` string a plain literal — the bundler splits on
 * static import specifiers, so a computed path would not code-split.
 */
async function dispatch(
	subcommand: string,
	subArgs: string[],
	bootOptions: {
		apiKey?: string;
		noContextFiles?: boolean;
		noSkills?: boolean;
		skillPaths?: string[];
	},
): Promise<number> {
	switch (subcommand) {
		case "acp":
			return (await import("./acp.js")).runAcpCommand(subArgs, bootOptions);
		case "auth":
			return (await import("./auth.js")).runAuthCommand(subArgs);
		case "config":
			return (await import("./config.js")).runConfigCommand(subArgs);
		case "configure":
			return (await import("./configure.js")).runConfigureCommand(subArgs);
		case "targets":
			return (await import("./targets.js")).runTargetsCommand(subArgs);
		case "models":
			return (await import("./models.js")).runModelsCommand(subArgs);
		case "agents":
			return (await import("./agents.js")).runAgentsCommand(subArgs);
		case "components":
			return (await import("./components.js")).runComponentsCommand(subArgs);
		case "evidence":
			return (await import("./evidence.js")).runEvidenceCommand(subArgs);
		case "eval":
			return (await import("./eval.js")).runEvalCommand(subArgs);
		case "memory":
			return (await import("./memory.js")).runMemoryCommand(subArgs);
		case "evolve":
			return (await import("./evolve.js")).runEvolveCommand(subArgs);
		case "extensions":
		case "ext":
			return (await import("./extensions.js")).runExtensionsCommand(subArgs);
		case "fleet":
			return (await import("./fleet.js")).runFleetCommand(subArgs);
		case "skills":
			return (await import("./skills.js")).runSkillsCommand(subArgs);
		case "docs":
			return (await import("./docs.js")).runDocsCommand(subArgs);
		case "share":
			return (await import("./share.js")).runShareCommand(subArgs);
		case "export":
			return (await import("./share.js")).runExportCommand(subArgs);
		case "import":
			return (await import("./share.js")).runImportCommand(subArgs);
		case "context-init":
			return (await import("./init.js")).runInitCommand(subArgs);
		case "context-index":
			return (await import("./context-index.js")).runContextIndexCommand(subArgs);
		case "context-clear":
			return (await import("./context-clear.js")).runContextClearCommand(subArgs);
		case "run":
			return (await import("./run.js")).runClioRun(subArgs, bootOptions);
		case "doctor":
			return (await import("./doctor.js")).runDoctorCommand(subArgs);
		case "paths":
			return (await import("./paths.js")).runPathsCommand(subArgs);
		case "reset":
			return (await import("./reset.js")).runResetCommand(subArgs);
		case "uninstall":
			return (await import("./uninstall.js")).runUninstallCommand(subArgs);
		case "upgrade":
			return (await import("./upgrade.js")).runUpgradeCommand(subArgs);
		case "version":
			return (await import("./version.js")).runVersionCommand();
		default:
			printError(`unknown subcommand: ${subcommand}`);
			process.stdout.write(HELP);
			return 2;
	}
}

main(process.argv.slice(2))
	.then((code) => {
		process.exitCode = code;
	})
	.catch((err) => {
		printError(err instanceof Error ? err.message : String(err));
		process.exitCode = 1;
	});
