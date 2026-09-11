import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { AxeBuilder } from "@axe-core/playwright";
import { type BrowserContext, type CDPSession, chromium, type Page } from "playwright-core";
import {
	backgroundStatus,
	installBackground,
	startBackground,
	stopBackground,
	uninstallBackground,
} from "../../server/launcher/background.js";
import { backgroundPaths, newBackgroundConfig, readBackgroundConfig } from "../../server/launcher/background-config.js";
import { localServerReady } from "../../server/local-server.js";
import { controlService } from "../../server/process-policy.js";

async function eventually<T>(read: () => Promise<T>, accepts: (value: T) => boolean, timeout = 15000): Promise<T> {
	const deadline = performance.now() + timeout;
	while (performance.now() < deadline) {
		const value = await read();
		if (accepts(value)) return value;
		await delay(150);
	}
	throw new Error("Lifecycle condition did not become true within its deadline.");
}
async function appPage(context: BrowserContext, cdp: CDPSession, manifestId: string) {
	await cdp.send("PWA.launch", { manifestId });
	// Chrome can replace the initial launch target while creating the standalone window.
	return eventually(
		async () => {
			for (const page of context.pages()) {
				if (
					page.url().startsWith(manifestId) &&
					(await page.evaluate(() => matchMedia("(display-mode: standalone)").matches).catch(() => false))
				)
					return page;
			}
			return undefined;
		},
		(value) => !!value,
	).then((page) => {
		assert.ok(page);
		return page;
	});
}
async function connected(page: Page) {
	await page.locator('.connection[data-connected="true"]').waitFor({ timeout: 15000 });
	assert.equal(new URL(page.url()).hash, "");
	const meta = await page.evaluate(async () => {
		const token = localStorage.getItem("clio-coder-pwa-token");
		return (await fetch("/api/meta", { headers: { Authorization: `Bearer ${token}` } })).json();
	});
	assert.equal(meta.pwa, true);
	return meta.epoch as string;
}

