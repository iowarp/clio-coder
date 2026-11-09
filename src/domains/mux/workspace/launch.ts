/**
 * Open a Clio workspace: the private pane host Clio starts for itself.
 *
 * The process that runs here is a launcher and never boots Clio. It starts
 * (or finds) this project's private herdr host, makes a
 * workspace for the project, runs Clio in that workspace's first pane, and then
 * hands the terminal to herdr's client until the operator leaves. The Clio that
 * runs in the pane sees `HERDR_ENV=1` and joins as a guest through the ordinary
 * detection ladder, so there is one pane code path, not two.
 *
 * Three ownership rules. The host is Clio's own, one per project and Clio state directory
 * and named for it, laid out by the platform (src/domains/mux/workspace/
 * platform.ts) so the operator's own herdr, its sessions and its socket are
 * never listed, touched or stopped. The host always runs Clio's vendored herdr
 * pin, never a copy on PATH. And the host outlives the launcher only while it
 * still holds a workspace: when the last one closes, the launcher stops the
 * server and deletes what the platform marked disposable rather than leaving a
 * daemon nobody asked for.
 *
 * Two launchers using the same Clio state root share one host per project.
 * A launch reattaches only to a Clio whose own launcher is gone, which is a
 * workspace the operator detached from. While another terminal still holds
 * that Clio, a second launch never joins it: it falls back to the plain
 * terminal, where Clio starts its own session (#420). Everything that changes the session's shape, which is
 * starting the server, creating a workspace, closing one and stopping the
 * server, happens under one cross-process lock keyed by the session. A launcher that finds the session empty and stops it
 * cannot do so between another launcher's server check and its workspace.
 *
 * Leaving is a handshake rather than a pane closing. herdr replaces the last
 * workspace with a fresh one the moment it closes under an attached client, so
 * "the session is empty" never becomes true while the operator is looking at
 * it. Instead the Clio in the pane drops a marker when it quits cleanly
 * (`markWorkspaceExit`), and the launcher detaches its client. When this is
 * the last workspace it stops the server directly, so a delayed co-attached
 * client cannot trigger a replacement; otherwise it closes only this workspace. A Clio
 * that crashed records its exit status too, so its utility panes cannot outlive it. The
 * marker carries the exit summary Clio printed in its pane, and the launcher
 * prints it in the operator's terminal once the host is gone, so the summary
 * and its `/resume <id>` line outlive the pane. And every failure before the terminal is handed
 * over returns `fallback`, which the caller answers by booting Clio in the
 * plain terminal, because a pane host that will not start must never be the
 * reason Clio does not.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import type { OutputStyle } from "../../../core/defaults.js";
import { processBirthToken, processIdentityAlive } from "../../../core/process-identity.js";
import { withStateFileLock } from "../../../core/state-file-lock.js";
import { clioStateDir } from "../../../core/xdg.js";
import { MUX_MIN_PROTOCOL } from "../protocol.js";
import type { MuxClient } from "../socket-client.js";
import { createMuxClient } from "../socket-client.js";
import type { MuxLog, MuxPane, MuxServerInfo } from "../types.js";
import { writeWorkspaceConfig } from "./config.js";
import {
	exitMarkerPath,
	exitMarkerStem,
	markWorkspaceExit,
	readWorkspaceExitResult,
	WORKSPACE_SESSION_PREFIX,
	workspaceSessionFor,
} from "./exit-marker.js";
import { type HostLayout, type MuxHostPlatform, muxHostPlatform } from "./platform.js";

/** How long a freshly spawned server gets to answer its first ping. */
const SERVER_START_TIMEOUT_MS = 8_000;
/** How long a server told to stop gets to let go of its socket. */
const SERVER_STOP_TIMEOUT_MS = 5_000;
const SERVER_POLL_MS = 100;
/** The agent name Clio reports for its own pane (src/domains/mux/contract.ts). */
const CLIO_AGENT = "clio-coder";
const WORKSPACE_TOKEN = "clio_coder_workspace";
/** `<pid>:<birth token>` of the launcher whose terminal shows this Clio. */
const LAUNCHER_TOKEN = "clio_coder_launcher";
const WORKSPACE_METADATA_SOURCE = "clio-coder:workspace";
const WORKSPACE_NONCE = /^[0-9a-f-]{36}$/u;
const EXIT_POLL_MS = 200;
/** Every this many exit polls, also ask whether the workspace still exists. */
const WORKSPACE_CHECK_EVERY = 5;

