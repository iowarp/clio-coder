/**
 * The Linux and macOS layout of Clio's private pane host.
 *
 * Isolation is the point. herdr keeps its session file, its log and its
 * default socket under `$XDG_CONFIG_HOME/herdr` and its state under
 * `$XDG_STATE_HOME/herdr`, with no switch to turn the session file off. So the
 * server Clio starts runs with both roots pointed at a private directory of
 * Clio's own, one per project, and with an explicit socket in an owner-only
 * runtime directory. The operator's own `herdr`, their sessions and their
 * `herdr session list` never see it.
 *
 * Every pane inherits the server's environment, and herdr cannot unset a
 * variable per pane, so the private XDG roots would leak into every shell and
 * break whatever the operator runs there (their editor reading its config from
 * the wrong place). The pane shell is therefore a small shim: it puts the
 * operator's XDG roots back, unsetting them when they were unset, and execs
 * their shell. herdr's own login mode cannot survive a shim (it passes login
 * intent as argv0), so the shim asks for a login shell itself on macOS, whose
 * terminals start login shells, and not on Linux, whose terminals do not.
 */

import type { ChildProcess } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { shellQuote } from "../../../core/shell-quote.js";
import { clioStateDir } from "../../../core/xdg.js";
import type { HostLayout, MuxHostPlatform } from "./platform.js";

/**
 * Unix socket paths are limited to 104 bytes on macOS and 108 on Linux. herdr
 * puts its client socket beside the API socket with a longer name, so the
 * budget is checked against that one, with a few bytes of slack.
 */