test("native user service and installed Chrome PWA retain access through window, browser and server restarts", {
	timeout: 180000,
}, async () => {
	assert.equal(
		process.platform,
		"linux",
		"This acceptance check requires a Linux systemd user session and graphical Chrome.",
	);
	const scratch = await mkdtemp(join(tmpdir(), "clio-web-pwa-native-"));
	const report: Record<string, unknown> = { scratch, checks: [] };
	const checks = report.checks as string[];
	const directory = join(scratch, "background space %f $literal"),
		files = backgroundPaths(directory);
	const reserve = createServer();
	await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve));
	const address = reserve.address();
	assert.ok(address && typeof address !== "string");
	await new Promise<void>((resolve) => reserve.close(() => resolve()));
	const config = await newBackgroundConfig(
		address.port,
		{
			node: process.execPath,
			loader: fileURLToPath(import.meta.resolve("tsx")),
			entry: fileURLToPath(new URL("../../server/main.ts", import.meta.url)),
		},
		join(scratch, "xdg-data"),
	);
	config.roots = {
		config: join(scratch, "config"),
		data: join(scratch, "data"),
		state: join(scratch, "state"),
		cache: join(scratch, "cache"),
	};
	for (const path of Object.values(config.roots)) await mkdir(path, { recursive: true, mode: 0o700 });
	const origin = `http://127.0.0.1:${config.port}`,
		manifestId = `${origin}/`;
	let context: BrowserContext | undefined,
		cdp: CDPSession | undefined,
		installed = false;
	const browser = async () => {
		const context = await chromium.launchPersistentContext(join(scratch, "chrome-profile"), {
			executablePath: process.env.CHROME_PATH ?? "/usr/bin/google-chrome",
			headless: false,
			args: ["--ozone-platform=x11", "--disable-dev-shm-usage"],
			env: {
				...process.env,
				XDG_DATA_HOME: join(scratch, "xdg-data"),
				XDG_CONFIG_HOME: join(scratch, "xdg-config"),
				XDG_CACHE_HOME: join(scratch, "xdg-cache"),
			},
		});
		const instance = context.browser();
		assert.ok(instance);
		return { context, cdp: await instance.newBrowserCDPSession() };
	};
	try {
		await installBackground(directory, config);
		let state = await backgroundStatus(directory);
		assert.equal(state.active, "active");
		assert.equal(state.enabled, "enabled");
		assert.equal(state.ready, true);
		checks.push("real systemd unit enabled at login and authenticated readiness");
		const openerDir = join(scratch, "opener"),
			openerLog = join(scratch, "opened-url");
		await mkdir(openerDir);
		await writeFile(join(openerDir, "xdg-open"), '#!/bin/sh\nprintf "%s\\n" "$1" > "$OPENER_LOG"\n', { mode: 0o700 });
		const activation = spawnSync(
			"gio",
			["launch", join(config.desktopPrefix, "applications/io.iowarp.ClioCoder.desktop")],
			{
				cwd: "/",
				encoding: "utf8",
				env: { ...process.env, PATH: `${openerDir}:${process.env.PATH}`, OPENER_LOG: openerLog },
			},
		);
		assert.equal(activation.status, 0, activation.stderr);
		const opened = await eventually(
			() => readFile(openerLog, "utf8").catch(() => ""),
			(value) => !!value,
		);
		assert.equal(opened.trim(), `${origin}/#token=${config.token}`);
		checks.push(
			"native GLib background launcher opens the authenticated URL from arbitrary cwd with literal special-character paths",
		);
		({ context, cdp } = await browser());
		let page = context.pages()[0] ?? (await context.newPage());
		await page.goto(await startBackground(directory));
		const epoch = await connected(page);
		await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
		await page.reload();
		await connected(page);
		const pageCdp = await context.newCDPSession(page);
		const manifest = await pageCdp.send("Page.getAppManifest");
		assert.deepEqual(manifest.errors, []);
		assert.equal(JSON.parse(manifest.data ?? "{}").display, "standalone");
		assert.deepEqual((await pageCdp.send("Page.getInstallabilityErrors")).installabilityErrors, []);
		await pageCdp.detach();
		await cdp.send("PWA.install", { manifestId, installUrlOrBundleUrl: origin });
		// DevTools installation defaults to the browser user preference; select the native window setting.
		await cdp.send("PWA.changeAppUserSettings", { manifestId, displayMode: "standalone" });
		installed = true;
		await page.close();
		page = await appPage(context, cdp, manifestId);
		assert.equal(await connected(page), epoch);
		assert.equal(await page.evaluate(() => matchMedia("(display-mode: standalone)").matches), true);
		checks.push("real Chrome PWA installed, launched as standalone and authenticated without a token URL");
		await page.getByText("Installed app preferences", { exact: true }).click();
		for (const width of [390, 1050]) {
			await page.setViewportSize({ width, height: 900 });
			assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations, []);
			assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
		}
		checks.push("installed app preferences pass all Axe severities and overflow checks at phone and desktop widths");
		await page.close();
		page = await appPage(context, cdp, manifestId);
		await connected(page);
		checks.push("closing and reopening the installed app retains access");
		// The PID is read from the verified unit and its command line must identify our private config.
		const pid = state.pid;
		assert.ok(pid);
		const command = await readFile(`/proc/${pid}/cmdline`, "utf8");
		assert.ok(command.split("\0").includes(files.config));
		process.kill(pid, "SIGKILL");
		state = await eventually(
			() => backgroundStatus(directory),
			(value) => value.ready === true && value.pid !== pid,
		);
		await page.reload();
		assert.notEqual(await connected(page), epoch);
		assert.equal((await readBackgroundConfig(files.config)).token, config.token);
		checks.push("unexpected server death restarts under systemd at the same origin with the same credential");
		await stopBackground(directory);
		assert.equal(await localServerReady(config.port, config.token), false);
		await page.close();
		page = await appPage(context, cdp, manifestId);
		await page.getByRole("heading", { name: /We’ll reconnect/ }).waitFor();
		for (const width of [390, 1050]) {
			await page.setViewportSize({ width, height: 900 });
			assert.deepEqual((await new AxeBuilder({ page }).analyze()).violations, []);
			assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
		}
		await page.screenshot({ path: join(scratch, "offline.png") });
		const cached = await page.evaluate(async () => {
			const results: string[] = [];
			for (const name of await caches.keys())
				for (const request of await (await caches.open(name)).keys()) results.push(new URL(request.url).pathname);
			return results.sort();
		});
		assert.deepEqual(cached, ["/icon-192.png", "/offline.css", "/offline.html", "/offline.js"]);
		checks.push(
			"relaunch while stopped shows accessible responsive recovery; cache contains only four public recovery assets",
		);
		await startBackground(directory);
		await connected(page);
		checks.push("recovery screen reconnects automatically when the service returns");
		await context.close();
		context = undefined;
		({ context, cdp } = await browser());
		page = await appPage(context, cdp, manifestId);
		await connected(page);
		checks.push("full Chrome process restart preserves installed app and authenticated access");
		const other = await context.newPage();
		await other.goto(origin);
		await connected(other);
		await page.getByText("Installed app preferences", { exact: true }).click();
		await page.getByRole("button", { name: "Forget this browser" }).click();
		await page.getByText(/Open Clio Coder from your applications/).waitFor();
		await other.getByText(/Open Clio Coder from your applications/).waitFor();
		assert.equal(await localServerReady(config.port, config.token), true);
		checks.push("forget browser removes access in all open windows while the service keeps running");
		await cdp.send("PWA.uninstall", { manifestId });
		installed = false;
		await uninstallBackground(directory);
		assert.equal((await backgroundStatus(directory)).status, "absent");
		assert.equal(await localServerReady(config.port, config.token), false);
		const removed = await controlService("show", files.unit, files.unitFile);
		assert.match(removed, /MainPID=0/);
		assert.ok(!removed.includes(`FragmentPath=${files.unitFile}`));
		checks.push("uninstall stops the service and removes only its owned unit, credentials and desktop entry");
		report.verdict = "pass";
	} catch (error) {
		report.verdict = "fail";
		report.error = String(error).replaceAll(config.token, "[redacted]");
		throw error;
	} finally {
		if (installed && cdp) await cdp.send("PWA.uninstall", { manifestId }).catch(() => {});
		await context?.close();
		await uninstallBackground(directory);
		await writeFile(join(scratch, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
		console.log(`PWA lifecycle report: ${join(scratch, "report.json")}`);
	}
});
