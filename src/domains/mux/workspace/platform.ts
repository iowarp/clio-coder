import type { ChildProcess } from "node:child_process";
import { basename, dirname } from "node:path";
import { posixHostPlatform } from "./platform-posix.js";
import { win32HostPlatform } from "./platform-win32.js";

/**
 * What differs between operating systems when Clio hosts its own panes.
 *
 * The launcher (launch.ts) is one code path. Everything that has to be done
 * differently on Windows, where there is no exec, no SIGHUP and no Unix socket,
 * sits behind this interface so the launcher never branches on the platform.
 */

/** The `[terminal]` settings the managed herdr config writes for every pane. */
export interface PaneShellSettings {
	/** Executable herdr runs as each pane's shell, or null to leave herdr's own default. */
	defaultShell: string | null;
	shellMode: "login" | "non_login";
}

export interface HostLayoutInput {
	/** `clio-coder-<hash12>`, from `workspaceSessionFor`. */
	session: string;
	/** The caller's environment, herdr coordinates included; the platform strips what it must. */
	env: NodeJS.ProcessEnv;
}

/**
 * Where one project's private pane host lives and how herdr is started for it.
 * Computed once per launch; every path the launcher, the server, the client and
 * the pane agree on comes from here.
 */
export interface HostLayout {
	/** The API socket every client and pane uses (`HERDR_SOCKET_PATH`). On Windows a marker file naming the pipe. */
	socketPath: string;
	/** Global herdr arguments placed before every subcommand, e.g. `["--session", name]`. */
	herdrArgs: string[];
	/** Variables set on every herdr process Clio starts (private XDG roots, shim inputs, the config path). */
	hostEnv: Record<string, string>;
	/** Where the managed config.toml is written. */
	configPath: string;
	/** The `[terminal]` block of the managed config. */
	shell: PaneShellSettings;
	/**
	 * The session snapshot herdr restores from whenever its server starts. Clio's
	 * host never restores one: the panes in it died with the old server, and a
	 * workspace no launcher owns would hold the server open for good.
	 */
	sessionFile: string;
	/** Directories deleted once the host has been stopped because it held nothing. */
	disposableDirs: string[];
	/** A herdr subcommand run after the host stopped empty, e.g. `["session", "delete", name]`. */
	cleanupArgs: string[] | null;
}

export interface MuxHostPlatform {
	/** Compute the layout and create, idempotently, whatever must exist before the server starts (dirs, shim). */
	hostLayout(input: HostLayoutInput): HostLayout;
	/**
	 * How the Clio pane's shell starts `argv`: variables for the pane's environment and the line typed at its
	 * prompt. The pane runs the operator's own shell, so the line must stay out of their history or do nothing there.
	 */
	paneLaunch(argv: ReadonlyArray<string>): { env: Record<string, string>; line: string };
	/** Make the attached herdr client let go of the terminal. */
	detach(attach: ChildProcess): void;
	/** Put the terminal back after the client exited, when the platform's detach could not. */
	afterClientExit(): void;
}

export function muxHostPlatform(platform: NodeJS.Platform = process.platform): MuxHostPlatform {
	return platform === "win32" ? win32HostPlatform : posixHostPlatform;
}

const HOST_HASH = /^clio-coder-[0-9a-f]{12}$/u;

/**
 * True when a herdr socket path is one of Clio's private hosts, on either
 * layout: POSIX `<runtime>/clio-coder-<hash>.sock`, Windows
 * `<herdr config>/sessions/clio-coder-<hash>/herdr.sock`. Both separators are
 * accepted so a Windows path is recognised from tests on any host.
 */
export function isClioHostSocket(socketPath: string | undefined): boolean {
	if (!socketPath) return false;
	const normalized = socketPath.replace(/\\/gu, "/");
	const name = basename(normalized);
	if (name.endsWith(".sock") && HOST_HASH.test(name.slice(0, -".sock".length))) return true;
	return name === "herdr.sock" && HOST_HASH.test(basename(dirname(normalized)));
}
