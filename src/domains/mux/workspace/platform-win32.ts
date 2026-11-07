/**
 * The Windows layout of Clio's private pane host.
 *
 * Windows has no exec, no SIGHUP and no Unix sockets, and herdr's PowerShell
 * integration (the prompt hook that reports the pane's directory, the shell
 * that comes back when an agent exits) only switches on when herdr picks the
 * pane shell itself. So nothing here redirects herdr's roots the way the POSIX
 * layout does: each project gets herdr's own named session, `clio-coder-<hash>`,
 * under herdr's config directory, and only the config file is Clio's, through
 * `HERDR_CONFIG_PATH`. herdr serves the session on a named pipe whose name is
 * the session's socket path, so that path has to be spelled exactly as herdr
 * spells it.
 *
 * The attached client cannot be asked to let go of the terminal: Node can only
 * terminate a Windows process, never send it a console control event. So
 * detaching kills the client and Clio puts the terminal back the way herdr's
 * own restore would have.
 */

import type { ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { clioStateDir } from "../../../core/xdg.js";
import type { HostLayout, MuxHostPlatform } from "./platform.js";

/**
 * Undo what herdr's client turns on, in the order its own restore does: the
 * keyboard, focus, paste and mouse reports, the pixel mouse and color-scheme
 * reports, the alternate screen, then a visible default cursor and Windows
 * Terminal's win32 input mode. The leading ST ends any sequence the client was
 * killed in the middle of writing.
 */
const TERMINAL_RESTORE = [
	"\x1b\\",
	"\x1b[0m",
	"\x1b[>4;0m",
	"\x1b[?7h",
	"\x1b[?1004l",
	"\x1b[?2004l",
	"\x1b[?1006l\x1b[?1015l\x1b[?1003l\x1b[?1002l\x1b[?1000l",
	"\x1b[?1016l",
	"\x1b[?2031l",
	"\x1b[?1049l",
	"\x1b[?25h\x1b[0 q",
	"\x1b[?9001l",
].join("");

interface RestoreStdin {
	isTTY?: boolean;
	setRawMode?(mode: boolean): unknown;
	pause(): unknown;
}

export interface Win32HostOptions {
	/** Clio's state root; the managed config lives under `<state>/mux/<hash>`. */
	stateDir?: () => string;
	stdout?: Pick<NodeJS.WriteStream, "write">;
	stdin?: () => RestoreStdin;
}

/**
 * Rust's `PathBuf::push` of a plain relative component on Windows: a separator
 * is added unless the base already ends in one or is a bare drive. herdr names
 * its pipe after the resulting string, so a normalizing join would name a
 * different pipe whenever the operator's variables carry a `/` or a trailing `\`.
 */
function pushPath(base: string, part: string): string {
	if (base === "" || base.endsWith("\\") || base.endsWith("/") || /^[A-Za-z]:$/u.test(base)) return `${base}${part}`;
	return `${base}\\${part}`;
}

/** herdr's `config_dir()` on Windows, from the environment its server runs under. */
function win32HerdrConfigDir(env: NodeJS.ProcessEnv): string {
	if (env.XDG_CONFIG_HOME !== undefined) return pushPath(env.XDG_CONFIG_HOME, "herdr");
	if (env.APPDATA !== undefined) return pushPath(env.APPDATA, "herdr");
	if (env.USERPROFILE !== undefined) {
		return pushPath(pushPath(pushPath(env.USERPROFILE, "AppData"), "Roaming"), "herdr");
	}
	if (env.HOME !== undefined) return pushPath(env.HOME, ".config/herdr");
	const temp = env.TMP ?? env.TEMP ?? env.USERPROFILE ?? env.SystemRoot ?? "C:\\Windows";
	return pushPath(temp.endsWith("\\") ? temp : `${temp}\\`, "herdr");
}

/** A PowerShell single-quoted literal. PowerShell also closes such a string on the typographic single quotes. */
function psLiteral(value: string): string {
	return `'${value.replace(/['\u2018\u2019\u201a\u201b]/gu, "$&$&")}'`;
}

/**
 * What PowerShell 5.1 (and 7 before 7.3, or with `Legacy` passing) must be
 * handed so the command line it builds parses back to `value`: it wraps an
 * argument holding whitespace in quotes, but escapes neither embedded quotes
 * nor the backslashes before its closing quote, and drops an empty argument.
 */
function legacyNativeArg(value: string): string {
	if (value === "") return '""';
	const quoted = /\s/u.test(value);
	let out = "";
	let backslashes = 0;
	for (const ch of value) {
		if (ch === "\\") {
			backslashes += 1;
			continue;
		}
		out += ch === '"' ? `${"\\".repeat(backslashes * 2 + 1)}"` : `${"\\".repeat(backslashes)}${ch}`;
		backslashes = 0;
	}
	return out + "\\".repeat(quoted ? backslashes * 2 : backslashes);
}

/** One argument to a native command, as PowerShell source that passes it unchanged on every PowerShell. */
function psNativeArg(value: string): string {
	const needsLegacy = value === "" || value.includes('"') || (/\s/u.test(value) && value.endsWith("\\"));
	if (!needsLegacy) return psLiteral(value);
	return `$(if ("$(Get-Variable PSNativeCommandArgumentPassing -ValueOnly -ErrorAction Ignore)" -in '', 'Legacy') { ${psLiteral(legacyNativeArg(value))} } else { ${psLiteral(value)} })`;
}

/** A Windows command line that `CommandLineToArgvW` and the C runtime split back into exactly `args`. */
function windowsCommandLine(args: ReadonlyArray<string>): string {
	return args
		.map((value) => {
			let out = '"';
			let backslashes = 0;
			for (const ch of value) {
				if (ch === "\\") {
					backslashes += 1;
					continue;
				}
				out += ch === '"' ? `${"\\".repeat(backslashes * 2 + 1)}"` : `${"\\".repeat(backslashes)}${ch}`;
				backslashes = 0;
			}
			return `${out}${"\\".repeat(backslashes * 2)}"`;
		})
		.join(" ");
}

/** The pane environment variable that carries a Windows utility pane's command. */
const PANE_RUN = "CLIO_CODER_PANE_RUN";

/**
 * How a PowerShell pane is made to run `argv` as its program. PSReadLine saves
 * every line typed at the prompt to the operator's history file, so the
 * command rides in the pane's environment and the typed line only invokes it:
 * recalled into any other shell, that line does nothing.
 *
 * PowerShell has no `exec`, so the script exits once the program does, which
 * closes the pane like `exec` would. `keepShell` leaves the prompt instead, as
 * the Clio pane does on every platform. A redirected stdout goes through
 * Start-Process: Windows PowerShell's `>` re-encodes the stream as UTF-16 and
 * only writes it once the program ends, while Start-Process hands the program
 * the file itself and leaves the console as its stdin and screen.
 */
export function win32PaneLaunch(
	argv: ReadonlyArray<string>,
	stdoutPath?: string,
	options: { keepShell?: boolean } = {},
): { env: Record<string, string>; line: string } | null {
	const [command, ...args] = argv;
	if (command === undefined) return null;
	let run: string;
	if (stdoutPath === undefined) {
		run = ["&", psLiteral(command), ...args.map(psNativeArg)].join(" ");
	} else {
		// -ArgumentList refuses an empty string, so a bare program omits it.
		const argumentList = args.length > 0 ? ` -ArgumentList ${psLiteral(windowsCommandLine(args))}` : "";
		run = `Start-Process -FilePath ${psLiteral(command)}${argumentList} -NoNewWindow -Wait -RedirectStandardOutput ${psLiteral(stdoutPath)}`;
	}
	return {
		env: {
			[PANE_RUN]: `Remove-Item Env:${PANE_RUN}; Clear-Host; ${options.keepShell ? run : `try { ${run} } finally { exit }`}`,
		},
		line: `if ($env:${PANE_RUN}) { iex $env:${PANE_RUN} }`,
	};
}

/**
 * `tail -n 200 -F path` for a Windows pane. Windows PowerShell reads a file
 * without a byte order mark in the ANSI code page, so the feed's UTF-8 is named.
 */
export function win32FollowArgv(powershell: string, path: string): string[] {
	return [
		powershell,
		"-NoLogo",
		"-NoProfile",
		"-Command",
		`Get-Content -LiteralPath ${psLiteral(path)} -Tail 200 -Wait -Encoding UTF8`,
	];
}

export function createWin32HostPlatform(options: Win32HostOptions = {}): MuxHostPlatform {
	const stateDir = options.stateDir ?? clioStateDir;
	let killedClient = false;
	return {
		hostLayout({ session, env }): HostLayout {
			const root = join(stateDir(), "mux", session.replace(/^clio-coder-/u, ""));
			mkdirSync(root, { recursive: true });
			const configPath = join(root, "config.toml");
			const sessionDir = pushPath(pushPath(win32HerdrConfigDir(env), "sessions"), session);
			return {
				socketPath: pushPath(sessionDir, "herdr.sock"),
				herdrArgs: ["--session", session],
				hostEnv: { HERDR_CONFIG_PATH: configPath },
				configPath,
				// herdr picks pwsh, then Windows PowerShell, and integrates with
				// either only when it chose the shell itself.
				shell: { defaultShell: null, shellMode: "non_login" },
				sessionFile: pushPath(sessionDir, "session.json"),
				disposableDirs: [root],
				cleanupArgs: ["session", "delete", session],
			};
		},
		paneLaunch(argv) {
			return win32PaneLaunch(argv, undefined, { keepShell: true }) ?? { env: {}, line: "" };
		},
		detach(attach: ChildProcess) {
			if (attach.exitCode !== null || attach.signalCode !== null) return;
			killedClient = true;
			attach.kill();
		},
		afterClientExit() {
			if (!killedClient) return;
			killedClient = false;
			(options.stdout ?? process.stdout).write(TERMINAL_RESTORE);
			const stdin = (options.stdin ?? (() => process.stdin))();
			if (stdin.isTTY && stdin.setRawMode) {
				// libuv sets a console input mode only when it changes, so going
				// raw first makes the return to cooked replace the killed
				// client's raw, VT and mouse input mode with the normal one.
				stdin.setRawMode(true);
				stdin.setRawMode(false);
			}
			stdin.pause();
		},
	};
}

export const win32HostPlatform: MuxHostPlatform = createWin32HostPlatform();