export interface WorkspaceLaunchOptions {
	/** Absolute path of Clio's vendored herdr pin. */
	herdrPath: string;
	/** That binary's version when it could be read; a running server must match it to be reused. */
	herdrVersion: string | null;
	/** True when this launch runs inside another herdr, so the host takes the nested prefix. */
	nested: boolean;
	/** Clio's output style, which decides the host's pane chrome. */
	outputStyle: OutputStyle;
	/** Platform seam override for tests. */
	platform?: MuxHostPlatform;
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
	/**
	 * The terminal was handed to the workspace and has come back. `exitSummary`
	 * is the summary the Clio in the pane printed on a clean quit, for the
	 * caller to print in the operator's terminal now that the pane is gone.
	 */
	| { status: "closed"; exitCode: number; workspaceLeftRunning: boolean; exitSummary: string | null }
	/** Nothing was handed over; boot Clio in this terminal instead. */
	| { status: "fallback"; reason: string };

/**
 * The environment herdr's own processes run under: the caller's, minus any
 * herdr coordinates it inherited, plus the platform layout's. Stripping matters
 * because an inherited `HERDR_SOCKET_PATH` would send every command below to
 * the operator's own host, and an inherited `HERDR_ENV` would make herdr refuse
 * to start nested inside it.
 */
function workspaceHostEnv(env: NodeJS.ProcessEnv, layout: HostLayout): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(env)) {
		if (!key.startsWith("HERDR_")) out[key] = value;
	}
	return { ...out, ...layout.hostEnv };
}

/**
 * The lifecycle lock's target. It sits outside every directory the platform
 * may delete with the host, because a lock that can vanish under its holder
 * serializes nothing.
 */
function workspaceLockTarget(session: string): string {
	return join(clioStateDir(), "mux", "locks", session.slice(WORKSPACE_SESSION_PREFIX.length));
}

/** The sidebar label for a project: its directory name. */
function workspaceLabel(cwd: string): string {
	return basename(cwd) || cwd;
}

/**
 * Everything one launch knows about where it runs, computed once from the
 * project directory and carried through every step, so the server that is
 * started, the socket that is pinged, the client that attaches, the lock and
 * the exit marker can never disagree about which session they mean.
 */
interface Host {
	options: WorkspaceLaunchOptions;
	platform: MuxHostPlatform;
	layout: HostLayout;
	hostEnv: NodeJS.ProcessEnv;
	/** The session name, keyed by canonical Clio state root and project directory. */
	session: string;
	/** The project directory with every symlink resolved. */
	cwd: string;
	socketPath: string;
	log: MuxLog;
}

/**
 * Lay the host out and write its config. Call under the session lock: a
 * launcher stopping an empty host deletes the platform's disposable
 * directories, and this must not run between that and the server start.
 */