const SOCKET_PATH_BUDGET = 100;
/** Variables the shim reads to hand the operator's shell their own XDG roots back. */
const SHIM_SAVED_XDG = ["XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const;
const SHIM_PREFIX = "CLIO_CODER_PANE_";
/** Shells the macOS shim starts as login shells: the ones that accept `-l`. */
const LOGIN_FLAG_SHELLS = "sh|bash|zsh|ksh|dash|ash|mksh|fish|csh|tcsh";

export interface PosixHostOptions {
	platform?: NodeJS.Platform;
	uid?: number;
	/** Clio's state root; the private host roots live under `<state>/mux/<hash>`. */
	stateDir?: () => string;
}

/**
 * Runtime directories to try, most preferred first; a candidate that would
 * make the socket path too long is skipped, and one that cannot be made
 * private is passed over when the host is laid out. Linux uses the session's
 * `XDG_RUNTIME_DIR`, then a uid-named directory in the operator's `TMPDIR`;
 * macOS uses its per-user `TMPDIR`. Both end at a uid-named directory in /tmp.
 */
export function posixRuntimeDirCandidates(
	env: NodeJS.ProcessEnv,
	session: string,
	platform: NodeJS.Platform,
	uid: number,
): string[] {
	const fits = (dir: string): boolean => Buffer.byteLength(join(dir, `${session}-client.sock`)) <= SOCKET_PATH_BUDGET;
	const preferred: string[] = [];
	if (platform === "darwin") {
		if (env.TMPDIR?.startsWith("/")) preferred.push(join(env.TMPDIR, "clio-coder"));
	} else {
		if (env.XDG_RUNTIME_DIR?.startsWith("/")) preferred.push(join(env.XDG_RUNTIME_DIR, "clio-coder"));
		// TMPDIR may be shared between users, so the directory carries the uid.
		if (env.TMPDIR?.startsWith("/")) preferred.push(join(env.TMPDIR, `clio-coder-${uid}`));
	}
	const fallback = `/tmp/clio-coder-${uid}`;
	return [...new Set([...preferred.filter(fits), fallback])];
}

/**
 * Create, or accept, an owner-only directory. A symlink, a non-directory or a
 * directory somebody else owns is refused: the socket and the exit markers in
 * it are how the launcher knows which Clio it is talking to.
 */
function ensurePrivateDir(dir: string, uid: number): void {
	try {
		mkdirSync(dir, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const stat = lstatSync(dir);
	if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${dir} is not a directory`);
	if (stat.uid !== uid) throw new Error(`${dir} belongs to uid ${stat.uid}, not ${uid}`);
	if ((stat.mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

function runtimeDir(env: NodeJS.ProcessEnv, session: string, platform: NodeJS.Platform, uid: number): string {
	const failures: string[] = [];
	for (const candidate of posixRuntimeDirCandidates(env, session, platform, uid)) {
		try {
			ensurePrivateDir(candidate, uid);
			return candidate;
		} catch (error) {
			failures.push(error instanceof Error ? error.message : String(error));
		}
	}
	throw new Error(`no usable runtime directory for the pane host (${failures.join("; ")})`);
}

/** The pane shell shim, as text. */
export function renderPosixShellShim(platform: NodeJS.Platform): string {
	const restore = SHIM_SAVED_XDG.map(
		(name) =>
			`if [ -n "\${${SHIM_PREFIX}${name}+x}" ]; then ${name}=$${SHIM_PREFIX}${name}; export ${name}; else unset ${name}; fi`,
	);
	const exec =
		platform === "darwin"
			? [`case "\${shell##*/}" in`, `${LOGIN_FLAG_SHELLS}) exec "$shell" -l ;;`, "esac", 'exec "$shell"']
			: ['exec "$shell"'];
	return [
		"#!/bin/sh",
		"# Written by Clio Coder for its private pane host. Every pane starts here:",
		"# the operator's own XDG roots go back in place and their shell takes over.",
		...restore,
		`unset ${SHIM_SAVED_XDG.map((name) => `${SHIM_PREFIX}${name}`).join(" ")}`,
		// biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion
		"shell=${SHELL:-/bin/sh}",
		'case "$shell" in',
		'/*) [ -x "$shell" ] || shell=/bin/sh ;;',
		"*) shell=/bin/sh ;;",
		"esac",
		...exec,
		"",
	].join("\n");
}

/** Write only when the content changed, so a running pane never sees its shell replaced mid-read. */
function writeIfChanged(path: string, content: string, mode: number): void {
	let current: string | null = null;
	try {
		current = readFileSync(path, "utf8");
	} catch {
		current = null;
	}
	if (current !== content) writeFileSync(path, content, { mode });
	chmodSync(path, mode);
}

/** The private host root for a session: `<state>/mux/<hash>`. */
function posixHostRoot(stateDir: string, session: string): string {
	return join(stateDir, "mux", session.replace(/^clio-coder-/u, ""));
}

/**
 * The socket of a root's host. The root is keyed by project alone while the
 * runtime directory comes from the environment, so a launch with another
 * `XDG_RUNTIME_DIR` or `TMPDIR` would start a second server on the same root,
 * and the first to stop would delete the other's shim and config. The root
 * records its socket, and later launches reuse it while the socket exists.
 */
function hostSocketPath(
	root: string,
	env: NodeJS.ProcessEnv,
	session: string,
	platform: NodeJS.Platform,
	owner: number,
): string {
	const record = join(root, "socket-path");
	try {
		const recorded = readFileSync(record, "utf8").trim();
		if (isAbsolute(recorded) && basename(recorded) === `${session}.sock` && lstatSync(recorded).isSocket()) {
			ensurePrivateDir(dirname(recorded), owner);
			return recorded;
		}
	} catch {
		// No record, or its socket is gone: choose afresh.
	}
	const socketPath = join(runtimeDir(env, session, platform, owner), `${session}.sock`);
	writeIfChanged(record, `${socketPath}\n`, 0o600);
	return socketPath;
}

/** Keep DDS sockets short enough for Unix, beside this host's socket but never shared with another host. */
export function posixHostRuntimeDir(socketPath: string): string {
	return join(dirname(socketPath), basename(socketPath, ".sock").replace(/^clio-coder-/u, ""));
}

export function createPosixHostPlatform(options: PosixHostOptions = {}): MuxHostPlatform {
	const platform = options.platform ?? process.platform;
	const uid = (): number => options.uid ?? process.getuid?.() ?? 0;
	const stateDir = options.stateDir ?? clioStateDir;
	return {
		hostLayout({ session, env }): HostLayout {
			const owner = uid();
			const root = posixHostRoot(stateDir(), session);
			mkdirSync(join(stateDir(), "mux"), { recursive: true, mode: 0o700 });
			ensurePrivateDir(root, owner);
			const socketPath = hostSocketPath(root, env, session, platform, owner);
			const privateRuntime = posixHostRuntimeDir(socketPath);
			ensurePrivateDir(privateRuntime, owner);
			const configHome = join(root, "config");
			const stateHome = join(root, "state");
			mkdirSync(join(configHome, "herdr"), { recursive: true, mode: 0o700 });
			mkdirSync(stateHome, { recursive: true, mode: 0o700 });
			const shim = join(root, "pane-shell");
			writeIfChanged(shim, renderPosixShellShim(platform), 0o755);

			const hostEnv: Record<string, string> = {
				XDG_CONFIG_HOME: configHome,
				XDG_STATE_HOME: stateHome,
				HERDR_SOCKET_PATH: socketPath,
			};
			for (const name of SHIM_SAVED_XDG) {
				const value = env[name];
				if (typeof value === "string" && value.length > 0) hostEnv[`${SHIM_PREFIX}${name}`] = value;
			}
			return {
				socketPath,
				herdrArgs: [],
				hostEnv,
				configPath: join(configHome, "herdr", "config.toml"),
				shell: { defaultShell: shim, shellMode: "non_login" },
				sessionFile: join(configHome, "herdr", "session.json"),
				disposableDirs: [root, privateRuntime],
				cleanupArgs: null,
			};
		},
		paneLaunch(argv) {
			const words = argv.map((word) => (/^[A-Za-z0-9_@%+=:,./-]+$/u.test(word) ? word : shellQuote(word)));
			// fish never records a line that starts with a space; bash and zsh skip it under ignorespace.
			return { env: {}, line: ` ${words.join(" ")}` };
		},
		detach(attach: ChildProcess) {
			// herdr's client treats a hangup as the terminal going away and detaches cleanly.
			if (attach.exitCode === null && !attach.killed) attach.kill("SIGHUP");
		},
		afterClientExit() {},
	};
}

export const posixHostPlatform: MuxHostPlatform = createPosixHostPlatform();
