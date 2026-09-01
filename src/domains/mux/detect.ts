/**
 * The capability ladder from spec 4.2.
 *
 * Guest mode requires all of: `HERDR_ENV=1`, a connectable socket, and a `ping`
 * answered inside one second. The three conditions are checked in that order
 * and the first one that fails ends detection, which is what makes the `none`
 * path free: with `HERDR_ENV` unset nothing here opens a file descriptor, and a
 * contract test pins that by making `net.connect` throw for the duration of the
 * call.
 *
 * Embedded mode resolves to `none` until Phase 5 lands the session bootstrap.
 * Asking for it is not an error, but it is a refusal rather than a quiet
 * degrade: the detection carries `refused: true`, the boot prints the reason on
 * stderr, and doctor's mode row warns. A session that asked for panes and got
 * none should never have to guess why, and `embedded` costs guest mode too, so
 * the reason names `auto` as the rung that works today.
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
function herdrConfigDir(env: NodeJS.ProcessEnv): string {
	const xdg = env.XDG_CONFIG_HOME;
	if (typeof xdg === "string" && xdg.length > 0) return join(xdg, "herdr");
	const home = typeof env.HOME === "string" && env.HOME.length > 0 ? env.HOME : homedir();
	return join(home, ".config", "herdr");
}

/** Socket paths to try, in the order spec 4.2 fixes. */
export function resolveSocketCandidates(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
	const candidates: string[] = [];
	const explicit = env.HERDR_SOCKET_PATH;
	if (typeof explicit === "string" && explicit.length > 0) candidates.push(explicit);
	const configDir = herdrConfigDir(env);
	const session = env.HERDR_SESSION;
	if (typeof session === "string" && session.length > 0) {
		candidates.push(join(configDir, "sessions", session, "herdr.sock"));
	}
	candidates.push(join(configDir, "herdr.sock"));
	return [...new Set(candidates)];
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
	if (enabled === "embedded") {
		// Phase 5 owns the session bootstrap. Until then the honest answer is that
		// Clio cannot provide panes, not that it failed to find them, and the
		// operator hears it: this degrade is marked a refusal so the boot says so
		// out loud rather than logging a debug line nobody reads. The reason also
		// names the rung that does work, because `embedded` costs guest mode too.
		return {
			detection: none(
				"embedded mode is not implemented yet; it ships in phase 5, so this session has no panes at all. Set interface.panes.enabled=auto for guest mode inside a herdr session.",
				[],
				true,
			),
			client: null,
		};
	}
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
			candidates.length > 0
				? `no herdr socket answered a ping: tried ${candidates.join(", ")}`
				: "no herdr socket candidates resolved",
			candidates,
		),
		client: null,
	};
}
