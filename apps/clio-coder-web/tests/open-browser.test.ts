import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serverOptions } from "../server/options.js";
import { browserCommand, openBrowser } from "../server/process-policy.js";
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
	assert.throws(() => browserCommand("http://127.0.0.1:4321/", "win32"), /printed URL/);
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

test("--open uses the actual bound URL with its explicit token; invalid flags and unsafe log paths fail", {
	timeout: 10000,
}, async (t) => {
	for (const args of [
		["--port", ""],
		["--port", "0x10"],
		["--port", "65536"],
		["--idle-exit", "0"],
		["--idle-exit", "NaN"],
		["--token", "short"],
		["--token", "a".repeat(300)],
		["--log-file", ""],
	])
		assert.throws(() => serverOptions(args));
	const dir = await mkdtemp(join(tmpdir(), "clio-web-open-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await mkdir(join(dir, "bin"));
	const opener = join(dir, "bin/xdg-open"),
		log = join(dir, "url");
	await writeFile(opener, '#!/bin/sh\nprintf "%s" "$1" > "$OPENER_LOG"\n');
	await chmod(opener, 0o700);
	const s = await serverProcess(t, ["--open", "--idle-exit", "1500"], { PATH: join(dir, "bin"), OPENER_LOG: log });
	assert.equal(await s.exited, 0);
	assert.equal(await readFile(log, "utf8"), s.launch.href);
	const target = join(dir, "unrelated");
	await writeFile(target, "keep");
	await symlink(target, join(dir, "symlink"));
	await assert.rejects(lifecycleLog(join(dir, "symlink")));
	assert.equal(await readFile(target, "utf8"), "keep");
});
