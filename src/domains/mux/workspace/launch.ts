/**
 * Open a Clio workspace: the pane host Clio starts for itself.
 *
 * This is the `embedded` rung. The process that runs here is a launcher and
 * never boots Clio. It starts (or finds) the named herdr session, makes a
 * workspace for the project, runs Clio in that workspace's first pane, and then
 * hands the terminal to herdr's client until the operator leaves. The Clio that
 * runs in the pane sees `HERDR_ENV=1` and joins as a guest through the ordinary
 * detection ladder, so there is one pane code path, not two.
 *
 * Three ownership rules. The session is Clio's own, one per project
 * directory and named for it, so the operator's default herdr session and any
 * session Clio did not name are never listed, touched or stopped. The
 * pane host outlives the launcher only while it still holds a workspace: when
 * the last one closes, the launcher stops the server rather than leaving a
 * daemon nobody asked for.
 *
 * Two launchers share a session when `clio-coder` is run twice in one
 * project, and that is intended: the second reattaches to the first's
 * workspace. So everything that changes the session's shape, which is
 * starting the server, creating a workspace, closing one and stopping the
 * server, happens under one cross-process lock keyed by the session. A launcher that finds the session empty and stops it
 * cannot do so between another launcher's server check and its workspace.
 *
 * Leaving is a handshake rather than a pane closing. herdr replaces the last
 * workspace with a fresh one the moment it closes under an attached client, so
 * "the session is empty" never becomes true while the operator is looking at
 * it. Instead the Clio in the pane drops a marker when it quits cleanly
 * (`markWorkspaceExit`), and the launcher detaches the client first and closes
 * the workspace second, with nobody attached to trigger a replacement. A Clio
 * that crashed drops no marker, so its pane and its error stay on screen. And every failure before the terminal is handed
 * over returns `fallback`, which the caller answers by booting Clio in the
 * plain terminal, because a pane host that will not start must never be the
 * reason Clio does not.
 */

import type { ChildProcess } from "node:child_process";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { shellQuote } from "../../../core/shell-quote.js";
import { withStateFileLock } from "../../../core/state-file-lock.js";
import { herdrConfigDir } from "../detect.js";
import { MUX_MIN_PROTOCOL } from "../protocol.js";
import type { MuxClient } from "../socket-client.js";
import { createMuxClient } from "../socket-client.js";
import type { MuxLog, MuxPane, MuxServerInfo } from "../types.js";
import { writeWorkspaceConfig } from "./config.js";
import { EXIT_MARKER_PREFIX, exitMarkerPath, workspaceSessionFor } from "./exit-marker.js";

/** How long a freshly spawned server gets to answer its first ping. */
const SERVER_START_TIMEOUT_MS = 8_000;
/** How long a server told to stop gets to let go of its socket. */
const SERVER_STOP_TIMEOUT_MS = 5_000;
const SERVER_POLL_MS = 100;
/** The agent name Clio reports for its own pane (src/domains/mux/contract.ts). */
const CLIO_AGENT = "clio-coder";
const WORKSPACE_TOKEN = "clio_coder_workspace";
const WORKSPACE_METADATA_SOURCE = "clio-coder:workspace";
const WORKSPACE_NONCE = /^[0-9a-f-]{36}$/u;
const EXIT_POLL_MS = 200;
/** Every this many exit polls, also ask whether the workspace still exists. */
const WORKSPACE_CHECK_EVERY = 5;
/**
 * A launcher that saw the marker waits this long before it closes the
 * workspace, so a second launcher on the same workspace has polled the marker
 * and hung up its own client first. herdr replaces the last workspace when it
 * closes under an attached client, and that replacement would keep the server
 * alive with nothing in it.
 */
const SHARED_DETACH_SETTLE_MS = 3 * EXIT_POLL_MS;

export interface WorkspaceLaunchOptions {
	/** Absolute path of the herdr binary the resolution ladder chose. */
	herdrPath: string;
	/** That binary's version when it could be read; a running server must match it to be reused. */
	herdrVersion: string | null;
	cwd: string;
	/** The command line that starts Clio inside the pane, one word per element. */
	clioArgv: ReadonlyArray<string>;
	/**
	 * What the Clio in the pane needs from this launch's environment
	 * (src/domains/mux/child-env.ts). The server may be an earlier launch's, so
	 * its own environment says nothing about this one.
	 */
	clioEnv?: Readonly<Record<string, string>>;
	env?: NodeJS.ProcessEnv;
	log?: MuxLog;
}

