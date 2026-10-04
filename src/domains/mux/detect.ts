/**
 * The capability ladder from spec 4.2.
 *
 * Guest mode requires all of: `HERDR_ENV=1`, the one socket this process is
 * bound to being connectable, and a `ping` answered inside one second. The three conditions are checked in that order
 * and the first one that fails ends detection, which is what makes the `none`
 * path free: with `HERDR_ENV` unset nothing here opens a file descriptor, and a
 * contract test pins that by making `net.connect` throw for the duration of the
 * call.
 *
 * Embedded hosting does not happen here. The workspace launcher
 * (src/cli/workspace-launch.ts) starts the pane host and runs Clio in one of
 * its panes, so the Clio that reaches this ladder under `embedded` is already
 * a guest of the host Clio started, and `embedded` detects exactly like `auto`.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { createMuxClient, type MuxClient } from "./socket-client.js";
import type { MuxLog, MuxMode, MuxSelfLocation, MuxServerInfo } from "./types.js";

/** Spec 4.2 gives the ping one second to answer before the rung is refused. */
const PING_TIMEOUT_MS = 1_000;

export type MuxEnablement = "auto" | "embedded" | "off";

export interface MuxDetection {
	mode: MuxMode;
	socketPath: string | null;
	server: MuxServerInfo | null;
	self: MuxSelfLocation;
	/** Socket paths considered, in resolution order, for doctor output. */
	candidates: ReadonlyArray<string>;
	/** Human-readable reason, always set; for `guest` it names the socket that answered. */
	reason: string;
	/**
	 * True when the operator asked for a rung Clio cannot provide, as opposed to
	 * asking for panes on a machine that has no pane host. The two are both
	 * `none` and neither is an error, but only the first is a promise Clio broke:
	 * nothing about the environment would change the answer, and the operator has
	 * to be told, because they configured a mode and got no panes. Callers raise
	 * a refusal to a visible level; an ordinary `none` stays at debug.
	 */
	refused: boolean;
}

export interface DetectMuxOptions {
	env?: NodeJS.ProcessEnv;
	enabled?: MuxEnablement;
	pingTimeoutMs?: number;
	log?: MuxLog;
	/** Injection seam for tests; production opens a real client. */
	openClient?: (socketPath: string) => MuxClient;
}

/**
 * herdr resolves its config dir through `XDG_CONFIG_HOME` first and falls back
 * to the platform default, which on Linux is `~/.config/herdr`. Mirroring that
 * matters: a user with `XDG_CONFIG_HOME` set has no `~/.config/herdr` at all,
 * and the spec's literal `~/.config/herdr` would miss every one of their
 * sockets.
 */
export function herdrConfigDir(env: NodeJS.ProcessEnv): string {
	const xdg = env.XDG_CONFIG_HOME;
	if (typeof xdg === "string" && xdg.length > 0) return join(xdg, "herdr");
	const home = typeof env.HOME === "string" && env.HOME.length > 0 ? env.HOME : homedir();
	return join(home, ".config", "herdr");
}

/**
 * The socket this process is bound to. Exactly one, chosen by the most
 * explicit identity the environment carries.
 *
 * `HERDR_SOCKET_PATH` is what a pane host hands every pane it owns, so when it
 * is set it is the only target: the pane ids beside it (`HERDR_PANE_ID` and
 * the rest) mean something on that server and nowhere else. `HERDR_SESSION`
 * names a session and binds the same way. Only with neither does detection
 * look at the default session.
 *
 * There is deliberately no fallback from an explicit identity to the default
 * socket. Pane ids are small and repeat across servers (`w1:p1` exists in most
 * of them), so a Clio whose own server has died and that fell back would report
 * its state onto, and open panes beside, whatever pane carries the same id in
 * the operator's default session. A dead explicit socket means no pane host.
 */
export function resolveSocketCandidates(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
	const explicit = env.HERDR_SOCKET_PATH;
	if (typeof explicit === "string" && explicit.length > 0) return [explicit];
	const configDir = herdrConfigDir(env);
	const session = env.HERDR_SESSION;
	if (typeof session === "string" && session.length > 0) {
		return [join(configDir, "sessions", session, "herdr.sock")];
	}
	return [join(configDir, "herdr.sock")];
}

function readSelfLocation(env: NodeJS.ProcessEnv): MuxSelfLocation {
	const read = (key: string): string | null => {
		const value = env[key];
		return typeof value === "string" && value.length > 0 ? value : null;
	};
	return {
		workspaceId: read("HERDR_WORKSPACE_ID"),
		tabId: read("HERDR_TAB_ID"),
		paneId: read("HERDR_PANE_ID"),
	};
}

function none(reason: string, candidates: ReadonlyArray<string> = [], refused = false): MuxDetection {
	return {
		mode: "none",
		socketPath: null,
		server: null,
		self: { workspaceId: null, tabId: null, paneId: null },
		candidates,
		reason,
		refused,
	};
}

/**
 * The detected rung plus the live client when one was reached. The client is
 * the same connection the ping went over, so the caller inherits a warm socket
 * rather than reconnecting.
 */
export interface MuxDetectionResult {
	detection: MuxDetection;
	client: MuxClient | null;
}

export async function detectMux(options: DetectMuxOptions = {}): Promise<MuxDetectionResult> {
	const env = options.env ?? process.env;
	const enabled = options.enabled ?? "auto";
	const log = options.log ?? ((): void => undefined);

	if (enabled === "off") {
		return { detection: none("panes are turned off"), client: null };
	}
	// `embedded` hosting is the launcher's job (src/cli/workspace-launch.ts): it
	// puts Clio in a pane before this runs. What reaches here under `embedded`
	// is therefore the same question as `auto`, asked from inside or outside a
	// pane host, and takes the same ladder.
	if (env.HERDR_ENV !== "1") {
		return { detection: none("HERDR_ENV is not 1, so Clio is not running inside a pane host"), client: null };
	}

	const candidates = resolveSocketCandidates(env);
	const openClient = options.openClient ?? ((socketPath: string) => createMuxClient({ socketPath, log }));
	const pingTimeoutMs = options.pingTimeoutMs ?? PING_TIMEOUT_MS;

	for (const socketPath of candidates) {
		const client = openClient(socketPath);
		try {
			const server = await client.ping({ timeoutMs: pingTimeoutMs });
			return {
				detection: {
					mode: "guest",
					socketPath,
					server,
					self: readSelfLocation(env),
					candidates,
					reason: `guest mode on ${socketPath} (herdr ${server.version}, protocol ${server.protocol})`,
					refused: false,
				},
				client,
			};
		} catch (error) {
			log("debug", `mux ping ${socketPath} failed: ${error instanceof Error ? error.message : String(error)}`);
			await client.close().catch(() => undefined);
		}
	}

	return {
		detection: none(
			`the pane host socket this session is bound to did not answer a ping: ${candidates.join(", ")}`,
			candidates,
		),
		client: null,
	};
}
