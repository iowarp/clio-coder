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
import { parseFlags, printError } from "./shared.js";
import { runUpgradeCommand } from "./upgrade.js";
import { runVersionCommand } from "./version.js";

const HELP = `clio. IOWarp orchestrator coding-agent

Usage:
  clio                      start interactive mode
  clio --version, -v        print version info
  clio doctor               run environment diagnostics
  clio setup                create, edit, or remove endpoints
  clio install              bootstrap Clio config/data/cache directories
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
	const { flags, positional } = parseFlags(argv);
	if (flags.has("help") || flags.has("h")) {
		process.stdout.write(HELP);
		return 0;
	}
	if (flags.has("version") || flags.has("v")) return runVersionCommand();

	const subcommand = positional[0];
	if (!subcommand) return runClioCommand();

	switch (subcommand) {
		case "providers":
			return runProvidersCommand(argv.slice(1));
		case "list-models":
			return runListModelsCommand(argv.slice(1));
		case "connect":
			return runConnectCommand(argv.slice(1));
		case "disconnect":
			return runDisconnectCommand(argv.slice(1));
		case "login":
			return runConnectCommand(argv.slice(1));
		case "logout":
			return runDisconnectCommand(argv.slice(1));
		case "auth":
			return runAuthCommand(argv.slice(1));
		case "agents":
			return runAgentsCommand(argv.slice(1));
		case "run":
			return runClioRun(argv.slice(1));
		case "doctor":
			return runDoctorCommand();
		case "setup":
			return runSetupCommand(argv.slice(1));
		case "install":
			return runInstallCommand();
		case "upgrade":
			return runUpgradeCommand(argv.slice(1));
		case "version":
			return runVersionCommand();
		default:
			printError(`unknown subcommand: ${subcommand}`);
			process.stdout.write(HELP);
			return 2;
	}
}

main(process.argv.slice(2))
	.then((code) => process.exit(code))
	.catch((err) => {
		printError(err instanceof Error ? err.message : String(err));
		process.exit(1);
	});