export type WorkspaceLaunchResult =
	/** The terminal was handed to the workspace and has come back. */
	| { status: "closed"; exitCode: number; workspaceLeftRunning: boolean }
	/** Nothing was handed over; boot Clio in this terminal instead. */
	| { status: "fallback"; reason: string };

/**
 * The environment herdr's own processes run under: the caller's, minus any
 * herdr coordinates it inherited, plus Clio's managed config. Stripping matters
 * because `HERDR_SOCKET_PATH` beats `--session`, and a stale one would send
 * every command below to whatever session it names.
 */
function workspaceHostEnv(env: NodeJS.ProcessEnv, configPath: string): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		if (!key.startsWith("HERDR_")) out[key] = value;
	}
	out.HERDR_CONFIG_PATH = configPath;
	return out;
}

/** The sidebar label for a project: its directory name. */
function workspaceLabel(cwd: string): string {
	return basename(cwd) || cwd;
}

/** The line typed into the pane's shell: the Clio command, one shell word per argument. */
function workspaceShellLine(clioArgv: ReadonlyArray<string>): string {
	return clioArgv.map((word) => (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(word) ? word : shellQuote(word))).join(" ");
}

/**
 * Everything one launch knows about where it runs, computed once from the
 * project directory and carried through every step, so the server that is
 * started, the socket that is pinged, the client that attaches, the lock and
 * the exit marker can never disagree about which session they mean.
 */
interface Host {
	options: WorkspaceLaunchOptions;
	hostEnv: NodeJS.ProcessEnv;
	/** The session name, `clio-coder-<hash of the resolved directory>`. */
	session: string;
	/** The project directory with every symlink resolved. */
	cwd: string;
	socketPath: string;
	sessionDir: string;
	/**
	 * The lifecycle lock's target. It sits in a directory of Clio's own beside
	 * herdr's `sessions`, not inside the session directory, because herdr
	 * deletes that directory with the session and a lock that can vanish under
	 * its holder serializes nothing.
	 */
	lockTarget: string;
	log: MuxLog;
}

function resolveHost(options: WorkspaceLaunchOptions, configPath: string): Host {
	const env = options.env ?? process.env;
	const identity = workspaceSessionFor(options.cwd);
	const configDir = herdrConfigDir(env);
	const sessionDir = join(configDir, "sessions", identity.session);
	return {
		options,
		hostEnv: workspaceHostEnv(env, configPath),
		session: identity.session,
		cwd: identity.cwd,
		socketPath: join(sessionDir, "herdr.sock"),
		sessionDir,
		lockTarget: join(configDir, "clio-coder-locks", identity.session),
		log: options.log ?? ((): void => undefined),
	};
}

function openClient(host: Host): MuxClient {
	return createMuxClient({
		socketPath: host.socketPath,
		// The launcher polls; the client's own backoff would turn a server that
		// is 200ms from listening into a multi-second wait.
		backoff: { initialDelayMs: 0, maxDelayMs: 0, factor: 1 },
		log: host.log,
	});
}

async function pingOnce(host: Host): Promise<{ client: MuxClient; server: MuxServerInfo } | null> {
	const client = openClient(host);
	try {
		return { client, server: await client.ping({ timeoutMs: 500 }) };
	} catch {
		await client.close();
		return null;
	}
}

/** Why a running server cannot host this launch, or null when it can. */
function serverMismatch(server: MuxServerInfo, wantedVersion: string | null): string | null {
	if (server.protocol < MUX_MIN_PROTOCOL) {
		return `it speaks protocol ${server.protocol}, below the ${MUX_MIN_PROTOCOL} Clio drives`;
	}
	// herdr's client and server negotiate a private protocol of their own, and
	// the only pairing known to work is a binary with the server it started.
	if (wantedVersion !== null && server.version !== wantedVersion) {
		return `it is herdr ${server.version} and this Clio runs herdr ${wantedVersion}`;
	}
	return null;
}

/** Ask the server to stop and wait until its socket stops answering. True when it is gone. */
async function stopServer(host: Host, client: MuxClient): Promise<boolean> {
	await client.serverStop().catch(() => undefined);
	const deadline = performance.now() + SERVER_STOP_TIMEOUT_MS;
	while (performance.now() < deadline) {
		await sleep(SERVER_POLL_MS);
		const again = await pingOnce(host);
		if (again === null) return true;
		await again.client.close();
	}
	return false;
}

