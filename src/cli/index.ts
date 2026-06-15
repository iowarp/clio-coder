import { runAcpCommand } from "./acp.js";
import { runAgentsCommand } from "./agents.js";
import { runAuthCommand } from "./auth.js";
import { runClioCommand } from "./clio.js";
import { runComponentsCommand } from "./components.js";
import { runConfigureCommand } from "./configure.js";
import { runContextClearCommand } from "./context-clear.js";
import { runContextIndexCommand } from "./context-index.js";
import { runDoctorCommand } from "./doctor.js";
import { runEvalCommand } from "./eval.js";
import { runEvidenceCommand } from "./evidence.js";
import { runEvolveCommand } from "./evolve.js";
import { runExtensionsCommand } from "./extensions.js";
import { runFleetCommand } from "./fleet.js";
import { runInitCommand } from "./init.js";
import { runMemoryCommand } from "./memory.js";
import { runModelsCommand } from "./models.js";
import { runPathsCommand } from "./paths.js";
import { runResetCommand } from "./reset.js";
import { runClioRun } from "./run.js";
import { runExportCommand, runImportCommand, runShareCommand } from "./share.js";
import { extractApiKeyFlag, extractNoContextFilesFlag, extractSkillsFlags, parseFlags, printError } from "./shared.js";
import { runSkillsCommand } from "./skills.js";
import { runTargetsCommand } from "./targets.js";
import { runUninstallCommand } from "./uninstall.js";
import { runUpgradeCommand } from "./upgrade.js";
import { runVersionCommand } from "./version.js";

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
  clio share export|import  export or import Clio project/resource archives
  clio context-init [--yes] [--preview|--heuristic]  explore the repo and bootstrap CLIO.md and codewiki
  clio --help, -h           this message
`;

async function main(argv: string[]): Promise<number> {
	const { apiKey, rest: afterApiKey } = extractApiKeyFlag(argv);
	const { noContextFiles, rest: afterNoContextFiles } = extractNoContextFilesFlag(afterApiKey);
	const { noSkills, skillPaths, rest } = extractSkillsFlags(afterNoContextFiles);
	const { flags, positional } = parseFlags(rest);
	const subcommand = positional[0];
	const subcommandIndex = rest.findIndex((arg) => !arg.startsWith("-"));
	const firstArg = rest[0];
	if (firstArg === "--help" || firstArg === "-h" || ((flags.has("help") || flags.has("h")) && !subcommand)) {
		process.stdout.write(HELP);
		return 0;
	}
	if (flags.has("version") || flags.has("v")) return runVersionCommand();

	const subArgs = subcommandIndex === -1 ? [] : rest.slice(subcommandIndex + 1);
	const bootOptions = {
		...(apiKey === undefined ? {} : { apiKey }),
		...(noContextFiles ? { noContextFiles: true } : {}),
		...(noSkills ? { noSkills: true } : {}),
		...(skillPaths.length > 0 ? { skillPaths } : {}),
	};
	if (!subcommand) return runClioCommand(bootOptions);

	switch (subcommand) {
		case "acp":
			return runAcpCommand(subArgs, bootOptions);
		case "auth":
			return runAuthCommand(subArgs);
		case "configure":
			return runConfigureCommand(subArgs);
		case "targets":
			return runTargetsCommand(subArgs);
		case "models":
			return runModelsCommand(subArgs);
		case "agents":
			return runAgentsCommand(subArgs);
		case "components":
			return runComponentsCommand(subArgs);
		case "evidence":
			return runEvidenceCommand(subArgs);
		case "eval":
			return runEvalCommand(subArgs);
		case "memory":
			return runMemoryCommand(subArgs);
		case "evolve":
			return runEvolveCommand(subArgs);
		case "extensions":
		case "ext":
			return runExtensionsCommand(subArgs);
		case "fleet":
			return runFleetCommand(subArgs);
		case "skills":
			return runSkillsCommand(subArgs);
		case "share":
			return runShareCommand(subArgs);
		case "export":
			return runExportCommand(subArgs);
		case "import":
			return runImportCommand(subArgs);
		case "context-init":
			return runInitCommand(subArgs);
		case "context-index":
			return runContextIndexCommand(subArgs);
		case "context-clear":
			return runContextClearCommand(subArgs);
		case "run":
			return runClioRun(subArgs, bootOptions);
		case "doctor":
			return runDoctorCommand(subArgs);
		case "paths":
			return runPathsCommand(subArgs);
		case "reset":
			return runResetCommand(subArgs);
		case "uninstall":
			return runUninstallCommand(subArgs);
		case "upgrade":
			return runUpgradeCommand(subArgs);
		case "version":
			return runVersionCommand();
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
