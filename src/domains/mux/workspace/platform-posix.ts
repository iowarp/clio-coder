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
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { safeResourceWrite } from "../../../core/safe-resource-write.js";
import { shellQuote } from "../../../core/shell-quote.js";
import { clioCacheDir, clioStateDir } from "../../../core/xdg.js";
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
	/** Clio's cache root, the last fallback for the runtime directory before /tmp. */
	cacheDir?: () => string;
}

/** A preferred runtime directory left out because herdr's client socket in it would not fit a Unix socket path. */
export interface TooLongRuntimeDir {
	dir: string;
	/** The longest socket herdr would create there. */
	socketPath: string;
	bytes: number;
	/** The variable the directory came from, and the longest value of it that would fit; absent for Clio's own roots. */
	variable?: { name: "XDG_RUNTIME_DIR" | "TMPDIR"; maxBytes: number };
}

/**
 * Runtime directories to try, most preferred first; a candidate that would
 * make the socket path too long is skipped, and one that cannot be made
 * private and writable is passed over when the host is laid out. Linux uses
 * the session's `XDG_RUNTIME_DIR`, then a uid-named directory in the operator's
 * `TMPDIR`; macOS uses its per-user `TMPDIR`. Both then try `<state>/mux/run`
 * and `<cache>/run`, which a launcher's write fence leaves writable when it
 * makes `/run/user/<uid>` read-only, and end at the short directories of
 * {@link shortRuntimeDirs}.
 */
export function posixRuntimeDirCandidates(
	env: NodeJS.ProcessEnv,
	session: string,
	platform: NodeJS.Platform,
	uid: number,
	clioRoots: { state?: string; cache?: string } = {},
): string[] {
	return posixRuntimeDirPlan(env, session, platform, uid, clioRoots).candidates;
}

/** The candidates, and the preferred directories skipped because the socket path would be too long. */
export function posixRuntimeDirPlan(
	env: NodeJS.ProcessEnv,
	session: string,
	platform: NodeJS.Platform,
	uid: number,
	clioRoots: { state?: string; cache?: string } = {},
): { candidates: string[]; tooLong: TooLongRuntimeDir[] } {
	const preferred: Array<{ dir: string; from?: { name: "XDG_RUNTIME_DIR" | "TMPDIR"; value: string } }> = [];
	const fromEnv = (name: "XDG_RUNTIME_DIR" | "TMPDIR", leaf: string): void => {
		const value = env[name];
		if (value?.startsWith("/")) preferred.push({ dir: join(value, leaf), from: { name, value } });
	};
	if (platform === "darwin") fromEnv("TMPDIR", "clio-coder");
	else {
		fromEnv("XDG_RUNTIME_DIR", "clio-coder");
		// TMPDIR may be shared between users, so the directory carries the uid.
		fromEnv("TMPDIR", `clio-coder-${uid}`);
	}
	if (clioRoots.state !== undefined) preferred.push({ dir: join(clioRoots.state, "mux", "run") });
	if (clioRoots.cache !== undefined) preferred.push({ dir: join(clioRoots.cache, "run") });
	const fitting: string[] = [];
	const tooLong: TooLongRuntimeDir[] = [];
	for (const { dir, from } of preferred) {
		const socketPath = join(dir, `${session}-client.sock`);
		const bytes = Buffer.byteLength(socketPath);
		if (bytes <= SOCKET_PATH_BUDGET) fitting.push(dir);
		else if (!tooLong.some((entry) => entry.dir === dir)) {
			// The value's own trailing slash is not part of the joined path.
			const overhead = bytes - Buffer.byteLength(from?.value.replace(/\/+$/u, "") ?? "");
			tooLong.push({
				dir,
				socketPath,
				bytes,
				...(from !== undefined ? { variable: { name: from.name, maxBytes: SOCKET_PATH_BUDGET - overhead } } : {}),
			});
		}
	}
	return {
		candidates: [...new Set([...fitting, ...shortRuntimeDirs(env, session, platform, uid, clioRoots)])],
		tooLong,
	};
}

/**
 * Short directories tried after the preferred ones, for a launch whose own
 * roots are too long or fenced: the login session's `/run/user/<uid>` when it
 * exists (Linux; it is never created), then a short hashed directory in
 * `TMPDIR`, then one in /tmp. The hash is of the uid and Clio's state root, so
 * every Clio home gets its own directory and a shared `TMPDIR` keeps users apart.
 */
