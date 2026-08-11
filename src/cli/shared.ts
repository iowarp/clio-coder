import chalk from "chalk";

import { authStoragePath } from "../domains/providers/auth/index.js";

// The dependency-light CLI helpers live in ./argv.js so cli/index.ts can import
// them without pulling the provider/auth graph into the startup chunk. They are
// re-exported here so the command modules keep their existing `./shared.js`
// import sites unchanged.
export {
	columnWidths,
	extractGlobalFlags,
	formatColumnRow,
	formatColumns,
	parseFlags,
	printError,
	printHeader,
	printOk,
} from "./argv.js";

/**
 * Warn that an API key was just written to the credentials file in plaintext.
 * Clio protects the file with mode 0600 but does not encrypt it, so a key on
 * disk is readable by any process running as the user. Callers invoke this
 * right after persisting a literal key; the env-var path stores nothing and
 * stays silent. This is the one helper that needs the auth graph, so it stays
 * here rather than in the dependency-light ./argv.js.
 */
export function printPlaintextCredentialWarning(): void {
	process.stderr.write(
		`${chalk.yellow("warning:")} API key stored unencrypted at ${authStoragePath()} (mode 0600).\n` +
			"  It is readable by any process running as you. To keep the key off disk, configure the\n" +
			"  target with an environment variable instead: clio configure ... --api-key-env <VAR>.\n",
	);
}