function resolveHost(
	options: WorkspaceLaunchOptions,
	identity: { session: string; cwd: string },
	platform: MuxHostPlatform,
): Host {
	const env = options.env ?? process.env;
	const layout = platform.hostLayout({ session: identity.session, env });
	writeWorkspaceConfig(layout.configPath, {
		shell: layout.shell,
		nested: options.nested,
		outputStyle: options.outputStyle,
	});
	return {
		options,
		platform,
		layout,
		hostEnv: workspaceHostEnv(env, layout),
		session: identity.session,
		cwd: identity.cwd,
		socketPath: layout.socketPath,
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
		if (mismatch === null) {
			// The config was just rewritten for this launch (prefix, chrome); a
			// host that refuses to reload keeps its previous look, which is harmless.
			await running.client.serverReloadConfig().catch(() => undefined);
			return { client: running.client, started: false };
		}
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

	// No server is running, so whatever an earlier one saved is dead panes.
	rmSync(host.layout.sessionFile, { force: true });
	const hadSocket = existsSync(host.socketPath);
	const server = spawn(host.options.herdrPath, [...host.layout.herdrArgs, "server"], {
		cwd: host.cwd,
		env: host.hostEnv,
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	});
	let exited = false;
	const serverExited = new Promise<void>((resolve) => {
		server.once("exit", () => {
			exited = true;
			resolve();
		});
		server.once("error", () => {
			exited = true;
			resolve();
		});
	});
	server.unref();

	const deadline = performance.now() + SERVER_START_TIMEOUT_MS;
	while (performance.now() < deadline && !exited) {
		await sleep(SERVER_POLL_MS);
		const started = await pingOnce(host);
		if (started !== null) return { client: started.client, started: true };
	}
	if (!exited) {
		// This child has not been handed over to any workspace. Reap it before
		// releasing the lifecycle lock, or it can become ready behind plain Clio.
		const signal = (name: NodeJS.Signals): void => {
			try {
				if (process.platform !== "win32" && server.pid !== undefined) process.kill(-server.pid, name);
				else server.kill(name);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
			}
		};
		server.ref();
		signal("SIGTERM");
		await Promise.race([serverExited, sleep(1_000, undefined, { ref: false })]);
		if (!exited) signal("SIGKILL");
		await serverExited;
	}
	if (!hadSocket) {
		rmSync(host.socketPath, { force: true });
		cleanupHostFiles(host);
	}
	return { refused: `the pane host did not start (${host.options.herdrPath})` };
}

/**
 * A live Clio already running in this project's session. A pane whose exit
 * marker exists is a Clio that has quit and whose agent record the host has
 * not cleared yet, not a running one.
 */
async function findRunningClio(host: Host, client: MuxClient): Promise<MuxPane | null> {
	for (const workspace of await client.workspaceList()) {
		const panes = await client.paneList(workspace.workspaceId);
		const clio = panes.find(
			(pane) =>
				(pane.agent === CLIO_AGENT || WORKSPACE_NONCE.test(pane.tokens[WORKSPACE_TOKEN] ?? "")) &&
				pane.cwd === host.cwd &&
				!existsSync(exitMarkerPath(host.socketPath, pane.paneId)),
		);
		if (clio) return clio;
	}
	return null;
}

function runHerdr(host: Host, args: ReadonlyArray<string>): boolean {
	const result = spawnSync(host.options.herdrPath, [...host.layout.herdrArgs, ...args], {
		cwd: host.cwd,
		env: host.hostEnv,
		stdio: "ignore",
		timeout: 10_000,
		windowsHide: true,
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
	return stopServerAndClean(host, client);
}

async function stopServerAndClean(host: Host, client: MuxClient): Promise<boolean> {
	if (!(await stopServer(host, client))) return false;
	// With the server gone its pane ids start over, so every marker is stale.
	const stem = basename(exitMarkerStem(host.socketPath));
	try {
		for (const name of readdirSync(dirname(host.socketPath))) {
			if (name.startsWith(stem)) rmSync(join(dirname(host.socketPath), name), { force: true });
		}
	} catch {
		// A marker left behind is cleared by the next Clio in that pane.
	}
	cleanupHostFiles(host);
	return true;
}

function cleanupHostFiles(host: Host): void {
	// One host per project would otherwise leave one stopped host behind for
	// every directory Clio was ever run in. It holds nothing, it is Clio's own
	// by name, and the lock that guards this lives outside it.
	for (const dir of host.layout.disposableDirs) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch (error) {
			host.log("debug", `pane host cleanup skipped ${dir}: ${messageOf(error)}`);
		}
	}
	if (host.layout.cleanupArgs !== null) {
		spawnSync(host.options.herdrPath, [...host.layout.herdrArgs, ...host.layout.cleanupArgs], {
			cwd: host.cwd,
			env: host.hostEnv,
			stdio: "ignore",
			timeout: 10_000,
			windowsHide: true,
		});
	}
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

/**
 * The pid of another live launcher whose terminal shows this pane, or null
 * when nobody holds it (the operator detached) or the pane never recorded one.
 */
function heldByLauncher(pane: MuxPane): number | null {
	const match = /^(\d+):(.*)$/u.exec(pane.tokens[LAUNCHER_TOKEN] ?? "");
	if (match === null) return null;
	const pid = Number(match[1]);
	const alive = processIdentityAlive({ host: hostname(), pid, birthToken: match[2] || null });
	return alive === true ? pid : null;
}

/** Tag the workspace once and record this launcher as the terminal that shows it. */
async function tagWorkspace(client: MuxClient, pane: MuxPane): Promise<string> {
	const existing = pane.tokens[WORKSPACE_TOKEN];
	const nonce = existing !== undefined && WORKSPACE_NONCE.test(existing) ? existing : randomUUID();
	await client.paneReportMetadata({
		paneId: pane.paneId,
		source: WORKSPACE_METADATA_SOURCE,
		tokens: { [WORKSPACE_TOKEN]: nonce, [LAUNCHER_TOKEN]: `${process.pid}:${processBirthToken() ?? ""}` },
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
			// Another terminal still shows that Clio. Joining it would share one
			// conversation and steering queue between two terminals (#420).
			const holder = heldByLauncher(running);
			if (holder !== null) {
				await client.close();
				return {
					refused: `this folder's pane host is in use by another terminal, pid ${holder}, so this terminal starts its own session`,
				};
			}
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
		const launch = host.platform.paneLaunch(host.options.clioArgv);
		const paneEnv = { ...host.options.clioEnv, ...launch.env };
		const created = await client.workspaceCreate({
			cwd: host.cwd,
			label: workspaceLabel(host.cwd),
			focus: true,
			...(Object.keys(paneEnv).length > 0 ? { env: paneEnv } : {}),
		});
		const clioPane = created.rootPane;
		createdWorkspaceId = created.workspace.workspaceId;
		// Tag before starting Clio: another launcher must see the pending child even before its first self-report.
		const workspaceNonce = await tagWorkspace(client, clioPane);
		// This pane id is new in this server's life, so nobody can be waiting on
		// its marker; one left by an earlier server would end the launch at once.
		rmSync(exitMarkerPath(host.socketPath, clioPane.paneId), { force: true });
		await client.tabRename(clioPane.tabId, "clio").catch(() => undefined);
		// `pane run` is herdr's own "type this and press enter", so the launcher
		// inherits whatever shell-readiness handling the installed release has.
		if (!runHerdr(host, ["pane", "run", clioPane.paneId, launch.line])) {
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
	const platform = options.platform ?? muxHostPlatform();
	let identity: { session: string; cwd: string };
	let lockTarget: string;
	try {
		identity = workspaceSessionFor(options.cwd);
		lockTarget = workspaceLockTarget(identity.session);
	} catch (error) {
		return { status: "fallback", reason: `could not prepare the workspace: ${messageOf(error)}` };
	}

	let host: Host | null = null;
	let opened: Opened;
	try {
		opened = await withStateFileLock(lockTarget, async (): Promise<Opened> => {
			try {
				host = resolveHost(options, identity, platform);
			} catch (error) {
				return { refused: `could not prepare the workspace: ${messageOf(error)}` };
			}
			return openWorkspace(host);
		});
	} catch (error) {
		return { status: "fallback", reason: `could not take the workspace session lock: ${messageOf(error)}` };
	}
	if ("refused" in opened || host === null) {
		return { status: "fallback", reason: "refused" in opened ? opened.refused : "could not prepare the workspace" };
	}
	return attachWorkspace(host, opened, lockTarget);
}

/** Hand the terminal to herdr's client, wait for the operator to leave, and clean up. */
async function attachWorkspace(
	host: Host,
	opened: Exclude<Opened, { refused: string }>,
	lockTarget: string,
): Promise<WorkspaceLaunchResult> {
	const options = host.options;
	const { client, clioPane, workspaceId } = opened;
	const marker = exitMarkerPath(host.socketPath, clioPane.paneId);

	// From here the terminal belongs to herdr's client until it exits.
	const attach = spawn(options.herdrPath, [...host.layout.herdrArgs], {
		cwd: host.cwd,
		env: host.hostEnv,
		stdio: "inherit",
		windowsHide: true,
	});

	// Two reasons to hang up for the operator: this pane's Clio quit, or another
	// launcher on the same workspace saw that first and has closed it.
	let clioQuit = false;
	let workspaceGone = false;
	let ticks = 0;
	let asking = false;
	let signalExitCode: number | null = null;
	const poll = setInterval(() => {
		if (existsSync(marker)) {
			clioQuit = true;
			clearInterval(poll);
			host.platform.detach(attach);
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
				host.platform.detach(attach);
			},
			() => {
				// An unanswered question is not an answer; ask again next time.
				asking = false;
			},
		);
	}, EXIT_POLL_MS);

	// The client owns the terminal, so Ctrl+C belongs to the pane it is typed in.
	const ignore = (): void => undefined;
	let termination: Promise<void> | null = null;
	// A hangup is the operator's terminal closing. Without a handler Node dies on
	// it and leaves the detached host and the Clio in its pane running unseen, so
	// it ends this launch's Clio exactly as SIGTERM does, the way a Clio booted in
	// the plain terminal ends on the same hangup.
	const terminate = (signal: NodeJS.Signals): void => {
		const code = signal === "SIGHUP" ? 129 : 143;
		signalExitCode = code;
		clearInterval(poll);
		termination ??= (async () => {
			// A reattached launcher owns its client, not the earlier launch's workspace.
			if (opened.createdWorkspace) {
				try {
					if (await stillOwnsWorkspace(client, opened)) {
						clioQuit = true;
						if (!existsSync(marker)) {
							markWorkspaceExit(
								{
									HERDR_ENV: "1",
									HERDR_SOCKET_PATH: host.socketPath,
									HERDR_PANE_ID: clioPane.paneId,
								},
								code,
							);
						}
					}
				} catch (error) {
					host.log("debug", `workspace termination could not verify ownership: ${messageOf(error)}`);
				}
			}
			host.platform.detach(attach);
		})();
	};
	process.on("SIGINT", ignore);
	process.on("SIGTERM", terminate);
	process.on("SIGHUP", terminate);
	const exit = await new Promise<{ code: number } | { spawnError: Error }>((resolve) => {
		attach.once("error", (error) => resolve({ spawnError: error }));
		attach.once("exit", (code) => resolve({ code: code ?? 0 }));
	});
	await termination;
	process.off("SIGINT", ignore);
	clearInterval(poll);
	host.platform.afterClientExit();

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
		process.off("SIGTERM", terminate);
		process.off("SIGHUP", terminate);
		return { status: "fallback", reason: `the pane host client did not start: ${exit.spawnError.message}` };
	}
	const exitCode = signalExitCode ?? exit.code;

	// Read before the workspace and its marker are cleaned up below.
	const markedExit = clioQuit ? readWorkspaceExitResult(marker) : null;
	const exitSummary = markedExit?.summary ?? null;
	let workspaceLeftRunning = true;
	try {
		workspaceLeftRunning = await withStateFileLock(lockTarget, async () => {
			// A co-attached launcher may already have removed our workspace and a new server may reuse its ids.
			if (!(await stillOwnsWorkspace(client, opened))) return false;
			if (clioQuit) {
				// Closing the last workspace under any attached client creates a
				// replacement. Stop the host instead: delayed co-attached clients
				// cannot race this into an unowned replacement shell.
				const workspaces = await client.workspaceList();
				if (workspaces.length === 1 && workspaces[0]?.workspaceId === workspaceId) {
					return !(await stopServerAndClean(host, client));
				}
				// Another workspace keeps this host alive; close only the one whose
				// nonce we verified, leaving every unrelated workspace untouched.
				try {
					await client.workspaceClose(workspaceId);
					rmSync(marker, { force: true });
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
	process.off("SIGTERM", terminate);
	process.off("SIGHUP", terminate);
	// A hangup the launcher sent is the clean way out, not a failure to report.
	return {
		status: "closed",
		exitCode: signalExitCode ?? markedExit?.exitCode ?? (clioQuit || workspaceGone ? 0 : exitCode),
		workspaceLeftRunning,
		exitSummary,
	};
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
