import { runAgentsCommand } from "./agents.js";
import { runClioCommand } from "./clio.js";
import { runDoctorCommand } from "./doctor.js";
import { runInstallCommand } from "./install.js";
import { runProvidersCommand } from "./providers.js";
import { parseFlags, printError } from "./shared.js";
import { runVersionCommand } from "./version.js";

const HELP = `clio. IOWarp orchestrator coding-agent

Usage:
  clio                  start interactive mode
  clio --version, -v    print version info
  clio doctor           run environment diagnostics
  clio install          bootstrap ~/.clio directory
  clio providers        list configured providers
  clio agents           list discovered agent recipes
  clio --help, -h       this message
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
		case "agents":
			return runAgentsCommand(argv.slice(1));
		case "doctor":
			return runDoctorCommand();
		case "install":
			return runInstallCommand();
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
