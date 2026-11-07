import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { parseTomlDocument } from "../../src/core/toml.js";
import { socketTransportPath } from "../../src/domains/mux/socket-client.js";
import { isClioHostSocket } from "../../src/domains/mux/workspace/platform.js";
import { createWin32HostPlatform, win32PaneLaunch } from "../../src/domains/mux/workspace/platform-win32.js";
import { renderYaziKeymap } from "../../src/domains/mux/yazi/profile.js";

/**
 * The Windows pane host: herdr's own named session, whose named pipe is named
 * after the session's socket path exactly as herdr spells it, a PowerShell
 * pane shell, and a client that can only be killed, never asked to detach.
 */

const SESSION = "clio-coder-0123456789ab";
const roots: string[] = [];

function platform(extra: Parameters<typeof createWin32HostPlatform>[0] = {}) {
	const state = mkdtempSync(join(tmpdir(), "clio-win32-host-"));
	roots.push(state);
	return { state, host: createWin32HostPlatform({ stateDir: () => state, ...extra }) };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("win32 pane host layout", () => {
	it("is herdr's named session under APPDATA with only the config file redirected to Clio", () => {
		const { state, host } = platform();
		const layout = host.hostLayout({
			session: SESSION,
			env: { APPDATA: "C:\\Users\\Ann Lee\\AppData\\Roaming", HERDR_SOCKET_PATH: "C:\\elsewhere\\herdr.sock" },
		});
		strictEqual(layout.socketPath, `C:\\Users\\Ann Lee\\AppData\\Roaming\\herdr\\sessions\\${SESSION}\\herdr.sock`);
		deepStrictEqual(layout.herdrArgs, ["--session", SESSION]);
		deepStrictEqual(layout.cleanupArgs, ["session", "delete", SESSION]);
		const root = join(state, "mux", "0123456789ab");
		strictEqual(layout.configPath, join(root, "config.toml"));
		deepStrictEqual(layout.hostEnv, { HERDR_CONFIG_PATH: layout.configPath });
		deepStrictEqual(layout.disposableDirs, [root]);
		strictEqual(layout.sessionFile, `C:\\Users\\Ann Lee\\AppData\\Roaming\\herdr\\sessions\\${SESSION}\\session.json`);
		ok(existsSync(root));
		// herdr chooses pwsh or Windows PowerShell itself, which is what turns its PowerShell integration on.
		deepStrictEqual(layout.shell, { defaultShell: null, shellMode: "non_login" });
		ok(isClioHostSocket(layout.socketPath));
	});

	it("spells the pipe path as herdr does: XDG_CONFIG_HOME first, separators kept, none doubled", () => {
		const { host } = platform();
		const env = { XDG_CONFIG_HOME: "D:/cfg/", APPDATA: "C:\\ignored" };
		strictEqual(host.hostLayout({ session: SESSION, env }).socketPath, `D:/cfg/herdr\\sessions\\${SESSION}\\herdr.sock`);
		strictEqual(
			host.hostLayout({ session: SESSION, env: { USERPROFILE: "C:\\Users\\a" } }).socketPath,
			`C:\\Users\\a\\AppData\\Roaming\\herdr\\sessions\\${SESSION}\\herdr.sock`,
		);
	});

	it("reaches the session's named pipe through its socket path", () => {
		const path = `C:\\Users\\a\\AppData\\Roaming\\herdr\\sessions\\${SESSION}\\herdr.sock`;
		strictEqual(socketTransportPath(path, "win32"), `\\\\.\\pipe\\${path}`);
		strictEqual(socketTransportPath(`\\\\.\\pipe\\${path}`, "win32"), `\\\\.\\pipe\\${path}`);
		strictEqual(socketTransportPath("/run/user/1/clio-coder/x.sock", "linux"), "/run/user/1/clio-coder/x.sock");
	});
});

describe("win32 Clio pane launch", () => {
	const host = createWin32HostPlatform();
	const keep = (run: string) => `Remove-Item Env:CLIO_CODER_PANE_RUN; Clear-Host; ${run}`;

	it("carries Clio's command in the pane's environment, types an inert line and keeps the shell", () => {
		deepStrictEqual(
			host.paneLaunch([
				"C:\\Program Files\\nodejs\\node.exe",
				"C:\\clio\\bin\\clio-coder.cjs",
				"--model",
				"it's",
				"$env:X",
			]),
			{
				env: {
					CLIO_CODER_PANE_RUN: keep(
						"& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\clio\\bin\\clio-coder.cjs' '--model' 'it''s' '$env:X'",
					),
				},
				line: "if ($env:CLIO_CODER_PANE_RUN) { iex $env:CLIO_CODER_PANE_RUN }",
			},
		);
		strictEqual(
			host.paneLaunch(["node", "\u2018q\u2019"]).env.CLIO_CODER_PANE_RUN,
			keep("& 'node' '\u2018\u2018q\u2019\u2019'"),
		);
	});

	it("chooses at run time how to pass arguments older PowerShell would mangle", () => {
		const choice = (legacy: string, raw: string) =>
			`$(if ("$(Get-Variable PSNativeCommandArgumentPassing -ValueOnly -ErrorAction Ignore)" -in '', 'Legacy') { '${legacy}' } else { '${raw}' })`;
		strictEqual(
			host.paneLaunch(["node", "", 'say "hi"', "C:\\a b\\"]).env.CLIO_CODER_PANE_RUN,
			keep(`& 'node' ${choice('""', "")} ${choice('say \\"hi\\"', 'say "hi"')} ${choice("C:\\a b\\\\", "C:\\a b\\")}`),
		);
	});
});

describe("win32 utility pane launch", () => {
	const wrap = (run: string) => `Remove-Item Env:CLIO_CODER_PANE_RUN; Clear-Host; try { ${run} } finally { exit }`;

	it("carries the command in the pane's environment and types only a line that is inert elsewhere", () => {
		deepStrictEqual(win32PaneLaunch(["C:\\tools\\yazi.exe", "--chooser-file", "C:\\a b\\it's"]), {
			env: { CLIO_CODER_PANE_RUN: wrap("& 'C:\\tools\\yazi.exe' '--chooser-file' 'C:\\a b\\it''s'") },
			line: "if ($env:CLIO_CODER_PANE_RUN) { iex $env:CLIO_CODER_PANE_RUN }",
		});
		strictEqual(win32PaneLaunch([]), null);
	});

	it("redirects stdout through Start-Process with a command line the program splits back exactly", () => {
		strictEqual(
			win32PaneLaunch(["C:\\y.exe", "--local-events", "", 'a "q"', "C:\\a b\\", "it's"], "C:\\s\\o'k.events")?.env
				.CLIO_CODER_PANE_RUN,
			wrap(
				`Start-Process -FilePath 'C:\\y.exe' -ArgumentList '"--local-events" "" "a \\"q\\"" "C:\\a b\\\\" "it''s"' -NoNewWindow -Wait -RedirectStandardOutput 'C:\\s\\o''k.events'`,
			),
		);
		strictEqual(
			win32PaneLaunch(["C:\\y.exe"], "C:\\out")?.env.CLIO_CODER_PANE_RUN,
			wrap("Start-Process -FilePath 'C:\\y.exe' -NoNewWindow -Wait -RedirectStandardOutput 'C:\\out'"),
		);
	});
});

describe("win32 detach", () => {
	function fakeClient(exited = false) {
		const kills: Array<NodeJS.Signals | number | undefined> = [];
		const child = {
			exitCode: exited ? 0 : null,
			signalCode: null,
			kill(signal?: NodeJS.Signals | number) {
				kills.push(signal);
				return true;
			},
		} as unknown as ChildProcess;
		return { child, kills };
	}

	function terminal() {
		const written: string[] = [];
		const raw: boolean[] = [];
		let paused = 0;
		return {
			written,
			raw,
			paused: () => paused,
			stdout: { write: (chunk: string) => written.push(chunk) > 0 },
			stdin: () => ({
				isTTY: true,
				setRawMode: (mode: boolean) => raw.push(mode),
				pause: () => {
					paused += 1;
				},
			}),
		};
	}

	it("kills a live client, then puts the terminal and console input mode back once", () => {
		const term = terminal();
		const { host } = platform({ stdout: term.stdout as never, stdin: term.stdin });
		const client = fakeClient();
		host.detach(client.child);
		strictEqual(client.kills.length, 1);
		host.afterClientExit();
		strictEqual(term.written.length, 1);
		const restore = term.written[0] ?? "";
		for (const sequence of ["\x1b[?1049l", "\x1b[?25h", "\x1b[?1000l", "\x1b[?2004l", "\x1b[?1004l", "\x1b[?9001l"]) {
			ok(restore.includes(sequence), JSON.stringify(sequence));
		}
		deepStrictEqual(term.raw, [true, false]);
		strictEqual(term.paused(), 1);
		host.afterClientExit();
		strictEqual(term.written.length, 1);
	});

	it("leaves a client that exited on its own, and its terminal, alone", () => {
		const term = terminal();
		const { host } = platform({ stdout: term.stdout as never, stdin: term.stdin });
		const client = fakeClient(true);
		host.detach(client.child);
		host.afterClientExit();
		strictEqual(client.kills.length, 0);
		deepStrictEqual(term.written, []);
		deepStrictEqual(term.raw, []);
	});
});

describe("win32 files pane keymap", () => {
	it("hands cmd.exe a quoted ya.exe and %-escaped variables, so Ctrl+Y and Alt+E reach Clio", () => {
		const ya = "C:\\Users\\Jo Doe\\AppData\\Local\\clio-coder\\tools\\yazi\\ya.exe";
		const doc = parseTomlDocument(renderYaziKeymap(ya, "win32")) as { mgr: { prepend_keymap: { run: string }[] } };
		deepStrictEqual(
			doc.mgr.prepend_keymap.map((chord) => chord.run),
			[
				`shell -- "${ya}" pub-to %%YAZI_ID%% clio-coder-pick --list %%CLIO_CODER_YAZI_PICK_TOKEN%% %s`,
				`shell -- "${ya}" pub-to %%YAZI_ID%% clio-coder-dock --list %%CLIO_CODER_YAZI_PICK_TOKEN%%`,
			],
		);
	});
});