/**
 * A reachable, compatible server, started if there was none. Call under the
 * session lock. A running server that does not match is replaced only when it
 * holds nothing; one with live workspaces is somebody's work and is left alone.
 */
async function ensureServer(host: Host): Promise<{ client: MuxClient; started: boolean } | { refused: string }> {
	const running = await pingOnce(host);
	if (running !== null) {
		const mismatch = serverMismatch(running.server, host.options.herdrVersion);
		if (mismatch === null) return { client: running.client, started: false };
		let live: number;
		try {
			live = (await running.client.workspaceList()).length;
		} catch {
			// A server that will not say what it holds is treated as holding something.
			live = -1;
		}
		if (live !== 0) {
			await running.client.close();
			const held = live < 0 ? "workspaces it would not list" : `${live} open workspace${live === 1 ? "" : "s"}`;
			return {
				refused: `this project's Clio workspace is already running with ${held}, and ${mismatch}; quit Clio there first`,
			};
		}
		const stopped = await stopServer(host, running.client);
		await running.client.close();
		if (!stopped) return { refused: `an idle pane host from an earlier version did not stop (${mismatch})` };
	}

	const server = spawn(host.options.herdrPath, ["--session", host.session, "server"], {
		cwd: host.cwd,
		env: host.hostEnv,
		detached: true,
		stdio: "ignore",
	});
	let spawnFailed = false;
	server.once("error", () => {
		spawnFailed = true;
	});
	server.unref();

	const deadline = performance.now() + SERVER_START_TIMEOUT_MS;
	while (performance.now() < deadline && !spawnFailed) {
		await sleep(SERVER_POLL_MS);
		const started = await pingOnce(host);
		if (started !== null) return { client: started.client, started: true };
	}
	return { refused: `the pane host did not start (${host.options.herdrPath})` };
}

/**
 * A live Clio already running in this project's session, so a second launch
 * reattaches instead of doubling up. A pane whose exit marker exists is a Clio
 * that has quit and whose agent record the host has not cleared yet, not a
 * running one.
 */
async function findRunningClio(host: Host, client: MuxClient): Promise<MuxPane | null> {
	for (const workspace of await client.workspaceList()) {
		const panes = await client.paneList(workspace.workspaceId);
		const clio = panes.find(
			(pane) =>
				(pane.agent === CLIO_AGENT || WORKSPACE_NONCE.test(pane.tokens[WORKSPACE_TOKEN] ?? "")) &&
				pane.cwd === host.cwd &&
				!existsSync(exitMarkerPath(host.sessionDir, pane.paneId)),
		);
		if (clio) return clio;
	}
	return null;
}

function runHerdr(host: Host, args: ReadonlyArray<string>): boolean {
	const result = spawnSync(host.options.herdrPath, ["--session", host.session, ...args], {
		cwd: host.cwd,
		env: host.hostEnv,
		stdio: "ignore",
		timeout: 10_000,
	});
	return result.status === 0;
}

/** Stop the session's server when it holds nothing. Call under the session lock. True when no server is left. */
async function stopServerIfEmpty(host: Host, client: MuxClient): Promise<boolean> {
	try {
		if ((await client.workspaceList()).length > 0) return false;
	} catch {
		return (await pingOnce(host)) === null;
	}
	if (!(await stopServer(host, client))) return false;
	// With the server gone its pane ids start over, so every marker is stale.
	try {
		for (const name of readdirSync(host.sessionDir)) {
			if (name.startsWith(EXIT_MARKER_PREFIX)) rmSync(join(host.sessionDir, name), { force: true });
		}
	} catch {
		// The directory is herdr's; a marker left behind is cleared by the next Clio in that pane.
	}
	// One session per project would otherwise leave one stopped session behind
	// for every directory Clio was ever run in. It holds nothing, it is Clio's
	// own by name, and the lock that guards this lives outside it.
	spawnSync(host.options.herdrPath, ["session", "delete", host.session], {
		cwd: host.cwd,
		env: host.hostEnv,
		stdio: "ignore",
		timeout: 10_000,
	});
	return true;
}

/**
 * What a launch opened, and which of it is this launch's own. Only what a
 * launch made itself is ever undone when the launch fails: a workspace it
 * reattached to and a server it found running belong to an earlier launch.
 */
