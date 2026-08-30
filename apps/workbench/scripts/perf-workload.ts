/**
 * Reproducible rendering workload for the Clio Coder GUI.
 *
 * Runs the real server against the deterministic ACP fixture's `stream-workload`
 * scenario and drives a headless Chrome through: a sustained fast Markdown
 * stream with bursty tool events, typing in the composer while output arrives,
 * manual transcript scrolling while output arrives, a second turn on top of the
 * existing transcript, and resuming a 64-turn session. It records long tasks,
 * frame gaps, keystroke latency, event-to-paint latency, DOM growth, JS heap,
 * and a category breakdown from a Chrome trace, then writes one JSON report.
 *
 *   deno run -A scripts/perf-workload.ts --label=before [--dist=dist] [--pace-ms=4] [--turns=2]
 *
 * Headless Chrome paints at 60 Hz, so frame numbers here bound the work per
 * frame; they do not prove 120 Hz or 144 Hz behavior on a real display.
 */

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright-core";
import type { AcpLaunchSpec } from "../acp-client.ts";
import type { ClioLauncher } from "../clio-host.ts";
import { startWorkbenchServer } from "../main.ts";

interface Options {
	readonly chrome: string;
	readonly label: string;
	readonly dist: string;
	readonly paceMs: number;
	readonly turns: number;
	readonly out: string;
}

function parseOptions(arguments_: readonly string[]): Options {
	const options = {
		chrome: "/usr/bin/google-chrome",
		label: "run",
		dist: "dist",
		paceMs: 4,
		turns: 2,
		out: ".artifacts/perf",
	};
	for (const argument of arguments_) {
		const [key, value] = argument.split("=", 2);
		if (value === undefined) throw new Error(`Unknown perf argument: ${argument}`);
		switch (key) {
			case "--chrome":
				options.chrome = value;
				break;
			case "--label":
				options.label = value;
				break;
			case "--dist":
				options.dist = value;
				break;
			case "--pace-ms":
				options.paceMs = Number(value);
				break;
			case "--turns":
				options.turns = Number(value);
				break;
			case "--out":
				options.out = value;
				break;
			default:
				throw new Error(`Unknown perf argument: ${argument}`);
		}
	}
	return options;
}

const FIXTURE = fileURLToPath(new URL("../tests/acp-child-fixture.ts", import.meta.url));

function fixtureLauncher(scenario: string, extra: readonly string[] = []): ClioLauncher {
	return {
		launch(trustedRoot: string): AcpLaunchSpec {
			return {
				command: Deno.execPath(),
				args: ["run", "--quiet", "--no-config", FIXTURE, `--scenario=${scenario}`, ...extra],
				cwd: trustedRoot,
				clearEnv: true,
				terminationScope: Deno.build.os === "windows" ? "direct-child" : "posix-process-group",
				redact: [trustedRoot],
			};
		},
	};
}

function percentile(values: readonly number[], fraction: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
	return sorted[index] ?? 0;
}

function summarize(values: readonly number[]) {
	return {
		count: values.length,
		p50: Number(percentile(values, 0.5).toFixed(2)),
		p95: Number(percentile(values, 0.95).toFixed(2)),
		max: Number((values.length === 0 ? 0 : Math.max(...values)).toFixed(2)),
		total: Number(values.reduce((sum, value) => sum + value, 0).toFixed(1)),
	};
}

/** Installed before the app script runs so the WebSocket receipt clock is exact. */
const INSTRUMENTATION = `(() => {
	const perf = {
		longTasks: [], frames: [], keystrokes: [], keystrokePaint: [], events: [], latencies: [],
		wsMessages: 0, wsTextEvents: 0, mutations: 0, heap: [], pendingTextAt: undefined, running: false,
		reset() {
			this.longTasks = []; this.frames = []; this.keystrokes = []; this.keystrokePaint = []; this.events = [];
			this.latencies = []; this.wsMessages = 0; this.wsTextEvents = 0; this.mutations = 0; this.heap = [];
			this.pendingTextAt = undefined;
		},
	};
	globalThis.__perf = perf;
	new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) perf.longTasks.push(Math.round(entry.duration));
	}).observe({ type: "longtask", buffered: true });
	try {
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				perf.events.push({ name: entry.name, duration: Math.round(entry.duration) });
			}
		}).observe({ type: "event", durationThreshold: 16 });
	} catch {}
	let last = performance.now();
	const tick = (now) => {
		if (perf.running) perf.frames.push(now - last);
		last = now;
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
	let keydownAt = 0;
	document.addEventListener("keydown", () => { keydownAt = performance.now(); }, true);
	document.addEventListener("input", () => {
		if (keydownAt === 0) return;
		const started = keydownAt;
		keydownAt = 0;
		perf.keystrokes.push(performance.now() - started);
		requestAnimationFrame(() => perf.keystrokePaint.push(performance.now() - started));
	}, true);
	const originalAdd = WebSocket.prototype.addEventListener;
	WebSocket.prototype.addEventListener = function (type, listener, options) {
		if (type !== "message") return originalAdd.call(this, type, listener, options);
		const wrapped = function (event) {
			perf.wsMessages += 1;
			if (typeof event.data === "string" && event.data.includes('"kind":"turn.text"')) {
				perf.wsTextEvents += 1;
				if (perf.pendingTextAt === undefined) perf.pendingTextAt = performance.now();
			}
			return listener.call(this, event);
		};
		return originalAdd.call(this, type, wrapped, options);
	};
	const observer = new MutationObserver(() => {
		perf.mutations += 1;
		if (perf.pendingTextAt === undefined) return;
		const started = perf.pendingTextAt;
		perf.pendingTextAt = undefined;
		requestAnimationFrame(() => perf.latencies.push(performance.now() - started));
	});
	document.addEventListener("DOMContentLoaded", () => {
		observer.observe(document.body, { childList: true, subtree: true, characterData: true });
	});
	setInterval(() => {
		if (perf.running && performance.memory) perf.heap.push(performance.memory.usedJSHeapSize);
	}, 250);
})();`;

