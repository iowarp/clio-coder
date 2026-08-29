import chalk from "chalk";

import { authStoragePath } from "../domains/providers/auth/index.js";
import { printError } from "./argv.js";

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
	printNote,
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
			"  target with an environment variable instead: clio-coder configure ... --api-key-env <VAR>.\n",
	);
}

/**
 * Report a credential write that never reached disk, and say whether one
 * happened.
 *
 * `AuthStorage.persist()` throws only for the damaged-store refusal. Every
 * other write failure (a read-only config dir, a lock it could not open, a full
 * disk) is caught there and recorded in `damageReason()`, and the in-memory
 * store still hands the credential back afterwards. So a command that prints
 * its success line without asking says `ok: authenticated <provider>` over a
 * file it did not write, and then warns about the plaintext key it did not
 * store either. Every credential-writing command calls this immediately after
 * the write; when it returns true the command must suppress its success line
 * and the plaintext warning, and exit non-zero.
 *
 * The write is atomic through a temp file and rename, and it is the lock or the
 * rename that fails, so the store is unchanged either way and this can say so.
 */
export function credentialWriteFailed(auth: { damageReason(): string | null }, subject: string): boolean {
	const damage = auth.damageReason();
	if (damage === null) return false;
	printError(`${subject}: ${damage}`);
	process.stderr.write(`  ${authStoragePath()} is unchanged.\n`);
	return true;
}