type Opened =
	| {
			client: MuxClient;
			clioPane: MuxPane;
			workspaceId: string;
			createdWorkspace: boolean;
			startedServer: boolean;
			workspaceNonce: string;
	  }
	| { refused: string };

/** Pane ids restart with the server; the nonce identifies the workspace this launcher actually opened. */
async function stillOwnsWorkspace(client: MuxClient, opened: Exclude<Opened, { refused: string }>): Promise<boolean> {
	if (!(await client.workspaceList()).some((workspace) => workspace.workspaceId === opened.workspaceId)) return false;
	const panes = await client.paneList(opened.workspaceId);
	return panes.some(
		(pane) => pane.paneId === opened.clioPane.paneId && pane.tokens[WORKSPACE_TOKEN] === opened.workspaceNonce,
	);
}

async function tagWorkspace(client: MuxClient, pane: MuxPane): Promise<string> {
	const existing = pane.tokens[WORKSPACE_TOKEN];
	if (existing !== undefined && WORKSPACE_NONCE.test(existing)) return existing;
	const nonce = randomUUID();
	await client.paneReportMetadata({
		paneId: pane.paneId,
		source: WORKSPACE_METADATA_SOURCE,
		tokens: { [WORKSPACE_TOKEN]: nonce },
	});
	return nonce;
}

/** Undo this launch's own resources and nothing else. Call under the session lock. */
async function undoLaunch(
	host: Host,
	client: MuxClient,
	own: { workspaceId: string | null; startedServer: boolean },
): Promise<void> {
	if (own.workspaceId !== null) await client.workspaceClose(own.workspaceId).catch(() => undefined);
	if (own.startedServer) await stopServerIfEmpty(host, client);
}

/** Server, workspace and Clio, as one step under the session lock. */
async function openWorkspace(host: Host): Promise<Opened> {
	const ensured = await ensureServer(host);
	if ("refused" in ensured) return ensured;
	const client = ensured.client;
	const startedServer = ensured.started;
	let createdWorkspaceId: string | null = null;
	try {
		const running = await findRunningClio(host, client);
		if (running) {
			const workspaceNonce = await tagWorkspace(client, running);
			await client.workspaceFocus(running.workspaceId);
			return {
				client,
				clioPane: running,
				workspaceId: running.workspaceId,
				createdWorkspace: false,
				startedServer,
				workspaceNonce,
			};
		}
		const created = await client.workspaceCreate({
			cwd: host.cwd,
			label: workspaceLabel(host.cwd),
			focus: true,
			...(host.options.clioEnv ? { env: host.options.clioEnv } : {}),
		});
		const clioPane = created.rootPane;
		createdWorkspaceId = created.workspace.workspaceId;
		// Tag before starting Clio: another launcher must see the pending child even before its first self-report.
		const workspaceNonce = await tagWorkspace(client, clioPane);
		// This pane id is new in this server's life, so nobody can be waiting on
		// its marker; one left by an earlier server would end the launch at once.
		rmSync(exitMarkerPath(host.sessionDir, clioPane.paneId), { force: true });
		await client.tabRename(clioPane.tabId, "clio").catch(() => undefined);
		// `pane run` is herdr's own "type this and press enter", so the launcher
		// inherits whatever shell-readiness handling the installed release has.
		if (!runHerdr(host, ["pane", "run", clioPane.paneId, workspaceShellLine(host.options.clioArgv)])) {
			await undoLaunch(host, client, { workspaceId: createdWorkspaceId, startedServer });
			await client.close();
			return { refused: "the pane host refused to start Clio in the new workspace" };
		}
		return { client, clioPane, workspaceId: createdWorkspaceId, createdWorkspace: true, startedServer, workspaceNonce };
	} catch (error) {
		await undoLaunch(host, client, { workspaceId: createdWorkspaceId, startedServer });
		await client.close();
		return { refused: `the pane host rejected the workspace: ${messageOf(error)}` };
	}
}