interface TraceSummary {
	readonly byName: Record<string, { count: number; totalMs: number; maxMs: number }>;
	readonly tasksOver50: number;
	readonly tasksOver16: number;
	readonly longestTaskMs: number;
}

const TRACE_NAMES = new Set([
	"RunTask",
	"FunctionCall",
	"EvaluateScript",
	"UpdateLayoutTree",
	"Layout",
	"PrePaint",
	"Paint",
	"Commit",
	"HitTest",
	"MinorGC",
	"MajorGC",
	"EventDispatch",
	"TimerFire",
	"UpdateLayerTree",
]);

function summarizeTrace(buffer: Uint8Array): TraceSummary {
	const parsed = JSON.parse(new TextDecoder().decode(buffer)) as {
		traceEvents?: Array<{ name?: string; ph?: string; dur?: number }>;
	};
	const events = parsed.traceEvents ?? [];
	const byName: Record<string, { count: number; totalMs: number; maxMs: number }> = {};
	let tasksOver50 = 0;
	let tasksOver16 = 0;
	let longestTaskMs = 0;
	for (const event of events) {
		if (event.ph !== "X" || typeof event.dur !== "number" || event.name === undefined) continue;
		if (!TRACE_NAMES.has(event.name)) continue;
		const ms = event.dur / 1000;
		const bucket = byName[event.name] ??= { count: 0, totalMs: 0, maxMs: 0 };
		bucket.count += 1;
		bucket.totalMs += ms;
		if (ms > bucket.maxMs) bucket.maxMs = ms;
		if (event.name === "RunTask") {
			if (ms > 50) tasksOver50 += 1;
			if (ms > 16.7) tasksOver16 += 1;
			if (ms > longestTaskMs) longestTaskMs = ms;
		}
	}
	for (const bucket of Object.values(byName)) {
		bucket.totalMs = Number(bucket.totalMs.toFixed(1));
		bucket.maxMs = Number(bucket.maxMs.toFixed(1));
	}
	return { byName, tasksOver50, tasksOver16, longestTaskMs: Number(longestTaskMs.toFixed(1)) };
}

async function collect(page: Page) {
	return await page.evaluate(() => {
		const perf = (globalThis as unknown as { __perf: Record<string, unknown> }).__perf;
		const heap = perf.heap as number[];
		return {
			longTasks: perf.longTasks as number[],
			frames: perf.frames as number[],
			keystrokes: perf.keystrokes as number[],
			keystrokePaint: perf.keystrokePaint as number[],
			events: perf.events as Array<{ name: string; duration: number }>,
			latencies: perf.latencies as number[],
			wsMessages: perf.wsMessages as number,
			wsTextEvents: perf.wsTextEvents as number,
			mutations: perf.mutations as number,
			heapPeak: heap.length === 0 ? 0 : Math.max(...heap),
			heapNow: (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0,
			domNodes: document.getElementsByTagName("*").length,
		};
	});
}

async function setRunning(page: Page, running: boolean): Promise<void> {
	await page.evaluate((flag) => {
		const perf = (globalThis as unknown as { __perf: { running: boolean; reset(): void } }).__perf;
		if (flag) perf.reset();
		perf.running = flag;
	}, running);
}

async function waitIdle(page: Page, timeout: number): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const operation = await page.locator(".status-bar__operation strong").textContent().catch(() => "");
		if ((operation ?? "").trim() === "idle") return;
		if (Deno.env.get("PERF_DEBUG")) console.error(`waiting: ${operation?.replace(/\s+/gu, " ")}`);
		await page.waitForTimeout(100);
	}
	throw new Error("The turn did not settle in time.");
}

