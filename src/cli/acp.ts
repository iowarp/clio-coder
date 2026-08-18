import { realpathSync } from "node:fs";
import path from "node:path";
import { runClioCommand } from "./clio.js";
import { restoreStdout, takeOverStdout, writeRawStdout } from "./output-guard.js";
import { printError } from "./shared.js";

const HELP = `clio-coder acp [--cwd PATH] [--permission-timeout MS]

Serve Clio Coder as an Agent Client Protocol v1 agent over stdio.

  --cwd PATH               Workspace root the server boots in and opens sessions at.
  --permission-timeout MS  How long a mediated permission request may wait for the
                           client before it is denied. Defaults to the configured
                           delegation.defaults.permissionTimeoutMs.

This command is intended for ACP frontends to spawn. Interactive delegation remains
available through /agents, /delegate, the dispatch board, and receipts.
`;

interface AcpFlags {
	cwd?: string;
	permissionTimeoutMs?: number;
}

/** Parsed flags, or the message explaining why the invocation is not usable. */
function parseAcpFlags(args: ReadonlyArray<string>): AcpFlags | string {
	const flags: AcpFlags = {};
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		const value = args[index + 1];
		if (arg === "--cwd") {
			if (value === undefined) return "--cwd needs a directory";
			flags.cwd = path.resolve(value);
			index += 1;
			continue;
		}
		if (arg === "--permission-timeout") {
			const ms = value === undefined ? Number.NaN : Number(value);
			if (!Number.isInteger(ms) || ms <= 0) return "--permission-timeout needs a positive whole number of milliseconds";
			flags.permissionTimeoutMs = ms;
			index += 1;
			continue;
		}
		return `unknown clio-coder acp option: ${arg ?? ""}`;
	}
	return flags;
}

/**
 * The workspace root the server is pinned to, resolved and then canonicalized
 * through the filesystem. A symlinked launch path is the reason: `process.cwd()`
 * reports the physical path after chdir, so a session request carrying the same
 * string the process was launched with used to be refused as a different
 * workspace. One canonical form on both sides removes that class of mismatch.
 * Throws when the path cannot be resolved, which the caller reports as an
 * unusable `--cwd`.
 */
export function resolveAcpCwd(value: string): string {
	return realpathSync(path.resolve(value));
}

export async function runAcpCommand(
	args: ReadonlyArray<string>,
	options: { apiKey?: string; noContextFiles?: boolean; noSkills?: boolean; skillPaths?: ReadonlyArray<string> } = {},
): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	const flags = parseAcpFlags(args);
	if (typeof flags === "string") {
		printError(flags);
		process.stderr.write(HELP);
		return 2;
	}
	// Boot has to happen in the workspace the sessions will use: settings
	// resolution, project context, and the session ledger all read process.cwd(),
	// and the server refuses a session whose cwd is not the one it booted in.
	// The path is canonicalized before the chdir so the launch root and every
	// later comparison against process.cwd() speak the same physical path.
	if (flags.cwd !== undefined) {
		try {
			process.chdir(resolveAcpCwd(flags.cwd));
		} catch {
			printError(`--cwd is not a directory this process can enter: ${flags.cwd}`);
			return 2;
		}
	}
	takeOverStdout();
	try {
		return await runClioCommand({
			...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
			...(options.noContextFiles ? { noContextFiles: true } : {}),
			...(options.noSkills ? { noSkills: true } : {}),
			...(options.skillPaths && options.skillPaths.length > 0 ? { skillPaths: options.skillPaths } : {}),
			acp: {
				// Stdout is JSON-RPC only. An unclassified handler failure answers the
				// client with fixed host text; the original message, which nothing in
				// this process authored, goes to the stderr tail.
				transportOptions: {
					write: writeRawStdout,
					diagnostics: (line) => {
						process.stderr.write(`[clio:acp] ${line}\n`);
					},
				},
				...(flags.permissionTimeoutMs === undefined ? {} : { permissionTimeoutMs: flags.permissionTimeoutMs }),
			},
		});
	} finally {
		restoreStdout();
	}
}
