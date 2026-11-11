import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isAppWindowTitle, wmctrlAppWindow } from "../server/launcher/window-focus.js";
import { serverOptions } from "../server/options.js";
import { browserCommand, focusAppWindow, openBrowser } from "../server/process-policy.js";
import { relaunchWindow, type WindowAnswer } from "../server/relaunch-model.js";
import { lifecycleLog } from "../server/services/log.js";
import { serverProcess } from "./harness/server.js";

test("browser opener accepts only the loopback app and treats URL as one literal argument", async (t) => {
	for (const url of [
		"https://example.com",
		"file:///etc/passwd",
		"http://127.0.0.1.evil:4321/",
		"http://user@127.0.0.1:4321/",
	])
		assert.throws(() => browserCommand(url));
	// Windows opens through the system rundll32 by absolute path, never cmd.exe, and the URL stays one argument.
	assert.deepEqual(browserCommand("http://127.0.0.1:4321/#token=abc_-", "win32", { SystemRoot: "D:\\Win" }), {
		file: "D:\\Win\\System32\\rundll32.exe",
		argv: ["url.dll,FileProtocolHandler", "http://127.0.0.1:4321/#token=abc_-"],
	});
	assert.equal(browserCommand("http://127.0.0.1:4321/", "win32", {}).file, "C:\\Windows\\System32\\rundll32.exe");
	assert.throws(() => browserCommand("http://127.0.0.1:4321/", "win32", { SystemRoot: "relative\\dir" }), /SystemRoot/);
	assert.throws(() => browserCommand("http://127.0.0.1:4321/", "freebsd"), /printed URL/);
	const dir = await mkdtemp(join(tmpdir(), "clio-web-browser-command-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const opener = join(dir, "xdg-open"),
		log = join(dir, "argv");
	await writeFile(opener, '#!/bin/sh\nprintf "%s\\n" "$#" "$1" > "$OPENER_LOG"\n');
	await chmod(opener, 0o700);
	const url = "http://127.0.0.1:4321/#token=literal&$(never-execute)`literal`";
	await openBrowser(url, { PATH: dir, OPENER_LOG: log });
	assert.equal(await readFile(log, "utf8"), `1\n${url}\n`);
	await assert.rejects(openBrowser(url, { PATH: "" }));
});

test("a launch on a Linux desktop raises an open app window and otherwise reports none", async (t) => {
	for (const title of ["Clio Coder", "Tasks · Clio Coder - Google Chrome", "● Approval needed — Chat · Clio Coder"])
		assert.ok(isAppWindowTitle(title), title);
	for (const title of ["Clio Coder notes.md - Visual Studio Code", "Not Clio Coder at all", "Clio Coder docs - GitHub"])
		assert.ok(!isAppWindowTitle(title), title);
	const dir = await mkdtemp(join(tmpdir(), "clio-web-focus-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const log = join(dir, "argv");
	const listing = "0x01 0 host Clio Coder docs - GitHub\n0x02 -1 host Settings · Clio Coder\n";
	assert.equal(wmctrlAppWindow(listing), "0x02");
	await writeFile(
		join(dir, "wmctrl"),
		`#!/bin/sh\nif [ "$1" = "-l" ]; then printf '${listing}'; else printf "%s " "$@" > "$FOCUS_LOG"; fi\n`,
	);
	await chmod(join(dir, "wmctrl"), 0o700);
	const env = { PATH: dir, DISPLAY: ":0", FOCUS_LOG: log };
	assert.equal(await focusAppWindow(env, "linux"), true);
	assert.equal(await readFile(log, "utf8"), "-i -a 0x02 ");
	// No display, another platform, or a desktop without a usable tool: the launch opens a tab instead.
	assert.equal(await focusAppWindow({ PATH: dir }, "linux"), false);
	assert.equal(await focusAppWindow(env, "darwin"), false);
	assert.equal(
		await focusAppWindow({ PATH: join(dir, "missing"), DISPLAY: ":0", SWAYSOCK: "/nowhere" }, "linux"),
		false,
	);
});

test("a relaunch focuses only a window the app says is live, and otherwise opens the fresh link", async () => {
	const run = async (path: string, live: WindowAnswer | Error, focused: boolean, page: WindowAnswer = "shown") => {
		const calls: string[] = [];
		const outcome = await relaunchWindow(path, {
			ask: async (named) => {
				calls.push(`ask ${named ?? "-"}`);
				if (named === undefined && live instanceof Error) throw live;
				return named === undefined ? (live as WindowAnswer) : page;
			},
			focus: async () => {
				calls.push("focus");
				return focused;
			},
			open: async (reuse) => {
				calls.push(`open ${reuse}`);
			},
		});
		return { outcome, calls };
	};
	// The server restarted: the window on screen is dead, so a fresh one opens and nothing is focused.
	assert.deepEqual(await run("/", "no-window", true), { outcome: "opened", calls: ["ask -", "open false"] });
	assert.deepEqual(await run("/sessions", "no-window", true), { outcome: "opened", calls: ["ask -", "open false"] });
	assert.deepEqual(await run("/", "shown", true), { outcome: "focused", calls: ["ask -", "focus"] });
	assert.deepEqual(await run("/sessions", "shown", true), {
		outcome: "focused",
		calls: ["ask -", "focus", "ask /sessions"],
	});
	// No tool raised it (WSL leaves that to its Windows launcher): reuse the live window only for a bare launch.
	assert.deepEqual(await run("/", "shown", false), { outcome: "opened", calls: ["ask -", "focus", "open true"] });
	assert.deepEqual(await run("/sessions", "shown", false), {
		outcome: "opened",
		calls: ["ask -", "focus", "open false"],
	});
	// An older app that cannot answer keeps today's behaviour: focus, then name the page.
	assert.deepEqual(await run("/", new Error("refused"), true), { outcome: "focused", calls: ["ask -", "focus"] });
	assert.deepEqual(await run("/sessions", "unknown", true, "unknown"), {
		outcome: "page-not-shown",
		calls: ["ask -", "focus", "ask /sessions"],
	});
	assert.deepEqual((await run("/", "unknown", false)).calls, ["ask -", "focus", "open false"]);
});

test("--open uses the actual bound URL with its own launch ticket; a removed --token, invalid flags and unsafe log paths fail", {
	timeout: 10000,
}, async (t) => {
	for (const args of [
		["--port", ""],
		["--port", "0x10"],
		["--port", "65536"],
		["--idle-exit", "0"],
		["--idle-exit", "NaN"],
		["--token", "a".repeat(43)],
		["--log-file", ""],
		...[
			"https://example.com",
			"//example.com",
			"/%2fexample.com",
			"/docs/../api",
			"/docs/%2e%2e/api",
			"/docs?token=x",
			"/docs#token=x",
			"/docs%0ax",
			"/docs\\x",
			"/docs/%zz",
		].map((path) => ["--path", path]),
		["--reuse-background", "--port", "4317"],
		["--reuse-background", "--fixture"],
	])
		assert.throws(() => serverOptions(args));
	const dir = await mkdtemp(join(tmpdir(), "clio-web-open-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await mkdir(join(dir, "bin"));
	const opener = join(dir, "bin/xdg-open"),
		log = join(dir, "url");
	await writeFile(opener, '#!/bin/sh\nprintf "%s" "$1" > "$OPENER_LOG"\n');
	await chmod(opener, 0o700);
	const s = await serverProcess(t, ["--open", "--path", "/docs/architecture/safety-model.md", "--idle-exit", "1500"], {
		PATH: join(dir, "bin"),
		OPENER_LOG: log,
	});
	assert.equal(await s.exited, 0);
	// The opener's argv carries its own single-use launch ticket, never the one the printed link spends.
	const opened = new URL(await readFile(log, "utf8"));
	assert.equal(`${opened.origin}${opened.pathname}`, `${s.launch.origin}${s.launch.pathname}`);
	assert.match(opened.hash, /^#ticket=[\w-]{43}$/);
	assert.notEqual(opened.hash, s.launch.hash);
	assert.equal(s.launch.pathname, "/docs/architecture/safety-model.md");
	const target = join(dir, "unrelated");
	await writeFile(target, "keep");
	await symlink(target, join(dir, "symlink"));
	await assert.rejects(lifecycleLog(join(dir, "symlink")));
	assert.equal(await readFile(target, "utf8"), "keep");
});