const options = parseOptions(Deno.args);
const distRoot = new URL(`../${options.dist.replace(/\/?$/u, "/")}`, import.meta.url);
const outDirectory = new URL(`../${options.out.replace(/\/?$/u, "/")}`, import.meta.url);
await Deno.mkdir(outDirectory, { recursive: true });

const scratchRoot = await Deno.makeTempDir({ prefix: "workbench-perf-" });
const homePath = join(scratchRoot, "home");
const projectRoot = join(homePath, "code", "atlas-field-study");
await Deno.mkdir(join(projectRoot, "analysis"), { recursive: true });
await Deno.writeTextFile(join(projectRoot, "analysis", "convergence-notes.md"), "mesh convergence\n");

const environment = {
	label: options.label,
	dist: options.dist,
	paceMs: options.paceMs,
	turns: options.turns,
	deno: Deno.version.deno,
	chrome: options.chrome,
	cpus: navigator.hardwareConcurrency,
	loadAverage: Deno.loadavg().map((value) => Number(value.toFixed(2))),
	headless: true,
	viewport: "1600x1100",
	recordedAt: new Date().toISOString(),
};

const server = await startWorkbenchServer({
	port: 0,
	quiet: true,
	mode: "browser",
	distRoot,
	stateDir: join(scratchRoot, "state"),
	homePath,
	clioLauncher: fixtureLauncher("stream-workload", [`--pace-ms=${options.paceMs}`]),
	acpTiming: { permissionTimeoutMs: 120_000, cancelGraceMs: 2_000, closeTimeoutMs: 1_000, exitGraceMs: 1_000 },
});

const browser = await chromium.launch({
	executablePath: options.chrome,
	headless: true,
	args: ["--enable-precise-memory-info", "--disable-background-timer-throttling"],
});
const pageErrors: string[] = [];
const report: Record<string, unknown> = { environment };