function shortRuntimeDirs(
	env: NodeJS.ProcessEnv,
	session: string,
	platform: NodeJS.Platform,
	uid: number,
	clioRoots: { state?: string },
): string[] {
	const hash = createHash("sha256")
		.update(`${uid}\0${clioRoots.state ?? ""}`)
		.digest("hex")
		.slice(0, 8);
	const dirs: string[] = [];
	if (platform !== "darwin") dirs.push(`/run/user/${uid}/clio-coder`);
	const tmp = env.TMPDIR?.replace(/\/+$/u, "");
	// Named as short as it can be: in a long TMPDIR every byte of the name counts.
	if (tmp?.startsWith("/")) dirs.push(join(tmp, `c-${hash}`));
	dirs.push(`/tmp/clio-${uid}-${hash}`);
	return dirs.filter((dir) => Buffer.byteLength(join(dir, `${session}-client.sock`)) <= SOCKET_PATH_BUDGET);
}

/**
 * Why no runtime directory worked, naming every directory skipped for length
 * and the fix: an integrator that roots each instance in a long path (a
 * desktop app's per-terminal home) leaves only /tmp, which its fence may deny.
 */
export function noRuntimeDirMessage(
	failures: ReadonlyArray<string>,
	tooLong: ReadonlyArray<TooLongRuntimeDir>,
	platform: NodeJS.Platform,
): string {
	const tried = failures.length > 0 ? ` (${failures.join("; ")})` : "";
	if (tooLong.length === 0) return `no usable runtime directory for the pane host${tried}`;
	const skipped = tooLong.map((entry) => `${entry.socketPath} is ${entry.bytes} bytes`).join("; ");
	const fixes = tooLong.flatMap((entry) =>
		entry.variable !== undefined ? [`${entry.variable.name} of at most ${entry.variable.maxBytes} bytes`] : [],
	);
	const fix =
		fixes.length > 0
			? `set a shorter ${fixes.join(" or ")}`
			: `set a short ${platform === "darwin" ? "TMPDIR" : "XDG_RUNTIME_DIR or TMPDIR"}`;
	return (
		`no usable runtime directory for the pane host${tried}; ` +
		`skipped as too long for a Unix socket path (limit ${SOCKET_PATH_BUDGET} bytes): ${skipped}; ` +
		`to fix, ${fix}`
	);
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

/**
 * A candidate is usable only if the host's own subdirectory can be made in it
 * and written. An existing `$XDG_RUNTIME_DIR/clio-coder` under a read-only
 * fence passes the private-directory check, then fails with EROFS on the
 * session's subdirectory, which used to drop the launch to the plain terminal.
 */
function ensureWritableRuntime(candidate: string, session: string, uid: number): void {
	ensurePrivateDir(candidate, uid);
	const own = posixHostRuntimeDir(join(candidate, `${session}.sock`));
	ensurePrivateDir(own, uid);
	const probe = join(own, `.probe-${process.pid}`);
	writeFileSync(probe, "", { flag: "w", mode: 0o600 });
	rmSync(probe, { force: true });
}

function runtimeDir(
	env: NodeJS.ProcessEnv,
	session: string,
	platform: NodeJS.Platform,
	uid: number,
	clioRoots: { state?: string; cache?: string },
): string {
	const failures: string[] = [];
	const plan = posixRuntimeDirPlan(env, session, platform, uid, clioRoots);
	for (const candidate of plan.candidates) {
		try {
			// Clio's own roots may not have the parent yet; system roots are never created.
			const underClio = [clioRoots.state, clioRoots.cache].some((r) => r !== undefined && candidate.startsWith(`${r}/`));
			if (underClio) mkdirSync(dirname(candidate), { recursive: true, mode: 0o700 });
			ensureWritableRuntime(candidate, session, uid);
			return candidate;
		} catch (error) {
			failures.push(error instanceof Error ? error.message : String(error));
		}
	}
	throw new Error(noRuntimeDirMessage(failures, plan.tooLong, platform));
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
	if (current !== content) safeResourceWrite(path, content, { mode });
	chmodSync(path, mode);
}

/** The private host root for a session: `<state>/mux/<hash>`. */
function posixHostRoot(stateDir: string, session: string): string {
	return join(stateDir, "mux", session.replace(/^clio-coder-/u, ""));
}

/**
 * The socket of a root's host. The root is keyed by project and Clio state root while the
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
	clioRoots: { state?: string; cache?: string },
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
	const socketPath = join(runtimeDir(env, session, platform, owner, clioRoots), `${session}.sock`);
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
	// An injected state root (tests, other homes) keeps the fallback inside that root unless a cache root is given too.
	const cacheDir = options.cacheDir ?? (options.stateDir ? undefined : clioCacheDir);
	return {
		hostLayout({ session, env }): HostLayout {
			const owner = uid();
			const root = posixHostRoot(stateDir(), session);
			mkdirSync(join(stateDir(), "mux"), { recursive: true, mode: 0o700 });
			ensurePrivateDir(root, owner);
			const clioRoots = { state: stateDir(), ...(cacheDir ? { cache: cacheDir() } : {}) };
			const socketPath = hostSocketPath(root, env, session, platform, owner, clioRoots);
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
