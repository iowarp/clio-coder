#!/usr/bin/env node
// web-check: load a page in a headless browser, optionally run a step file, and print one JSON report.
// Node 22+, no install step. Uses the project's own Playwright when it resolves, else a built-in CDP client.
// Usage: node web-check.mjs <url> [--steps file.mjs] [--viewport 1440x900[,390x844]] [--serve "<cmd>" --ready <url>]
//        [--local-storage KEY=VALUE]... [--init file.js] [--shot] [--full-page] [--text [selector]] [--wait-for text] [--wait ms]
//        [--timeout ms] [--out dir] [--project dir] [--strict]
// Exit: 0 loaded; 1 load failed, a step threw, or (--strict) console errors, exceptions or failed requests remain;
// 2 usage error or no usable browser.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const USAGE =
	'usage: web-check.mjs <url> [--steps file.mjs] [--viewport WxH[,WxH]] [--serve "<cmd>" --ready <url>] [--local-storage K=V] [--init file.js] [--shot] [--full-page] [--text [selector]] [--wait-for text] [--wait ms] [--timeout ms] [--out dir] [--project dir] [--strict]';
const MAX_ENTRIES = 50;
const MAX_TEXT = 300;

function parseArgs(argv) {
	const o = { viewports: [], storage: [], ready: [], wait: 1000, timeout: 30000, readyTimeout: 90000 };
	const value = (i, flag) => {
		if (i + 1 >= argv.length) throw new Error(`${flag} needs a value`);
		return argv[i + 1];
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--help" || a === "-h") o.help = true;
		else if (a === "--steps") o.steps = value(i++, a);
		else if (a === "--viewport")
			for (const v of value(i++, a).split(",")) {
				const m = /^(\d+)x(\d+)$/.exec(v.trim());
				if (!m) throw new Error(`--viewport takes WxH, got ${v}`);
				o.viewports.push({ width: Number(m[1]), height: Number(m[2]) });
			}
		else if (a === "--serve") o.serve = value(i++, a);
		else if (a === "--ready") o.ready.push(value(i++, a));
		else if (a === "--ready-timeout") o.readyTimeout = Number(value(i++, a));
		else if (a === "--local-storage") {
			const kv = value(i++, a);
			const eq = kv.indexOf("=");
			if (eq < 1) throw new Error("--local-storage takes KEY=VALUE");
			o.storage.push([kv.slice(0, eq), kv.slice(eq + 1)]);
		} else if (a === "--init") o.init = value(i++, a);
		else if (a === "--shot") o.shot = true;
		else if (a === "--full-page") o.fullPage = true;
		else if (a === "--text") {
			o.text = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "body";
		} else if (a === "--wait") o.wait = Number(value(i++, a));
		else if (a === "--wait-for") o.waitFor = value(i++, a);
		else if (a === "--timeout") o.timeout = Number(value(i++, a));
		else if (a === "--out") o.out = value(i++, a);
		else if (a === "--project") o.project = value(i++, a);
		else if (a === "--strict") o.strict = true;
		else if (a.startsWith("--")) throw new Error(`unknown flag ${a}`);
		else if (o.url === undefined) o.url = a;
		else throw new Error(`unexpected argument ${a}`);
	}
	if (o.viewports.length === 0) o.viewports.push({ width: 1280, height: 800 });
	return o;
}