try {
	const context = await browser.newContext({
		viewport: { width: 1600, height: 1100 },
		colorScheme: "dark",
		deviceScaleFactor: 1,
	});
	await context.addInitScript(INSTRUMENTATION);
	const page = await context.newPage();
	page.on("pageerror", (error) => pageErrors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") pageErrors.push(message.text());
	});
	const chromeVersion = browser.version();
	(report.environment as Record<string, unknown>).chromeVersion = chromeVersion;

	await page.goto(server.url, { waitUntil: "networkidle" });
	await page.getByText("connected", { exact: true }).waitFor();
	await page.locator("input[name=projectPath]").fill(projectRoot);
	await page.getByRole("button", { name: "Open", exact: true }).click();
	await page.getByRole("heading", { level: 1, name: "atlas-field-study" }).waitFor();
	await page.waitForTimeout(500);

	const composer = page.getByRole("textbox", { name: "Prompt for Clio Coder" });
	const turnReports: unknown[] = [];
	for (let turn = 1; turn <= options.turns; turn += 1) {
		const before = await collect(page);
		await setRunning(page, true);
		await browser.startTracing(page, {
			categories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "toplevel"],
		});
		const startedAt = performance.now();
		await composer.fill(`Run the workload, turn ${turn}.`);
		await page.getByRole("button", { name: "Send" }).click();

		// Type while the stream is arriving, then scroll away from the bottom and
		// hold there while more output lands.
		await page.waitForTimeout(700);
		await composer.click();
		await page.keyboard.type("Typing a follow-up question while Clio Coder is still streaming.", { delay: 35 });
		const scroll = page.locator(".conversation__scroll");
		const scrollHeightBefore = await scroll.evaluate((element) => element.scrollHeight);
		await scroll.evaluate((element) => {
			element.scrollTop = Math.max(0, element.scrollHeight / 2 - 300);
		});
		const heldScrollTop = await scroll.evaluate((element) => element.scrollTop);
		await page.waitForTimeout(1_200);
		const scrollTopAfterHold = await scroll.evaluate((element) => element.scrollTop);
		const scrollHeightAfterHold = await scroll.evaluate((element) => element.scrollHeight);
		const jumpAffordance = await page.locator(".jump-to-latest, [data-jump-to-latest]").count();

		await waitIdle(page, 120_000);
		const durationMs = performance.now() - startedAt;
		const trace = await browser.stopTracing();
		await setRunning(page, false);
		const after = await collect(page);
		const draft = await composer.inputValue();

		const traceSummary = summarizeTrace(trace);
		turnReports.push({
			turn,
			durationMs: Number(durationMs.toFixed(0)),
			wsMessages: after.wsMessages,
			wsTextEvents: after.wsTextEvents,
			domMutations: after.mutations,
			domNodesBefore: before.domNodes,
			domNodesAfter: after.domNodes,
			heapPeakMb: Number((after.heapPeak / 1_048_576).toFixed(1)),
			heapAfterMb: Number((after.heapNow / 1_048_576).toFixed(1)),
			longTasks: {
				...summarize(after.longTasks),
				over50: after.longTasks.filter((value) => value > 50).length,
				over100: after.longTasks.filter((value) => value > 100).length,
			},
			frames: {
				...summarize(after.frames),
				over16_7: after.frames.filter((value) => value > 16.7).length,
				over33: after.frames.filter((value) => value > 33.4).length,
				over50: after.frames.filter((value) => value > 50).length,
			},
			keystrokeToInputMs: summarize(after.keystrokes),
			keystrokeToNextFrameMs: summarize(after.keystrokePaint),
			slowInputEvents: {
				count: after.events.length,
				over100: after.events.filter((event) => event.duration > 100).length,
				max: after.events.reduce((maximum, event) => Math.max(maximum, event.duration), 0),
			},
			textEventToPaintMs: summarize(after.latencies),
			draftPreserved: draft === "Typing a follow-up question while Clio Coder is still streaming.",
			scrollHold: {
				scrollHeightBefore,
				scrollHeightAfterHold,
				heldScrollTop,
				scrollTopAfterHold,
				stayedPut: Math.abs(scrollTopAfterHold - heldScrollTop) < 2,
				jumpAffordanceVisible: jumpAffordance > 0,
			},
			trace: traceSummary,
		});
		await composer.fill("");
		await page.waitForTimeout(400);
	}
	report.streamTurns = turnReports;
	await page.screenshot({ path: new URL(`${options.label}-stream-end.png`, outDirectory).pathname });

	// Long existing session: resume 64 replayed turns.
	const resumeScratch = await Deno.makeTempDir({ prefix: "workbench-perf-resume-" });
	const resumeHome = join(resumeScratch, "home");
	const resumeProject = join(resumeHome, "code", "resumable");
	await Deno.mkdir(resumeProject, { recursive: true });
	await Deno.writeTextFile(join(resumeProject, "notes.md"), "resumable project\n");
	const resumeServer = await startWorkbenchServer({
		port: 0,
		quiet: true,
		mode: "browser",
		distRoot,
		stateDir: join(resumeScratch, "state"),
		homePath: resumeHome,
		clioLauncher: fixtureLauncher("resume-64-turns"),
		acpTiming: { permissionTimeoutMs: 120_000, cancelGraceMs: 2_000, closeTimeoutMs: 1_000, exitGraceMs: 1_000 },
	});
	try {
		const resumePage = await context.newPage();
		resumePage.on("pageerror", (error) => pageErrors.push(error.message));
		await resumePage.goto(resumeServer.url, { waitUntil: "networkidle" });
		await resumePage.getByText("connected", { exact: true }).waitFor();
		await resumePage.locator("input[name=projectPath]").fill(resumeProject);
		await resumePage.getByRole("button", { name: "Open", exact: true }).click();
		await resumePage.getByRole("heading", { level: 1, name: "resumable" }).waitFor();
		const row = resumePage.locator(".session-row").first();
		await row.getByRole("button", { name: "Resume" }).waitFor();
		const before = await collect(resumePage);
		await setRunning(resumePage, true);
		const startedAt = performance.now();
		await row.getByRole("button", { name: "Resume" }).click();
		await resumePage.waitForFunction(
			() =>
				(document.querySelector(".status-bar__session")?.textContent ?? "").includes("stub") ||
				document.querySelectorAll("[data-turn], .timeline-card--request, .chat-turn").length >= 64,
			undefined,
			{ timeout: 60_000, polling: 50 },
		);
		await resumePage.waitForTimeout(800);
		const loadMs = performance.now() - startedAt - 800;
		await setRunning(resumePage, false);
		const after = await collect(resumePage);
		report.resume64 = {
			loadMs: Number(loadMs.toFixed(0)),
			domNodesBefore: before.domNodes,
			domNodesAfter: after.domNodes,
			longTasks: {
				...summarize(after.longTasks),
				over50: after.longTasks.filter((value) => value > 50).length,
			},
			frames: { ...summarize(after.frames), over33: after.frames.filter((value) => value > 33.4).length },
			heapAfterMb: Number((after.heapNow / 1_048_576).toFixed(1)),
		};
		await resumePage.screenshot({ path: new URL(`${options.label}-resume-64.png`, outDirectory).pathname });
		await resumePage.close();
	} finally {
		await resumeServer.close();
	}
} finally {
	await browser.close();
	await server.close();
}

report.pageErrors = pageErrors;
const outPath = new URL(`${options.label}.json`, outDirectory);
await Deno.writeTextFile(outPath, `${JSON.stringify(report, null, "\t")}\n`);
console.log(JSON.stringify(report, null, 2));
console.log(`\nWrote ${fileURLToPath(outPath)}`);