export async function launchWorkspace(options: WorkspaceLaunchOptions): Promise<WorkspaceLaunchResult> {
	let host: Host;
	try {
		host = resolveHost(options, writeWorkspaceConfig());
	} catch (error) {
		return { status: "fallback", reason: `could not prepare the workspace: ${messageOf(error)}` };
	}
	const lockTarget = host.lockTarget;

	let opened: Opened;
	try {
		opened = await withStateFileLock(lockTarget, () => openWorkspace(host));
	} catch (error) {
		return { status: "fallback", reason: `could not take the workspace session lock: ${messageOf(error)}` };
	}
	if ("refused" in opened) return { status: "fallback", reason: opened.refused };
	const { client, clioPane, workspaceId } = opened;
	const marker = exitMarkerPath(host.sessionDir, clioPane.paneId);

	// From here the terminal belongs to herdr's client until it exits.
	const attach = spawn(options.herdrPath, ["--session", host.session], {
		cwd: host.cwd,
		env: host.hostEnv,
		stdio: "inherit",
	});

	// Two reasons to hang up for the operator: this pane's Clio quit, or another
	// launcher on the same workspace saw that first and has closed it.
	let clioQuit = false;
	let workspaceGone = false;
	let ticks = 0;
	let asking = false;
	const poll = setInterval(() => {
		if (existsSync(marker)) {
			clioQuit = true;
			clearInterval(poll);
			detach(attach);
			return;
		}
		ticks += 1;
		if (ticks % WORKSPACE_CHECK_EVERY !== 0 || asking) return;
		asking = true;
		stillOwnsWorkspace(client, opened).then(
			(owned) => {
				asking = false;
				if (owned) return;
				workspaceGone = true;
				clearInterval(poll);
				detach(attach);
			},
			() => {
				// An unanswered question is not an answer; ask again next time.
				asking = false;
			},
		);
	}, EXIT_POLL_MS);

	// The client owns the terminal, so Ctrl+C belongs to the pane it is typed in.
	const ignore = (): void => undefined;
	process.on("SIGINT", ignore);
	const exit = await new Promise<{ code: number } | { spawnError: Error }>((resolve) => {
		attach.once("error", (error) => resolve({ spawnError: error }));
		attach.once("exit", (code) => resolve({ code: code ?? 0 }));
	});
	process.off("SIGINT", ignore);
	clearInterval(poll);

	if ("spawnError" in exit) {
		// The client never ran, so the terminal was never handed over and Clio
		// boots here instead. The Clio this launch started in a pane nobody can
		// see would otherwise run on unattended, so what this launch made is
		// undone; a workspace it reattached to is another launch's and stays.
		try {
			await withStateFileLock(lockTarget, async () => {
				if (!(await stillOwnsWorkspace(client, opened))) return;
				await undoLaunch(host, client, {
					workspaceId: opened.createdWorkspace ? workspaceId : null,
					startedServer: opened.startedServer,
				});
			});
		} catch (error) {
			host.log("debug", `workspace launch undo skipped: ${messageOf(error)}`);
		}
		await client.close();
		return { status: "fallback", reason: `the pane host client did not start: ${exit.spawnError.message}` };
	}
	const exitCode = exit.code;

	if (clioQuit) await sleep(SHARED_DETACH_SETTLE_MS);
	let workspaceLeftRunning = true;
	try {
		workspaceLeftRunning = await withStateFileLock(lockTarget, async () => {
			// A co-attached launcher may already have removed our workspace and a new server may reuse its ids.
			if (!(await stillOwnsWorkspace(client, opened))) return false;
			if (clioQuit) {
				// Clio is done. If the operator split nothing beside it the workspace
				// is only Clio's leftover shell and goes with it; anything else in
				// there is theirs and stays. The marker goes only with the workspace,
				// so another launcher still attached to it is never left waiting.
				try {
					const panes = await client.paneList(workspaceId);
					if (panes.length <= 1) {
						await client.workspaceClose(workspaceId);
						rmSync(marker, { force: true });
					}
				} catch (error) {
					host.log("debug", `workspace cleanup skipped: ${messageOf(error)}`);
				}
			}
			return !(await stopServerIfEmpty(host, client));
		});
	} catch (error) {
		host.log("debug", `workspace session cleanup skipped: ${messageOf(error)}`);
	}
	await client.close();
	// A hangup the launcher sent is the clean way out, not a failure to report.
	return { status: "closed", exitCode: clioQuit || workspaceGone ? 0 : exitCode, workspaceLeftRunning };
}

/** herdr's client treats a hangup as the terminal going away and detaches cleanly. */
function detach(attach: ChildProcess): void {
	if (attach.exitCode === null && !attach.killed) attach.kill("SIGHUP");
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
