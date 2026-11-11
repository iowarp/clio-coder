import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { openableUrl, openBrowser, windowsUrlOpener } from "../../src/core/open-browser.js";

it("hands the opener the parsed URL with shell-active characters percent-encoded, and refuses other schemes", () => {
	strictEqual(openableUrl("https://x.example/d?c=$(calc.exe)"), "https://x.example/d?c=%24%28calc.exe%29");
	const opened = openableUrl("https://x.example/a;b?q=`id`&r='x' \"y\"#$HOME") ?? "";
	strictEqual(/[$`"'();\s]/u.test(opened), false, opened);
	strictEqual(opened.startsWith("https://x.example/a%3Bb?q="), true, opened);
	for (const honest of [
		"https://github.com/login/device?user_code=ABCD-1234",
		"http://127.0.0.1:8080/callback?code=abc&state=xyz",
	])
		strictEqual(openableUrl(honest), honest);
	for (const refused of ["file:///etc/passwd", "http://evil.example/", "javascript:alert(1)", "not a url"])
		strictEqual(openableUrl(refused), null, refused);
});

it("opens plain http only on a loopback host, not on a look-alike or another scheme", () => {
	for (const loopback of ["http://localhost:1455/auth/callback", "http://[::1]:9000/"])
		strictEqual(openableUrl(loopback), loopback);
	for (const refused of ["http://127.0.0.1.evil.example/", "http://localhost.evil.example/", "vscode://open"])
		strictEqual(openableUrl(refused), null, refused);
});

it("opens a link on Windows through the System32 rundll32, never cmd, and keeps the URL whole", () => {
	const url = "https://example.com/a?x=1&calc.exe";
	deepStrictEqual(windowsUrlOpener(url, { SystemRoot: "D:\\Win" }), [
		"D:\\Win\\System32\\rundll32.exe",
		["url.dll,FileProtocolHandler", url],
	]);
	deepStrictEqual(windowsUrlOpener(url, {})?.[0], "C:\\Windows\\System32\\rundll32.exe");
	strictEqual(windowsUrlOpener(url, { SystemRoot: "Windows" }), null);
});

it("starts the opener with the safe environment plus the display session, and leaves what it starts running", {
	skip: process.platform !== "linux",
}, async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "clio-opener-"));
	try {
		const seen = path.join(dir, "seen.json");
		const alive = path.join(dir, "alive");
		// A stand-in xdg-open that hands off to a "browser" in its own group, then exits.
		writeFileSync(
			path.join(dir, "xdg-open"),
			`#!/bin/sh\n${JSON.stringify(process.execPath)} -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ args: process.argv.slice(2), env: process.env }))' ${JSON.stringify(seen)} "$@"\n(sleep 1; echo up > ${JSON.stringify(alive)}) &\nexit 0\n`,
		);
		chmodSync(path.join(dir, "xdg-open"), 0o755);
		const opened = openBrowser("https://example.com/login?code=1", {
			PATH: `${dir}:/usr/bin:/bin`,
			HOME: dir,
			DISPLAY: ":7",
			DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1/bus",
			OPENAI_API_KEY: "sk-must-not-leak",
			GITHUB_TOKEN: "ghp-must-not-leak",
		});
		strictEqual(opened, true);
		const deadline = Date.now() + 10_000;
		while (!existsSync(alive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
		const record = JSON.parse(readFileSync(seen, "utf8")) as { args: string[]; env: Record<string, string> };
		deepStrictEqual(record.args, ["https://example.com/login?code=1"]);
		strictEqual(record.env.DISPLAY, ":7");
		strictEqual(record.env.DBUS_SESSION_BUS_ADDRESS, "unix:path=/run/user/1/bus");
		strictEqual(record.env.OPENAI_API_KEY, undefined);
		strictEqual(record.env.GITHUB_TOKEN, undefined);
		strictEqual(existsSync(alive), true, "the opener's child was torn down");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