/** A URL without its query string or fragment, which often carry tokens. */
function redact(u) {
	try {
		const p = new URL(u);
		const hidden = p.search || p.hash ? "?…" : "";
		return `${p.origin}${p.pathname}${hidden}`;
	} catch {
		return String(u).split(/[?#]/)[0];
	}
}
const clip = (s) => {
	const t = String(s ?? "");
	return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}…` : t;
};

class Report {
	console = new Map();
	exceptions = [];
	failed = new Map();
	shots = [];
	dropped = 0;
	/** Set while pages close: requests aborted by the close are the driver's, not the page's. */
	closing = false;
	aborted = 0;
	addConsole(level, text, url) {
		const key = `${level}|${text}`;
		const hit = this.console.get(key);
		if (hit) hit.count++;
		else if (this.console.size < MAX_ENTRIES)
			this.console.set(key, { level, text: clip(text), ...(url ? { url: redact(url) } : {}), count: 1 });
		else this.dropped++;
	}
	addException(message, url, line) {
		if (this.exceptions.some((e) => e.message === clip(message))) return;
		if (this.exceptions.length >= MAX_ENTRIES) return void this.dropped++;
		this.exceptions.push({ message: clip(message), ...(url ? { url: redact(url) } : {}), ...(line ? { line } : {}) });
	}
	addFailed(method, url, outcome) {
		if (this.closing) return;
		// A request the page or a reload cancelled is the client's choice, not a failure; count it only.
		if (outcome === "net::ERR_ABORTED") return void this.aborted++;
		const key = `${method} ${redact(url)} ${outcome}`;
		const hit = this.failed.get(key);
		if (hit) hit.count++;
		else if (this.failed.size < MAX_ENTRIES)
			this.failed.set(key, {
				method,
				url: redact(url),
				...(typeof outcome === "number" ? { status: outcome } : { error: clip(outcome) }),
				count: 1,
			});
		else this.dropped++;
	}
}

/** Where an Error's stack places it: the first http(s) frame. */
function frameOf(stack) {
	const m = /(https?:\/\/[^\s)]+):(\d+):\d+/.exec(String(stack ?? ""));
	return m ? { url: m[1], line: Number(m[2]) } : {};
}

// ── Browser discovery ────────────────────────────────────────────────────────

function headlessShells() {
	const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, path.join(os.homedir(), ".cache", "ms-playwright")];
	if (process.platform === "darwin") roots.push(path.join(os.homedir(), "Library", "Caches", "ms-playwright"));
	if (process.platform === "win32" && process.env.LOCALAPPDATA)
		roots.push(path.join(process.env.LOCALAPPDATA, "ms-playwright"));
	const found = [];
	for (const root of roots) {
		if (!root || !existsSync(root)) continue;
		const dirs = readdirSync(root)
			.filter((d) => d.startsWith("chromium_headless_shell-"))
			.sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
		for (const d of dirs)
			for (const sub of [
				"chrome-headless-shell-linux64",
				"chrome-headless-shell-mac-arm64",
				"chrome-headless-shell-mac-x64",
				"chrome-headless-shell-win64",
			]) {
				const exe = path.join(
					root,
					d,
					sub,
					process.platform === "win32" ? "chrome-headless-shell.exe" : "chrome-headless-shell",
				);
				if (existsSync(exe)) found.push(exe);
			}
	}
	return found;
}

function fullBrowsers() {
	const c = {
		linux: [
			"/usr/bin/google-chrome",
			"/usr/bin/google-chrome-stable",
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
			"/usr/bin/microsoft-edge",
			"/opt/google/chrome/chrome",
		],
		darwin: [
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
		],
		win32: [
			path.join(
				process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
				"Microsoft",
				"Edge",
				"Application",
				"msedge.exe",
			),
			path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
		],
	};
	return (c[process.platform] ?? []).filter((p) => existsSync(p));
}

const FIX =
	"install a headless shell, which needs no Unix sockets: npx playwright install --only-shell chromium (inside a sandbox it lands in the sandbox's PLAYWRIGHT_BROWSERS_PATH)";
function explainLaunch(message) {
	if (/process_singleton|socket\(\) failed: Operation not permitted|EPERM.*\.sock/.test(message))
		return `full Chrome needs a Unix socket for its process singleton, and this sandbox blocks Unix sockets; ${FIX}`;
	return clip(message.split("\n").slice(0, 3).join(" "));
}

function loadPlaywright(project) {
	const req = createRequire(path.join(path.resolve(project), "package.json"));
	for (const name of ["playwright", "@playwright/test", "playwright-core"]) {
		try {
			const mod = req(name);
			if (mod?.chromium) return { name, chromium: mod.chromium, version: safeVersion(req, name) };
		} catch {}
	}
	return undefined;
}
function safeVersion(req, name) {
	try {
		return req(`${name}/package.json`).version;
	} catch {
		return undefined;
	}
}

// ── Engines ──────────────────────────────────────────────────────────────────

async function playwrightEngine(pw, report) {
	let browser;
	let executable = "bundled";
	try {
		browser = await pw.chromium.launch({ headless: true });
	} catch (err) {
		const shells = headlessShells();
		if (!/Executable doesn't exist|browserType\.launch/.test(String(err?.message)) || shells.length === 0)
			throw new Error(explainLaunch(String(err?.message ?? err)));
		executable = shells[0];
		browser = await pw.chromium.launch({ headless: true, executablePath: executable });
	}
	return {
		engine: `playwright (${pw.name}${pw.version ? ` ${pw.version}` : ""})`,
		executable,
		async newPage(viewport, initScript) {
			const context = await browser.newContext({ viewport });
			if (initScript) await context.addInitScript({ content: initScript });
			const page = await context.newPage();
			page.on("console", (m) => {
				const t = m.type();
				// A failed resource is already a failedRequests entry.
				if (t === "error" && m.text().startsWith("Failed to load resource:")) return;
				if (t === "error" || t === "warning")
					report.addConsole(t === "warning" ? "warning" : "error", m.text(), m.location()?.url);
			});
			page.on("pageerror", (e) => {
				const f = frameOf(e.stack);
				report.addException(e.message, f.url, f.line);
			});
			page.on("requestfailed", (r) => report.addFailed(r.method(), r.url(), r.failure()?.errorText ?? "failed"));
			page.on("response", (r) => {
				if (r.status() >= 400) report.addFailed(r.request().method(), r.url(), r.status());
			});
			return {
				page,
				goto: (url, timeout) => page.goto(url, { waitUntil: "load", timeout }),
				shot: (file, fullPage) => page.screenshot({ path: file, fullPage }),
				text: (selector) => page.locator(selector).first().innerText({ timeout: 5000 }),
				waitForText: (text, timeout) => page.getByText(text).first().waitFor({ state: "visible", timeout }),
				contentLength: () => page.evaluate(() => document.body?.innerText.trim().length ?? 0),
				title: () => page.title(),
				url: () => page.url(),
				close: () => context.close(),
			};
		},
		close: () => browser.close(),
	};
}

/** Minimal CDP client over Node's built-in WebSocket: load, evaluate, click, fill, wait, screenshot. No auto-waiting. */
async function cdpEngine(report) {
	const candidates = [...headlessShells(), ...fullBrowsers()];
	if (candidates.length === 0) throw new Error(`no Chromium-family browser found; ${FIX}`);
	if (typeof WebSocket !== "function") throw new Error("this Node has no global WebSocket; use Node 22 or later");
	let lastError = "";
	for (const exe of candidates) {
		const profile = mkdtempSync(path.join(os.tmpdir(), "web-check-profile-"));
		const shell = exe.includes("headless-shell");
		const args = [
			...(shell ? [] : ["--headless=new"]),
			"--remote-debugging-port=0",
			`--user-data-dir=${profile}`,
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-gpu",
			"about:blank",
		];
		const child = spawn(exe, args, { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		const ws = await new Promise((resolve) => {
			const timer = setTimeout(() => resolve(undefined), 15000);
			child.stderr.on("data", (d) => {
				stderr += d;
				const m = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
				if (m) {
					clearTimeout(timer);
					resolve(m[1]);
				}
			});
			child.on("exit", () => {
				clearTimeout(timer);
				resolve(undefined);
			});
		});
		if (!ws) {
			child.kill("SIGKILL");
			rmSync(profile, { recursive: true, force: true });
			lastError = explainLaunch(stderr || "browser exited before DevTools listened");
			continue;
		}
		return startCdp(ws, child, profile, exe, report);
	}
	throw new Error(lastError);
}

async function startCdp(wsUrl, child, profile, executable, report) {
	const sock = new WebSocket(wsUrl);
	await new Promise((resolve, reject) => {
		sock.onopen = resolve;
		sock.onerror = () => reject(new Error("could not connect to the browser's DevTools socket"));
	});
	let nextId = 1;
	const pending = new Map();
	const listeners = [];
	sock.onmessage = (ev) => {
		const msg = JSON.parse(String(ev.data));
		if (msg.id && pending.has(msg.id)) {
			const { resolve, reject } = pending.get(msg.id);
			pending.delete(msg.id);
			if (msg.error) reject(new Error(msg.error.message));
			else resolve(msg.result);
		} else if (msg.method) for (const l of listeners) l(msg);
	};
	const send = (method, params = {}, sessionId) =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			pending.set(id, { resolve, reject });
			sock.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		});
	return {
		engine: "cdp (built-in; no auto-waiting)",
		executable,
		async newPage(viewport, initScript) {
			const { targetId } = await send("Target.createTarget", { url: "about:blank" });
			const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
			const s = (m, p) => send(m, p, sessionId);
			const requests = new Map();
			let loaded;
			listeners.push((msg) => {
				if (msg.sessionId !== sessionId) return;
				const p = msg.params;
				if (msg.method === "Page.loadEventFired") loaded?.();
				else if (msg.method === "Runtime.consoleAPICalled" && (p.type === "error" || p.type === "warning")) {
					const text = p.args.map((a) => a.value ?? a.description ?? "").join(" ");
					report.addConsole(p.type, text, p.stackTrace?.callFrames?.[0]?.url);
				} else if (msg.method === "Runtime.exceptionThrown") {
					const d = p.exceptionDetails;
					report.addException(d.exception?.description?.split("\n")[0] ?? d.text, d.url, d.lineNumber + 1);
				} else if (msg.method === "Log.entryAdded" && p.entry.level === "error" && p.entry.source !== "network")
					report.addConsole("error", p.entry.text, p.entry.url);
				else if (msg.method === "Network.requestWillBeSent")
					requests.set(p.requestId, { method: p.request.method, url: p.request.url });
				else if (msg.method === "Network.responseReceived" && p.response.status >= 400)
					report.addFailed(requests.get(p.requestId)?.method ?? "GET", p.response.url, p.response.status);
				else if (msg.method === "Network.loadingFailed" && !p.canceled) {
					const r = requests.get(p.requestId);
					report.addFailed(r?.method ?? "GET", r?.url ?? "", p.errorText);
				}
			});
			await Promise.all(["Page.enable", "Runtime.enable", "Log.enable", "Network.enable"].map((m) => s(m)));
			await s("Emulation.setDeviceMetricsOverride", { ...viewport, deviceScaleFactor: 1, mobile: false });
			if (initScript) await s("Page.addScriptToEvaluateOnNewDocument", { source: initScript });
			const evaluate = async (fn, arg) => {
				const expression = typeof fn === "function" ? `(${fn})(${JSON.stringify(arg)})` : String(fn);
				const r = await s("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
				if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
				return r.result.value;
			};
			const waitForSelector = async (selector, timeout = 10000) => {
				const end = Date.now() + timeout;
				while (Date.now() < end) {
					if (await evaluate((sel) => Boolean(document.querySelector(sel)), selector)) return;
					await new Promise((r) => setTimeout(r, 100));
				}
				throw new Error(`timed out waiting for ${selector}`);
			};
			const page = {
				evaluate,
				waitForSelector,
				waitForTimeout: (ms) => new Promise((r) => setTimeout(r, ms)),
				click: async (selector) => {
					await waitForSelector(selector);
					await evaluate((sel) => document.querySelector(sel).click(), selector);
				},
				fill: async (selector, value) => {
					await waitForSelector(selector);
					await evaluate(
						([sel, v]) => {
							const el = document.querySelector(sel);
							const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
							Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
							el.dispatchEvent(new Event("input", { bubbles: true }));
							el.dispatchEvent(new Event("change", { bubbles: true }));
						},
						[selector, value],
					);
				},
				goto: (url, opts) => goto(url, opts?.timeout ?? 30000),
				title: () => evaluate("document.title"),
				url: () => evaluate("location.href"),
				screenshot: (opts) => shot(opts.path, opts.fullPage),
			};
			const goto = async (url, timeout) => {
				let timer;
				const done = new Promise((resolve, reject) => {
					loaded = resolve;
					timer = setTimeout(() => reject(new Error(`load timed out after ${timeout}ms`)), timeout);
				});
				done.catch(() => {});
				try {
					const r = await s("Page.navigate", { url });
					if (r.errorText) throw new Error(`${r.errorText} at ${redact(url)}`);
					await done;
				} finally {
					clearTimeout(timer);
				}
			};
			const shot = async (file, fullPage) => {
				const r = await s("Page.captureScreenshot", { format: "png", captureBeyondViewport: Boolean(fullPage) });
				writeFileSync(file, Buffer.from(r.data, "base64"));
			};
			return {
				page,
				goto,
				shot,
				text: (selector) => evaluate((sel) => document.querySelector(sel)?.innerText ?? "", selector),
				contentLength: () => evaluate(() => document.body?.innerText.trim().length ?? 0),
				waitForText: async (text, timeout) => {
					const end = Date.now() + timeout;
					while (Date.now() < end) {
						if (await evaluate((t) => document.body?.innerText.includes(t) ?? false, text).catch(() => false)) return;
						await new Promise((r) => setTimeout(r, 200));
					}
					throw new Error(`timed out after ${timeout}ms waiting for text ${JSON.stringify(text)}`);
				},
				title: page.title,
				url: page.url,
				close: () => send("Target.closeTarget", { targetId }),
			};
		},
		async close() {
			try {
				await send("Browser.close");
			} catch {}
			sock.close();
			child.kill("SIGKILL");
			rmSync(profile, { recursive: true, force: true });
		},
	};
}

// ── Dev server ───────────────────────────────────────────────────────────────

let server;
function stopServer() {
	if (!server || server.exitCode !== null) return;
	try {
		process.kill(process.platform === "win32" ? server.pid : -server.pid, "SIGTERM");
	} catch {}
	setTimeout(() => {
		try {
			process.kill(process.platform === "win32" ? server.pid : -server.pid, "SIGKILL");
		} catch {}
	}, 2000).unref();
}
process.on("exit", () => {
	if (server && server.exitCode === null)
		try {
			process.kill(process.platform === "win32" ? server.pid : -server.pid, "SIGKILL");
		} catch {}
});
for (const sig of ["SIGINT", "SIGTERM"])
	process.on(sig, () => {
		stopServer();
		process.exit(130);
	});

/** Start the server and wait until every ready URL answers below 500. */
async function startServer(command, readyUrls, timeoutMs) {
	let log = "";
	server = spawn(command, { shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
	server.stdout.on("data", (d) => (log = (log + d).slice(-4000)));
	server.stderr.on("data", (d) => (log = (log + d).slice(-4000)));
	const end = Date.now() + timeoutMs;
	const waiting = new Set(readyUrls);
	while (Date.now() < end) {
		if (server.exitCode !== null)
			throw new Error(
				`--serve exited with ${server.exitCode} before ${[...waiting].join(", ")} answered: ${clip(log.slice(-600))}`,
			);
		for (const ready of [...waiting]) {
			try {
				const r = await fetch(ready, { signal: AbortSignal.timeout(2000) });
				if (r.status < 500) waiting.delete(ready);
			} catch {}
		}
		if (waiting.size === 0) return;
		await new Promise((r) => setTimeout(r, 300));
	}
	throw new Error(`${[...waiting].join(", ")} did not answer within ${timeoutMs}ms: ${clip(log.slice(-600))}`);
}

// ── Main ─────────────────────────────────────────────────────────────────────

function initScriptFor(o) {
	const parts = [];
	if (o.storage.length)
		parts.push(`try { for (const [k, v] of ${JSON.stringify(o.storage)}) localStorage.setItem(k, v); } catch {}`);
	if (o.init) parts.push(readFileSync(o.init, "utf8"));
	return parts.join("\n");
}

async function main() {
	let o;
	try {
		o = parseArgs(process.argv.slice(2));
	} catch (err) {
		process.stderr.write(`web-check: ${err.message}\n${USAGE}\n`);
		return 2;
	}
	if (o.help || !o.url) {
		process.stderr.write(`${USAGE}\n`);
		return o.help ? 0 : 2;
	}
	const report = new Report();
	const out = { url: redact(o.url), engine: undefined, title: undefined, finalUrl: undefined };
	const shotsDir = path.resolve(o.out ?? ".web-check");
	let exit = 0;
	let engine;
	try {
		if (o.serve) {
			await startServer(o.serve, [...new Set([...o.ready, o.url])], o.readyTimeout);
			out.served = { command: o.serve, ready: [...new Set([...o.ready, o.url])].map(redact) };
		}
		const pw = loadPlaywright(o.project ?? process.cwd());
		try {
			engine = pw ? await playwrightEngine(pw, report) : await cdpEngine(report);
		} catch (err) {
			out.error = `no usable browser: ${err.message}`;
			return finish(out, report, 2, o);
		}
		out.engine = engine.engine;
		out.browser = engine.executable;
		const steps = o.steps ? (await import(pathToFileURL(path.resolve(o.steps)).href)).default : undefined;
		if (o.steps && typeof steps !== "function")
			throw new Error(`${o.steps} must default-export async (page, shot) => {}`);
		const init = initScriptFor(o);
		for (const viewport of o.viewports) {
			const tag = `${viewport.width}x${viewport.height}`;
			const p = await engine.newPage(viewport, init);
			const shot = async (name = "page", opts = {}) => {
				mkdirSync(shotsDir, { recursive: true });
				if (!existsSync(path.join(shotsDir, ".gitignore"))) writeFileSync(path.join(shotsDir, ".gitignore"), "*\n");
				const file = path.join(shotsDir, `${String(name).replace(/[^\w.-]+/g, "-")}-${tag}.png`);
				await p.shot(file, opts.fullPage ?? o.fullPage);
				report.shots.push({ path: file, viewport: tag });
				return file;
			};
			try {
				await p.goto(o.url, o.timeout);
			} catch (err) {
				out.error = `load failed at ${tag}: ${clip(err.message)}`;
				exit = 1;
				report.closing = true;
				await p.close();
				report.closing = false;
				break;
			}
			if (o.waitFor)
				try {
					await p.waitForText(o.waitFor, o.timeout);
				} catch (err) {
					out.error = `wait-for failed at ${tag}: ${clip(String(err.message).split("\n")[0])}`;
					exit = 1;
				}
			else {
				// A single-page app answers "load" before it renders; wait for any body text.
				const end = Date.now() + o.timeout;
				while (Date.now() < end && (await Promise.resolve(p.contentLength()).catch(() => 0)) === 0)
					await new Promise((r) => setTimeout(r, 250));
			}
			if (o.wait > 0) await new Promise((r) => setTimeout(r, o.wait));
			if (steps)
				try {
					const value = await steps(p.page, shot);
					if (value !== undefined) {
						out.stepResults ??= {};
						out.stepResults[tag] = value;
					}
				} catch (err) {
					out.error = `step failed at ${tag}: ${clip(err.message)}`;
					exit = 1;
				}
			if (o.shot) await shot("page");
			if (o.text) {
				out.text ??= {};
				try {
					out.text[tag] = String(await p.text(o.text)).slice(0, 2000);
				} catch (err) {
					out.text[tag] = `(no text for ${o.text}: ${clip(err.message)})`;
				}
			}
			if ((await Promise.resolve(p.contentLength()).catch(() => 0)) === 0) {
				out.blank = true;
				out.hint = `the page rendered no text at ${tag} within ${o.timeout}ms: a render error (see console and exceptions), a server that is not up, or a slow first load (raise --timeout or pass --wait-for)`;
			}
			out.title = await Promise.resolve(p.title()).catch(() => undefined);
			out.finalUrl = redact(await Promise.resolve(p.url()).catch(() => o.url));
			report.closing = true;
			await p.close().catch(() => {});
			report.closing = false;
			if (exit !== 0) break;
		}
	} catch (err) {
		out.error = clip(err.message);
		exit = 1;
	} finally {
		await engine?.close().catch(() => {});
		stopServer();
	}
	if (exit === 0 && o.strict) {
		const errors = [...report.console.values()].filter((c) => c.level === "error").length;
		if (errors + report.exceptions.length + report.failed.size > 0) exit = 1;
	}
	return finish(out, report, exit, o);
}

function finish(out, report, exit, o) {
	const json = {
		...out,
		console: [...report.console.values()],
		exceptions: report.exceptions,
		failedRequests: [...report.failed.values()],
		...(report.aborted ? { abortedRequests: report.aborted } : {}),
		shots: report.shots,
		...(report.dropped ? { dropped: report.dropped } : {}),
		...(o?.strict ? { strict: true } : {}),
		exit,
	};
	return new Promise((resolve) => process.stdout.write(`${JSON.stringify(json, null, 1)}\n`, () => resolve(exit)));
}

main().then(
	(code) => process.exit(code),
	(err) => {
		process.stderr.write(`web-check: ${err?.stack ?? err}\n`);
		stopServer();
		process.exit(1);
	},
);
