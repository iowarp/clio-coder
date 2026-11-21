/**
 * The browser tool's session driver: a separate Node process, started once per session inside the main-session
 * sandbox, that holds one Playwright browser context and its pages across calls. The host writes one request per
 * line on stdin and reads one reply per line on stdout (./protocol.ts). Nothing else may reach stdout, so every
 * console method is redirected: a script's output goes to its own call's log, the rest to stderr.
 *
 * It imports nothing from Clio but protocol types; `playwright-core` comes from the managed component named in the
 * init message, loaded by absolute path.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { format } from "node:util";
import type {
	BrowserAttachRequest,
	BrowserConsoleRecord,
	BrowserEventDelta,
	BrowserInit,
	BrowserLookRequest,
	BrowserOpenRequest,
	BrowserPageFacts,
	BrowserReply,
	BrowserReplyBody,
	BrowserRequest,
	BrowserRequestRecord,
	BrowserRunRequest,
	BrowserShot,
	BrowserSnapshot,
	BrowserViewport,
} from "./protocol.js";

// biome-ignore lint/suspicious/noExplicitAny: Playwright's objects come from a runtime-loaded module without types here.
type Any = any;

const ACTION_TIMEOUT_MS = 30_000;
const MAX_PAGES = 8;
const MAX_RECORDS = 2_000;
const DELTA_CAP = 20;
const TEXT_CAP = 300;
const SNAPSHOT_CAP_BYTES = 8 * 1024;
const OPEN_SNAPSHOT_LINES = 40;
const VALUE_CAP_BYTES = 8 * 1024;
const LOG_CAP_LINES = 60;
const ACTION_CAP = 60;

const writeOut = process.stdout.write.bind(process.stdout);
const send = (reply: BrowserReply): void => {
	writeOut(`${JSON.stringify(reply)}\n`);
};

interface RunScope {
	logs: string[];
	actions: string[];
	shots: BrowserShot[];
	cancelled: boolean;
	cancel?: () => void;
}
const runScope = new AsyncLocalStorage<RunScope>();

// Redirect every console method: stdout is the protocol lane.
for (const method of ["log", "info", "warn", "error", "debug", "trace", "dir", "table"] as const) {
	(console as unknown as Record<string, (...args: unknown[]) => void>)[method] = (...args: unknown[]) => {
		const scope = runScope.getStore();
		const line = clip(format(...args), 2_000);
		if (scope) {
			if (scope.logs.length < LOG_CAP_LINES) scope.logs.push(method === "log" ? line : `[${method}] ${line}`);
		} else process.stderr.write(`${line}\n`);
	};
}

function clip(text: unknown, cap = TEXT_CAP): string {
	const value = String(text ?? "");
	return value.length > cap ? `${value.slice(0, cap)}…` : value;
}

/** A URL without its query string or fragment, which often carry tokens. */
function redact(raw: string): string {
	try {
		const url = new URL(raw);
		if (url.protocol === "data:") return "data:…";
		return `${url.origin === "null" ? `${url.protocol}//` : url.origin}${url.pathname}${url.search || url.hash ? "?…" : ""}`;
	} catch {
		return String(raw).split(/[?#]/u)[0] ?? "";
	}
}

function isLoopbackHost(host: string): boolean {
	const h = host.replace(/^\[|\]$/gu, "").toLowerCase();
	return (
		h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "0.0.0.0" || /^127(?:\.\d{1,3}){3}$/u.test(h)
	);
}

// ── Records ──────────────────────────────────────────────────────────────────

type EventRecord =
	| { seq: number; page: string; kind: "console"; level: string; text: string; url?: string; line?: number }
	| { seq: number; page: string; kind: "exception"; text: string; url?: string; line?: number }
	| {
			seq: number;
			page: string;
			kind: "request";
			method: string;
			url: string;
			status?: number;
			error?: string;
			resource?: string;
	  };

const records: EventRecord[] = [];
let seq = 0;
let reportedSeq = 0;

type NewRecord = EventRecord extends infer R ? (R extends EventRecord ? Omit<R, "seq"> : never) : never;

function push(record: NewRecord): void {
	records.push({ ...record, seq: ++seq } as EventRecord);
	if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
}

function frameOf(stack: unknown): { url?: string; line?: number } {
	const m = /(https?:\/\/[^\s)]+):(\d+):\d+/u.exec(String(stack ?? ""));
	return m?.[1] !== undefined ? { url: redact(m[1]), line: Number(m[2]) } : {};
}

/** New errors, warnings, exceptions and failed requests since the previous delta, deduplicated with counts. */
function takeDelta(): BrowserEventDelta {
	const consoleMap = new Map<string, BrowserConsoleRecord>();
	const exceptionMap = new Map<string, BrowserConsoleRecord>();
	const requestMap = new Map<string, BrowserRequestRecord>();
	let dropped = 0;
	for (const r of records) {
		if (r.seq <= reportedSeq) continue;
		if (r.kind === "console") {
			if (r.level !== "error" && r.level !== "warning") continue;
			const key = `${r.level}|${r.text}`;
			const hit = consoleMap.get(key);
			if (hit) hit.count++;
			else if (consoleMap.size < DELTA_CAP)
				consoleMap.set(key, {
					level: r.level,
					text: r.text,
					...(r.url ? { url: r.url } : {}),
					...(r.line ? { line: r.line } : {}),
					count: 1,
				});
			else dropped++;
		} else if (r.kind === "exception") {
			const hit = exceptionMap.get(r.text);
			if (hit) hit.count++;
			else if (exceptionMap.size < DELTA_CAP)
				exceptionMap.set(r.text, {
					level: "exception",
					text: r.text,
					...(r.url ? { url: r.url } : {}),
					...(r.line ? { line: r.line } : {}),
					count: 1,
				});
			else dropped++;
		} else if (r.status !== undefined ? r.status >= 400 : r.error !== undefined) {
			const key = `${r.method} ${r.url} ${r.status ?? r.error}`;
			const hit = requestMap.get(key);
			if (hit) hit.count++;
			else if (requestMap.size < DELTA_CAP)
				requestMap.set(key, {
					method: r.method,
					url: r.url,
					...(r.status !== undefined ? { status: r.status } : {}),
					...(r.error !== undefined ? { error: r.error } : {}),
					...(r.resource ? { resource: r.resource } : {}),
					count: 1,
				});
			else dropped++;
		}
	}
	reportedSeq = seq;
	const blocked = [...newlyBlocked];
	newlyBlocked.clear();
	return {
		console: [...consoleMap.values()],
		exceptions: [...exceptionMap.values()],
		failedRequests: [...requestMap.values()],
		dropped,
		...(blocked.length > 0 ? { blockedHosts: blocked } : {}),
	};
}

/** The script's `events()`: buffered records, newest last, filtered. */
function queryEvents(filter: { url?: string; status?: number; level?: string; kind?: string; page?: string } = {}) {
	return records
		.filter((r) => {
			if (filter.page !== undefined && r.page !== filter.page) return false;
			if (filter.kind !== undefined && r.kind !== filter.kind) return false;
			if (filter.level !== undefined && !(r.kind === "console" && r.level === filter.level)) return false;
			if (filter.url !== undefined && !("url" in r && r.url?.includes(filter.url))) return false;
			if (filter.status !== undefined && !(r.kind === "request" && r.status === filter.status)) return false;
			return true;
		})
		.slice(-200)
		.map(({ seq: _seq, ...rest }) => rest);
}

// ── Session state ────────────────────────────────────────────────────────────

let init: BrowserInit | undefined;
let browser: Any;
let context: Any;
let engine = "";
const pages = new Map<string, Any>();
let currentPage: string | undefined;
let nextPage = 1;
let shotCount = 0;
let snapshotCount = 0;
const grantedHosts = new Set<string>();
const blockedHosts = new Set<string>();
/** Hosts the route refused since the last reply, drained into its event delta. */
const newlyBlocked = new Set<string>();
/** The CDP endpoint of a browser someone else started that the session drives instead of its own. */
let attachedTo: string | undefined;
/** An attached browser that went away (the person closed it), named in the next "no page" error. */
let lostAttach: string | undefined;
/** Pages Clio opened in an attached browser; releasing it closes these and leaves the person's own. */
const ownPages = new Set<Any>();

function playwrightChromium(): Promise<Any> {
	if (!init) throw new Error("driver not initialised");
	process.env.PLAYWRIGHT_BROWSERS_PATH = init.browsersPath;
	return import(pathToFileURL(init.playwrightEntry).href).then((playwright) => ({
		chromium: playwright.chromium ?? playwright.default?.chromium,
		version: playwright.default?.version ?? "",
	}));
}

/** Loopback and granted hosts only: a page cannot make the browser reach anything else. */
function routeGranted(route: Any): unknown {
	let host = "";
	try {
		const url = new URL(route.request().url());
		if (url.protocol !== "http:" && url.protocol !== "https:") return route.continue();
		host = url.hostname;
	} catch {
		return route.continue();
	}
	if (isLoopbackHost(host) || grantedHosts.has(host.toLowerCase())) return route.continue();
	blockedHosts.add(host);
	newlyBlocked.add(host.toLowerCase());
	return route.abort("blockedbyclient");
}

async function ensureContext(): Promise<void> {
	if (context) return;
	if (!init) throw new Error("driver not initialised");
	const { chromium, version } = await playwrightChromium();
	try {
		browser = await chromium.launch({
			headless: true,
			...(init.channel ? { channel: init.channel } : {}),
			args: ["--disable-dev-shm-usage"],
		});
	} catch (error) {
		throw new Error(`the browser did not start: ${clip(error instanceof Error ? error.message : error, 600)}`);
	}
	engine = `playwright-core ${version} ${browser.version()}`.replace(/\s+/gu, " ").trim();
	context = await browser.newContext({ viewport: init.viewport });
	context.setDefaultTimeout(ACTION_TIMEOUT_MS);
	context.setDefaultNavigationTimeout(ACTION_TIMEOUT_MS);
	await context.route("**/*", routeGranted);
}

/** Let go of the current browser: an attached one keeps running with the person's pages; the session's own closes. */
async function releaseBrowser(): Promise<void> {
	const [current, currentContext, wasAttached, opened] = [browser, context, attachedTo !== undefined, [...ownPages]];
	browser = undefined;
	context = undefined;
	attachedTo = undefined;
	ownPages.clear();
	pages.clear();
	currentPage = undefined;
	if (wasAttached) {
		for (const page of opened) await page.close().catch(() => {});
		await currentContext?.unroute("**/*", routeGranted).catch(() => {});
	} else await currentContext?.close().catch(() => {});
	// For a browser reached over CDP this only disconnects.
	await current?.close().catch(() => {});
}

function recordConsole(id: string, m: Any): void {
	const level = m.type();
	const text = String(m.text());
	// A failed resource is already a request record.
	if (level === "error" && text.startsWith("Failed to load resource:")) return;
	const loc = m.location?.() ?? {};
	push({
		page: id,
		kind: "console",
		level,
		text: clip(text),
		...(loc.url ? { url: redact(loc.url) } : {}),
		...(loc.lineNumber ? { line: Number(loc.lineNumber) + 1 } : {}),
	});
}

function recordError(id: string, e: Any): void {
	push({ page: id, kind: "exception", text: clip(e?.message ?? e), ...frameOf(e?.stack) });
}

function listen(id: string, page: Any): void {
	page.on("console", (m: Any) => recordConsole(id, m));
	page.on("pageerror", (e: Any) => recordError(id, e));
	page.on("requestfailed", (r: Any) => {
		const errorText = String(r.failure()?.errorText ?? "failed");
		if (errorText === "net::ERR_ABORTED") {
			return;
		}
		let host = "";
		try {
			host = new URL(r.url()).hostname;
		} catch {}
		push({
			page: id,
			kind: "request",
			method: r.method(),
			url: redact(r.url()),
			error:
				errorText.startsWith("net::ERR_BLOCKED_BY_CLIENT") && blockedHosts.has(host)
					? `blocked: ${host} is not granted to this browser session; browser open with allow_hosts ${JSON.stringify([host.toLowerCase()])} admits it`
					: clip(errorText),
			resource: r.resourceType(),
		});
	});
	page.on("response", (r: Any) => {
		push({
			page: id,
			kind: "request",
			method: r.request().method(),
			url: redact(r.url()),
			status: r.status(),
			resource: r.request().resourceType(),
		});
	});
	page.on("close", () => {
		pages.delete(id);
		if (currentPage === id) currentPage = [...pages.keys()].at(-1);
	});
}

function pageFor(id: string | undefined): { id: string; page: Any } {
	const key = id ?? currentPage;
	if (key === undefined)
		throw new Error(
			`no page is open; call browser open with a url, or attach, first${lostAttach ? ` (the attached browser at ${lostAttach} disconnected)` : ""}`,
		);
	const page = pages.get(key);
	if (!page) throw new Error(`no page ${key}; open pages: ${[...pages.keys()].join(", ") || "none"}`);
	currentPage = key;
	return { id: key, page };
}

async function facts(id: string, page: Any, status?: number): Promise<BrowserPageFacts> {
	return {
		page: id,
		url: redact(page.url()),
		title: clip(await page.title().catch(() => ""), 200),
		...(status !== undefined ? { status } : {}),
	};
}

function viewportTag(page: Any): string {
	const v = page.viewportSize?.() as BrowserViewport | null;
	return v ? `${v.width}x${v.height}` : "unknown";
}

async function takeShot(page: Any, name: string, options: { fullPage?: boolean } = {}): Promise<BrowserShot> {
	if (!init) throw new Error("driver not initialised");
	const dir = path.join(init.scratchDir, "shots");
	mkdirSync(dir, { recursive: true });
	const tag = viewportTag(page);
	const file = path.join(
		dir,
		`${String(++shotCount).padStart(3, "0")}-${String(name).replace(/[^\w.-]+/gu, "-")}-${tag}.png`,
	);
	await page.screenshot({ path: file, fullPage: options.fullPage === true });
	return { path: file, viewport: tag };
}

/** Wait briefly for a single-page app to render text after `load`. */
async function settle(page: Any): Promise<void> {
	const end = Date.now() + 5_000;
	while (Date.now() < end) {
		const length = await page.evaluate("document.body?.innerText.trim().length ?? 0").catch(() => 0);
		if (length > 0) return;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}

function capSnapshot(full: string, matches?: number): BrowserSnapshot {
	const lines = full.split("\n");
	if (Buffer.byteLength(full) <= SNAPSHOT_CAP_BYTES)
		return { text: full, lines: lines.length, shownLines: lines.length, ...(matches !== undefined ? { matches } : {}) };
	const shown: string[] = [];
	let bytes = 0;
	for (const line of lines) {
		bytes += Buffer.byteLength(line) + 1;
		if (bytes > SNAPSHOT_CAP_BYTES) break;
		shown.push(line);
	}
	let offloadPath: string | undefined;
	if (init) {
		mkdirSync(init.scratchDir, { recursive: true });
		offloadPath = path.join(init.scratchDir, `snapshot-${++snapshotCount}.yml`);
		writeFileSync(offloadPath, full);
	}
	return {
		text: shown.join("\n"),
		lines: lines.length,
		shownLines: shown.length,
		...(offloadPath !== undefined ? { offloadPath } : {}),
		...(matches !== undefined ? { matches } : {}),
	};
}

/**
 * The rendered accessibility tree in Playwright's AI mode, with `[ref=eN]` refs `page.getByRef` resolves. A target
 * that is a ref or a CSS selector scopes the tree; any other target is a role or text query that returns the matching
 * lines with their refs instead of the tree.
 */
async function snapshotOf(page: Any, target?: string): Promise<BrowserSnapshot> {
	if (target === undefined || target.trim() === "") return capSnapshot(await page.ariaSnapshot({ mode: "ai" }));
	const t = target.trim();
	if (/^e\d+$/u.test(t)) {
		await page.ariaSnapshot({ mode: "ai" });
		return capSnapshot(await page.getByRef(t).ariaSnapshot({ mode: "ai" }));
	}
	if (/^(?:css=|[#.[]|\w+[#.[>:])/u.test(t)) {
		const locator = page.locator(t.replace(/^css=/u, ""));
		if ((await locator.count()) > 0) return capSnapshot(await locator.first().ariaSnapshot({ mode: "ai" }));
	}
	const full: string = await page.ariaSnapshot({ mode: "ai" });
	const needle = t.toLowerCase();
	const hits = full.split("\n").filter((line) => {
		const trimmed = line.trim().replace(/^- /u, "");
		const role = /^[\w-]+/u.exec(trimmed)?.[0]?.toLowerCase();
		return role === needle || trimmed.toLowerCase().includes(needle);
	});
	return capSnapshot(
		hits.length === 0 ? `(no node matches ${JSON.stringify(t)})` : hits.map((line) => line.trim()).join("\n"),
		hits.length,
	);
}

// ── Scripts ──────────────────────────────────────────────────────────────────

const PLAIN = [
	Object.prototype,
	Array.prototype,
	Date.prototype,
	RegExp.prototype,
	Map.prototype,
	Set.prototype,
	Error.prototype,
];
/** Playwright's classes are minified in its bundle, so a class instance (a locator, the keyboard) is told by shape. */
function trackable(value: unknown): value is object {
	if (value === null || typeof value !== "object" || Buffer.isBuffer(value) || value instanceof Promise) return false;
	const proto = Object.getPrototypeOf(value);
	return proto !== null && !PLAIN.includes(proto);
}
const unwrap = new WeakMap<object, object>();

function describeArg(value: unknown): string {
	if (typeof value === "function") return "fn";
	if (value !== null && typeof value === "object" && unwrap.has(value)) return "locator";
	try {
		return clip(JSON.stringify(value), 80);
	} catch {
		return "…";
	}
}

/** Playwright objects behind a proxy that logs each awaited action and refuses new ones once the call is cancelled. */
function track<T extends object>(target: T, label: string, scope: RunScope): T {
	const proxy = new Proxy(target, {
		get(object, prop) {
			const value = Reflect.get(object, prop, object);
			if (typeof prop === "symbol") return value;
			if (typeof value !== "function") {
				return !prop.startsWith("_") && trackable(value) ? track(value, `${label}.${prop}`, scope) : value;
			}
			return (...args: unknown[]) => {
				if (scope.cancelled) throw new Error("cancelled: the browser call was stopped; the pages are kept");
				const real = args.map((arg) =>
					arg !== null && typeof arg === "object" && unwrap.has(arg) ? unwrap.get(arg) : arg,
				);
				const call = `${label}.${prop}(${args.map(describeArg).join(", ")})`;
				const result = value.apply(object, real);
				if (result !== null && typeof result === "object" && typeof result.then === "function") {
					const index = scope.actions.length < ACTION_CAP ? scope.actions.push(`… ${call}`) - 1 : -1;
					return result.then(
						(settled: unknown) => {
							if (index >= 0) scope.actions[index] = `ok ${call}`;
							return settled;
						},
						(error: unknown) => {
							if (index >= 0) scope.actions[index] = `FAILED ${call}`;
							throw error;
						},
					);
				}
				return trackable(result) ? track(result, call, scope) : result;
			};
		},
	});
	unwrap.set(proxy, target);
	return proxy;
}

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
	...args: string[]
) => (...args: unknown[]) => Promise<unknown>;

/** A function expression runs as given; anything else is the body of `async ({ page, ... }) => {}`. */
function compile(script: string): (api: Record<string, unknown>) => Promise<unknown> {
	const trimmed = script.trim();
	if (/^(?:async\s*(?:function\b|\(|[\w$]+\s*=>)|function\b)/u.test(trimmed)) {
		const fn = new AsyncFunction(`return (${trimmed});`);
		return async (api) => {
			const inner = (await fn()) as (api: Record<string, unknown>) => Promise<unknown>;
			if (typeof inner !== "function") throw new Error("the script did not evaluate to a function");
			return inner(api);
		};
	}
	const body = new AsyncFunction("__api", `const { page, context, shot, snapshot, events, pages } = __api;\n${script}`);
	return (api) => body(api);
}

async function loadFile(file: string): Promise<(...args: unknown[]) => Promise<unknown>> {
	if (!init) throw new Error("driver not initialised");
	const resolved = path.resolve(init.workspace, file);
	const module = await import(`${pathToFileURL(resolved).href}?v=${Date.now()}`);
	if (typeof module.default !== "function")
		throw new Error(`${file} must default-export async ({ page, context, shot, snapshot, events }) => value`);
	return module.default;
}

function serializeValue(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	let text: string;
	try {
		text = JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? String(v) : v), 1) ?? String(value);
	} catch {
		text = String(value);
	}
	return Buffer.byteLength(text) > VALUE_CAP_BYTES
		? `${text.slice(0, VALUE_CAP_BYTES)}… (value cut at ${VALUE_CAP_BYTES} bytes; return less)`
		: text;
}

const running = new Map<number, RunScope>();

async function run(request: BrowserRunRequest): Promise<BrowserReply> {
	const { id: pageId, page } = pageFor(request.page);
	const scope: RunScope = { logs: [], actions: [], shots: [], cancelled: false };
	running.set(request.id, scope);
	const trackedPage = track(page, "page", scope);
	const api = {
		page: trackedPage,
		context: track(context, "context", scope),
		shot: async (name = "shot", options: { fullPage?: boolean } = {}) => {
			if (scope.cancelled) throw new Error("cancelled");
			const taken = await takeShot(page, name, options);
			scope.shots.push(taken);
			return taken.path;
		},
		snapshot: async (target?: string) => (await snapshotOf(page, target)).text,
		events: (filter?: Record<string, unknown>) => queryEvents(filter as never),
		pages: () => [...pages.keys()],
	};
	let timer: NodeJS.Timeout | undefined;
	let cancel: (() => void) | undefined;
	const stop = new Promise<"cancelled" | "timeout">((resolve) => {
		cancel = () => resolve("cancelled");
		timer = setTimeout(() => resolve("timeout"), request.timeoutMs);
	});
	if (cancel) scope.cancel = cancel;
	try {
		const work = runScope.run(scope, async () => {
			if (request.file !== undefined) {
				const fn = await loadFile(request.file);
				// A web-check step file takes (page, shot).
				return fn.length >= 2 ? fn(trackedPage, api.shot) : fn(api);
			}
			return compile(request.script ?? "")(api);
		});
		work.catch(() => {});
		const outcome = await Promise.race([work.then((value) => ({ value })), stop]);
		const body: BrowserReplyBody = {
			pageFacts: await facts(pageId, page),
			logs: scope.logs,
			actions: scope.actions,
			shots: scope.shots,
		};
		if (outcome === "cancelled" || outcome === "timeout") {
			scope.cancelled = true;
			return {
				id: request.id,
				ok: false,
				error:
					outcome === "cancelled"
						? "cancelled: the script was stopped; the pages are kept"
						: `timed out after ${request.timeoutMs} ms; the script was stopped and the pages are kept`,
				...(outcome === "cancelled" ? { cancelled: true } : { timedOut: true }),
				...body,
				events: takeDelta(),
			};
		}
		const value = serializeValue(outcome.value);
		return { id: request.id, ok: true, ...body, ...(value !== undefined ? { value } : {}), events: takeDelta() };
	} catch (error) {
		scope.cancelled = true;
		const message = error instanceof Error ? (error.message.split("\n").slice(0, 6).join("\n") ?? "") : String(error);
		return {
			id: request.id,
			ok: false,
			error: clip(message, 1_500),
			pageFacts: await facts(pageId, page),
			logs: scope.logs,
			actions: scope.actions,
			shots: scope.shots,
			events: takeDelta(),
		};
	} finally {
		clearTimeout(timer);
		running.delete(request.id);
	}
}

// ── Operations ───────────────────────────────────────────────────────────────

async function open(request: BrowserOpenRequest): Promise<BrowserReply> {
	await ensureContext();
	for (const host of request.grantHosts ?? []) grantedHosts.add(host.toLowerCase());
	let id = request.page;
	let page: Any;
	// A page id nothing opened yet names the new page, so `open` with page "main" works on the first call.
	if (id !== undefined && pages.has(id)) page = pageFor(id).page;
	else {
		if (pages.size >= MAX_PAGES)
			throw new Error(`${MAX_PAGES} pages are open; close one (browser close with page) or reuse one with page`);
		id = id !== undefined && /^[\w.-]{1,40}$/u.test(id) ? id : `p${nextPage++}`;
		page = await context.newPage();
		if (attachedTo !== undefined) ownPages.add(page);
		pages.set(id, page);
		listen(id, page);
	}
	currentPage = id;
	if (request.viewport) await page.setViewportSize(request.viewport);
	let status: number | undefined;
	let loadError: string | undefined;
	try {
		const response = await page.goto(request.url, { waitUntil: "load" });
		status = response?.status();
		await settle(page);
	} catch (error) {
		loadError = clip(error instanceof Error ? error.message.split("\n")[0] : error, 600);
	}
	const snapshot = await page
		.ariaSnapshot({ mode: "ai" })
		.then((full: string) => {
			const lines = full.split("\n");
			return {
				text: lines.slice(0, OPEN_SNAPSHOT_LINES).join("\n"),
				lines: lines.length,
				shownLines: Math.min(lines.length, OPEN_SNAPSHOT_LINES),
			} satisfies BrowserSnapshot;
		})
		.catch(() => undefined);
	const body: BrowserReplyBody = {
		pageFacts: await facts(id, page, status),
		...(snapshot ? { snapshot } : {}),
		engine,
		events: takeDelta(),
	};
	return loadError !== undefined
		? { id: request.id, ok: false, error: `load failed: ${loadError}`, ...body }
		: { id: request.id, ok: true, ...body };
}

/**
 * A page the attached browser already had. Playwright buffers the console messages and errors the browser replayed
 * when Clio connected, so what the page logged before the attach becomes records too; then it is followed as any page.
 */
async function adopt(page: Any): Promise<string> {
	const id = `p${nextPage++}`;
	pages.set(id, page);
	for (const m of (await page.consoleMessages?.().catch(() => [])) ?? []) recordConsole(id, m);
	for (const e of (await page.pageErrors?.().catch(() => [])) ?? []) recordError(id, e);
	listen(id, page);
	return id;
}

/**
 * Drive the browser behind a CDP endpoint instead of the session's own: its pages become session pages, and `open`
 * makes new tabs in it. Attaching again to the same endpoint picks up tabs opened since; another endpoint, or `open`
 * after the browser went away, lets go of the current one first.
 */
async function attachTo(request: BrowserAttachRequest): Promise<BrowserReply> {
	if (attachedTo !== request.endpoint) {
		await releaseBrowser();
		const { chromium } = await playwrightChromium();
		const hint =
			"The browser must be running with --remote-debugging-port=<port> (a Tauri debug build on Windows: WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9339), and this session must reach that port.";
		// Playwright retries a refused http endpoint until its timeout; one direct probe fails fast instead.
		if (/^https?:/u.test(request.endpoint)) {
			const probe = await fetch(`${request.endpoint}/json/version`, { signal: AbortSignal.timeout(5_000) }).then(
				(response) => (response.ok ? "" : `HTTP ${response.status}`),
				(error: unknown) =>
					String((error as { cause?: { code?: string } })?.cause?.code ?? (error as Error)?.message ?? error),
			);
			if (probe !== "")
				throw new Error(`could not attach to ${request.endpoint}: no DevTools endpoint answers there (${probe}). ${hint}`);
		}
		let connected: Any;
		try {
			connected = await chromium.connectOverCDP(request.endpoint, { timeout: ACTION_TIMEOUT_MS });
		} catch (error) {
			const message = error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);
			throw new Error(`could not attach to ${request.endpoint}: ${clip(message.replace(/\.+$/u, ""), 600)}. ${hint}`);
		}
		const defaultContext = connected.contexts()[0];
		if (!defaultContext) {
			await connected.close().catch(() => {});
			throw new Error(`${request.endpoint} offers no browser context to drive`);
		}
		browser = connected;
		context = defaultContext;
		attachedTo = request.endpoint;
		lostAttach = undefined;
		engine = `attached ${connected.version()}`;
		context.setDefaultTimeout(ACTION_TIMEOUT_MS);
		context.setDefaultNavigationTimeout(ACTION_TIMEOUT_MS);
		// The same reach as the session's own browser while attached; release removes the route again.
		await context.route("**/*", routeGranted);
		connected.on("disconnected", () => {
			if (browser !== connected) return;
			lostAttach = request.endpoint;
			browser = undefined;
			context = undefined;
			attachedTo = undefined;
			ownPages.clear();
			pages.clear();
			currentPage = undefined;
		});
	}
	const known = new Set(pages.values());
	const adopted: string[] = [];
	for (const page of (browser.contexts() as Any[]).flatMap((c: Any) => c.pages() as Any[]))
		if (!known.has(page)) adopted.push(await adopt(page));
	if (currentPage === undefined)
		currentPage =
			adopted.find((key) => !/^(?:about:blank$|chrome:|devtools:)/u.test(pages.get(key)?.url() ?? "")) ?? adopted[0];
	const listed = await Promise.all([...pages.entries()].map(([key, p]) => facts(key, p)));
	const current = listed.find((f) => f.page === currentPage);
	return {
		id: request.id,
		ok: true,
		attached: request.endpoint,
		engine,
		...(current ? { pageFacts: current } : {}),
		pages: listed,
		events: takeDelta(),
	};
}

async function look(request: BrowserLookRequest): Promise<BrowserReply> {
	const { id, page } = pageFor(request.page);
	const body: BrowserReplyBody = { pageFacts: await facts(id, page) };
	if (request.snapshot) body.snapshot = await snapshotOf(page, request.target);
	if (request.screenshot) body.shots = [await takeShot(page, "look", { fullPage: request.fullPage })];
	body.pages = await Promise.all([...pages.entries()].map(([key, p]) => facts(key, p)));
	body.events = takeDelta();
	return { id: request.id, ok: true, ...body };
}

async function shutdown(code: number): Promise<never> {
	await releaseBrowser();
	process.exit(code);
}

async function handle(request: BrowserRequest): Promise<void> {
	if (request.op === "cancel") {
		const scope = running.get(request.target);
		if (scope) {
			scope.cancelled = true;
			scope.cancel?.();
		}
		return;
	}
	try {
		switch (request.op) {
			case "init":
				init = request;
				for (const host of request.grantedHosts) grantedHosts.add(host.toLowerCase());
				send({ id: request.id, ok: true });
				return;
			case "open":
				send(await open(request));
				return;
			case "attach":
				send(await attachTo(request));
				return;
			case "run":
				send(await run(request));
				return;
			case "look":
				send(await look(request));
				return;
			case "close":
				if (request.page !== undefined) {
					const { page } = pageFor(request.page);
					await page.close();
					send({ id: request.id, ok: true, closed: "page", events: takeDelta() });
					return;
				}
				send({ id: request.id, ok: true, closed: "session" });
				await shutdown(0);
		}
	} catch (error) {
		send({
			id: request.id,
			ok: false,
			error: clip(error instanceof Error ? error.message.split("\n").slice(0, 4).join("\n") : error, 1_500),
		});
	}
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
	if (line.trim() === "") return;
	let request: BrowserRequest;
	try {
		request = JSON.parse(line) as BrowserRequest;
	} catch {
		process.stderr.write("browser driver: unreadable request line\n");
		return;
	}
	void handle(request);
});
// The host owns this process: when its pipe closes, the session is over.
input.on("close", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));
