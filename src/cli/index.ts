import { runAgentsCommand } from "./agents.js";
import { runAuthCommand } from "./auth.js";
import { runClioCommand } from "./clio.js";
import { runDoctorCommand } from "./doctor.js";
import { runInstallCommand } from "./install.js";
import { runListModelsCommand } from "./list-models.js";
import { runConnectCommand } from "./login.js";
import { runDisconnectCommand } from "./logout.js";
import { runProvidersCommand } from "./providers.js";
import { runClioRun } from "./run.js";
import { runSetupCommand } from "./setup.js";
import { extractApiKeyFlag, parseFlags, printError } from "./shared.js";
import { runUninstallCommand } from "./uninstall.js";
import { runUpgradeCommand } from "./upgrade.js";
import { runVersionCommand } from "./version.js";

const HELP = `clio. IOWarp orchestrator coding-agent

Usage:
  clio                      start interactive mode
  clio --dev                start self-development mode for this checkout
  clio --version, -v        print version info
  clio --api-key <key>      override the active endpoint's api key for this run
  clio doctor               run environment diagnostics
  clio setup                create, edit, or remove endpoints
  clio install              bootstrap Clio config/data/cache directories
  clio uninstall            remove or reset Clio state directories
  clio upgrade              upgrade clio and run pending state migrations
  clio providers            list endpoint status, health, capabilities
  clio list-models          list discovered models per endpoint
  clio connect [target]     connect a provider or endpoint (OAuth or API key)
  clio disconnect <target>  disconnect stored credentials for a provider or endpoint
  clio auth [list|status]   list supported providers or show connection status
  clio agents               list discovered agent recipes
  clio run <task>           dispatch a one-shot worker job
  clio --help, -h           this message
`;

async function main(argv: string[]): Promise<number> {
	const { apiKey, rest } = extractApiKeyFlag(argv);
	const { flags, positional } = parseFlags(rest);
	if (flags.has("help") || flags.has("h")) {
		process.stdout.write(HELP);
		return 0;
	}
	if (flags.has("version") || flags.has("v")) return runVersionCommand();

	const subcommand = positional[0];
	const subcommandIndex = rest.findIndex((arg) => !arg.startsWith("-"));
	const subArgs = subcommandIndex === -1 ? [] : rest.slice(subcommandIndex + 1);
	const dev = flags.has("dev");
	const bootOptions = {
		...(apiKey === undefined ? {} : { apiKey }),
		...(dev ? { dev: true } : {}),
	};
	if (!subcommand) return runClioCommand(bootOptions);

	switch (subcommand) {
		case "providers":
			return runProvidersCommand(subArgs);
		case "list-models":
			return runListModelsCommand(subArgs);
		case "connect":
			return runConnectCommand(subArgs);
		case "disconnect":
			return runDisconnectCommand(subArgs);
		case "login":
			return runConnectCommand(subArgs);
		case "logout":
			return runDisconnectCommand(subArgs);
		case "auth":
			return runAuthCommand(subArgs);
		case "agents":
			return runAgentsCommand(subArgs);
		case "run":
			return runClioRun(subArgs, bootOptions);
		case "doctor":
			return runDoctorCommand();
		case "setup":
			return runSetupCommand(subArgs);
		case "install":
			return runInstallCommand();
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
