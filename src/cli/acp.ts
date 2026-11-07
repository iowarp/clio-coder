import { realpathSync } from "node:fs";
import path from "node:path";
import { MAX_TIMER_DELAY_MS } from "../core/timers.js";
import type { SessionToolLimits } from "../core/tool-limit-flags.js";
import { parseToolLimitList, toolLimitConstraints } from "../core/tool-limit-flags.js";
import { createStdioServerTransport } from "../engine/acp/transport.js";
import { runClioCommand } from "./clio.js";
import { restoreStdout, takeOverStdout, writeRawStdout } from "./output-guard.js";
import { printError } from "./shared.js";

const HELP = `clio-coder acp [--cwd PATH] [--permission-timeout MS] [--allow-tools NAMES] [--delegate-tools NAMES] [--read-only]
clio-coder acp [--cwd PATH] auth login

Serve Clio Coder as an Agent Client Protocol v1 agent over stdio.

  --cwd PATH               Pin this workspace: every session must name it. Without
                           it, the first workspace request selects the root.
  --permission-timeout MS  How long a mediated permission request may wait for the
                           client before the prompt expires. Defaults to the configured
                           integrations.externalAgents.defaults.permissionTimeoutMs.
  --allow-tools NAMES      Limit the session's tools to these comma-separated
                           capabilities, as clio-coder run does; none disables all.
  --delegate-tools NAMES   Limit the tools the session's dispatched workers may hold.
  --read-only              Hold every session to the read-only ceiling and write
                           nothing to the Clio home: no session, run record,
                           telemetry or cache outlives the process.
  auth login               Open interactive Quick Connect for terminal ACP authentication.

This command is intended for ACP frontends to spawn. Interactive delegation remains
available through /agents, /delegate, the dispatch board, and run records.
`;

interface AcpFlags {
	cwd?: string;
	permissionTimeoutMs?: number;
	toolLimits?: SessionToolLimits;
	readOnly?: true;
}

/** Parsed flags, or the message explaining why the invocation is not usable. */
export function parseAcpFlags(args: ReadonlyArray<string>): AcpFlags | string {
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
		if (arg === "--read-only") {
			flags.readOnly = true;
			continue;
		}
		if (arg === "--allow-tools" || arg === "--delegate-tools") {
			if (value === undefined) return `${arg} needs comma-separated capability names, or none`;
			const names = parseToolLimitList(arg, value);
			if ("error" in names) return names.error;
			flags.toolLimits = {
				...flags.toolLimits,
				...toolLimitConstraints(arg, names),
			};
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

/** Enters read-only mode for the process, or returns why this home cannot be served read-only. */
async function enterAcpReadOnly(): Promise<string | null> {
	const [{ enterReadOnlyMode }, { enterPrivateHomeIfNeverSetUp }, { pendingMigrationIds }] = await Promise.all([
		import("../core/read-only-mode.js"),
		import("../core/read-only-home.js"),
		import("../domains/lifecycle/boot-migrations.js"),
	]);
	enterReadOnlyMode();
	if (enterPrivateHomeIfNeverSetUp() !== null) {
		process.stderr.write("clio-coder acp: --read-only on a home Clio has not set up; this server keeps nothing\n");
		return null;
	}
	// Migrations rewrite and delete home state, and skipping one leaves strict readers on an old shape.
	const pending = pendingMigrationIds();
	if (pending === null) return "--read-only cannot read this home's migration record; run clio-coder doctor";
	if (pending.length > 0) {
		return `--read-only cannot apply ${pending.length} pending migration${pending.length === 1 ? "" : "s"} (${pending.join(", ")}); run clio-coder upgrade --post-install, then retry`;
	}
	process.stderr.write(
		"clio-coder acp: --read-only writes nothing to the Clio home; sessions, run records and telemetry are not kept\n",
	);
	return null;
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
	// An explicit root is entered here and pinned on the front. Without one, the
	// open transport selects the root at the first workspace request before any
	// project graph loads.
	if (flags.cwd !== undefined) {
		try {
			process.chdir(resolveAcpCwd(flags.cwd));
		} catch {
			printError(`--cwd is not a directory this process can enter: ${flags.cwd}`);
			return 2;
		}
	}
	if (terminalAuth && flags.readOnly) {
		printError("auth login saves a credential; run it without --read-only");
		return 2;
	}
	if (terminalAuth) return (await import("./configure.js")).runConfigureCommand(["--quick"]);
	// Entered before the boot registers its build, opens a session or loads a
	// skill, so none of them writes to the home. Every session, including one
	// loaded or forked, is held to the read-only ceiling below.
	if (flags.readOnly) {
		const refusal = await enterAcpReadOnly();
		if (refusal !== null) {
			printError(refusal);
			return 1;
		}
	}
	takeOverStdout();
	try {
		// Both launch forms serve through the deferred front, so initialize is
		// answered before the orchestrator boots. What the client advertises there
		// (an attended surface, or none) decides which tools and ask routes the
		// boot builds, and an eager boot would have to guess it.
		const launchCwd = process.cwd();
		process.stdin.pause();
		const transport = createStdioServerTransport({
			write: writeRawStdout,
			diagnostics: (line) => process.stderr.write(`[clio-coder:acp] ${line}\n`),
		});
		process.stdin.pause();
		try {
			const [{ ACP_COMMANDS_CAPABILITY }, { serveDeferredAcp }, { createAcpHandshake }, { readClioVersionLabel }] =
				await Promise.all([
					import("../engine/acp/commands.js"),
					import("../engine/acp/deferred-boot.js"),
					import("../engine/acp/server.js"),
					import("../core/build-info.js"),
				]);
			const handshake = createAcpHandshake({
				version: readClioVersionLabel(),
				session: true,
				loadSession: true,
				settings: true,
				providers: true,
				commandsCapability: { ...ACP_COMMANDS_CAPABILITY, promptTurns: true },
				steer: true,
				dispatch: true,
				toolRegistry: true,
				bus: true,
				board: true,
				boardActions: true,
				branches: true,
				handoff: true,
				fleet: true,
				contextLedger: true,
				artifacts: true,
				extensions: true,
				libraryReload: true,
				aside: true,
				workspace: true,
				images: true,
				interviews: true,
				workerPermissions: true,
				shell: true,
				queueEdit: true,
				telemetry: true,
				jobs: true,
				ceiling: true,
			});
			const serving = serveDeferredAcp({
				transport,
				handshake,
				launchCwd,
				...(flags.cwd !== undefined ? { pinned: true } : {}),
				boot: async (_cwd, ready) =>
					await runClioCommand({
						...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
						...(options.noContextFiles ? { noContextFiles: true } : {}),
						...(options.noSkills ? { noSkills: true } : {}),
						...(options.skillPaths && options.skillPaths.length > 0 ? { skillPaths: options.skillPaths } : {}),
						...(flags.toolLimits === undefined && !flags.readOnly
							? {}
							: { toolLimits: { ...flags.toolLimits, ...(flags.readOnly ? { readOnly: true as const } : {}) } }),
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
	} finally {
		restoreStdout();
	}
}
