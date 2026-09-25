import { realpathSync } from "node:fs";
import path from "node:path";
import { MAX_TIMER_DELAY_MS } from "../core/timers.js";
import { createStdioServerTransport } from "../engine/acp/transport.js";
import { runClioCommand } from "./clio.js";
import { restoreStdout, takeOverStdout, writeRawStdout } from "./output-guard.js";
import { printError } from "./shared.js";

const HELP = `clio-coder acp [--cwd PATH] [--permission-timeout MS]

Serve Clio Coder as an Agent Client Protocol v1 agent over stdio.

  --cwd PATH               Bind this workspace before initialize. Without it,
                           the first workspace request selects the root.
  --permission-timeout MS  How long a mediated permission request may wait for the
                           client before the prompt expires. Defaults to the configured
                           delegation.defaults.permissionTimeoutMs.
  auth login               Open interactive Quick Connect for terminal ACP authentication.

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
			if (!Number.isInteger(ms) || ms <= 0 || ms > MAX_TIMER_DELAY_MS) {
				return `--permission-timeout needs a whole number from 1 to ${MAX_TIMER_DELAY_MS} milliseconds`;
			}
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
function resolveAcpCwd(value: string): string {
	return realpathSync(path.resolve(value));
}

export async function runAcpCommand(
	args: ReadonlyArray<string>,
	options: { apiKey?: string; noContextFiles?: boolean; noSkills?: boolean; skillPaths?: ReadonlyArray<string> } = {},
): Promise<number> {
	// The top-level argv parser normally rewrites --acp to the `acp` command
	// sentinel. Keep the command boundary tolerant too, so another dispatcher
	// can pass the flag spelling through without changing ACP option semantics.
	const normalizedArgs = args[0] === "--acp" ? args.slice(1) : args;
	const terminalAuth = normalizedArgs.at(-2) === "auth" && normalizedArgs.at(-1) === "login";
	if (normalizedArgs.includes("--help") || normalizedArgs.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	const flags = parseAcpFlags(terminalAuth ? normalizedArgs.slice(0, -2) : normalizedArgs);
	if (typeof flags === "string") {
		printError(flags);
		process.stderr.write(HELP);
		return 2;
	}
	// An explicit root binds eagerly. Without one, the open transport selects
	// the root at the first workspace request before any project graph loads.
	if (flags.cwd !== undefined) {
		try {
			process.chdir(resolveAcpCwd(flags.cwd));
		} catch {
			printError(`--cwd is not a directory this process can enter: ${flags.cwd}`);
			return 2;
		}
	}
	if (terminalAuth) return (await import("./configure.js")).runConfigureCommand(["--quick"]);
	takeOverStdout();
	try {
		if (flags.cwd === undefined) {
			const launchCwd = process.cwd();
			process.stdin.pause();
			const transport = createStdioServerTransport({
				write: writeRawStdout,
				diagnostics: (line) => process.stderr.write(`[clio-coder:acp] ${line}\n`),
			});
			process.stdin.pause();
			try {
				const [{ ACP_COMMANDS_CAPABILITY }, { serveDeferredAcp }, { createAcpHandshake }, { getVersionInfo }] =
					await Promise.all([
						import("../engine/acp/commands.js"),
						import("../engine/acp/deferred-boot.js"),
						import("../engine/acp/server.js"),
						import("../domains/lifecycle/version.js"),
					]);
				const handshake = createAcpHandshake({
					version: getVersionInfo().clio,
					session: true,
					loadSession: true,
					settings: true,
					providers: true,
					commandsCapability: ACP_COMMANDS_CAPABILITY,
					steer: true,
					dispatch: true,
					toolRegistry: true,
					bus: true,
				});
				const serving = serveDeferredAcp({
					transport,
					handshake,
					launchCwd,
					boot: async (_cwd, ready) =>
						await runClioCommand({
							...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
							...(options.noContextFiles ? { noContextFiles: true } : {}),
							...(options.noSkills ? { noSkills: true } : {}),
							...(options.skillPaths && options.skillPaths.length > 0 ? { skillPaths: options.skillPaths } : {}),
							acp: {
								transport,
								handshake,
								onReady: ready,
								...(flags.permissionTimeoutMs === undefined ? {} : { permissionTimeoutMs: flags.permissionTimeoutMs }),
							},
						}),
				});
				process.stdin.resume();
				return await serving;
			} catch (error) {
				transport.close();
				throw error;
			} finally {
				process.stdin.resume();
			}
		}
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
						process.stderr.write(`[clio-coder:acp] ${line}\n`);
					},
				},
				...(flags.permissionTimeoutMs === undefined ? {} : { permissionTimeoutMs: flags.permissionTimeoutMs }),
			},
		});
	} finally {
		restoreStdout();
	}
}
