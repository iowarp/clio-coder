import { runAgentsCommand } from "./agents.js";
import { runAuthCommand } from "./auth.js";
import { runClioCommand } from "./clio.js";
import { runConfigureCommand } from "./configure.js";
import { runDoctorCommand } from "./doctor.js";
import { runModelsCommand } from "./models.js";
import { runResetCommand } from "./reset.js";
import { runClioRun } from "./run.js";
import { extractApiKeyFlag, parseFlags, printError } from "./shared.js";
import { runTargetsCommand } from "./targets.js";
import { runUninstallCommand } from "./uninstall.js";
import { runUpgradeCommand } from "./upgrade.js";
import { runVersionCommand } from "./version.js";

const HELP = `Clio Coder command line

AI coding harness for supervised repository work.

Usage:
  clio                      start interactive repository chat
  clio --dev                start self-development mode for this checkout
  clio --version, -v        print the clio version
  clio --api-key <key>      override the active target API key for this run
  clio configure            interactive first-run/configuration wizard
  clio targets              list configured targets, health, auth, and capabilities
  clio targets add          add a target interactively or via flags
  clio targets use <id>     set chat and worker defaults to a target
  clio targets worker       set a named worker profile
  clio targets remove <id>  remove a target
  clio targets rename <old> <new>
  clio models [search]      list models for configured targets
  clio auth list|status|login|logout [target-or-runtime]
  clio doctor [--fix]       diagnose state; --fix creates or repairs it
  clio reset                recover or wipe Clio state
  clio uninstall            remove Clio state and print package removal guidance
  clio upgrade              upgrade clio and run pending migrations
  clio agents               list discovered agent recipes
  clio run <task>           dispatch a one-shot worker
  clio --help, -h           this message
`;

async function main(argv: string[]): Promise<number> {
	const { apiKey, rest } = extractApiKeyFlag(argv);
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
	const dev = flags.has("dev");
	const bootOptions = {
		...(apiKey === undefined ? {} : { apiKey }),
		...(dev ? { dev: true } : {}),
	};
	if (!subcommand) return runClioCommand(bootOptions);

	switch (subcommand) {
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
		case "run":
			return runClioRun(subArgs, bootOptions);
		case "doctor":
			return runDoctorCommand(subArgs);
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
