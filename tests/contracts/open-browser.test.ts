import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { it } from "node:test";
import { openableUrl, windowsUrlOpener } from "../../src/core/open-browser.js";

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
