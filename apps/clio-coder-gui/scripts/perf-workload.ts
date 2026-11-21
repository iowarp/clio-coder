// Measure streamed Markdown, code, tools and diagrams in a private production client.
// Reports observed frame intervals, input and paint latency, long tasks, DOM and heap
// growth; checks that streaming preserves the draft and scroll position. With --check it
// exits 1 when a behavior that must hold does not (see `regressions`); timings stay figures.

import { mkdir, writeFile } from "node:fs/promises";
import { cpus, loadavg, totalmem } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { chromium, type Page } from "playwright-core";
import { harness } from "../tests/harness/app.js";
import { seedSettings } from "../tests/harness/settings-fixture.js";
import { fixtureLaunch } from "./fixture-launch.js";

const { values } = parseArgs({
	options: {
		client: { type: "string" },
		out: { type: "string", default: "perf" },
		label: { type: "string", default: "run" },
		turns: { type: "string", default: "3" },
		// 0 streams the 6.7 KB reference answer; a larger value extends it to at least that many bytes.
		bytes: { type: "string", default: "0" },
		chrome: { type: "string", default: "/usr/bin/google-chrome" },
		headed: { type: "boolean", default: false },
		// N > 0 measures resuming a saved N-turn conversation instead of streaming turns.
		history: { type: "string", default: "0" },
		// With --history, then press "Show N earlier turns" until the whole conversation is open.
		"page-back": { type: "boolean", default: false },
		// Record a Chrome performance trace per streamed turn (and of the resume), for DevTools or Perfetto.
		trace: { type: "boolean", default: false },
		// Fail the run on a behavioral regression, for CI. Never on a timing: those vary by machine.
		check: { type: "boolean", default: false },
	},
});
if (!values.client) throw new Error("--client <private build> is required.");
const TURNS = Math.max(2, Number(values.turns));
const BYTES = Number(values.bytes);
const WORKLOAD = BYTES > 0 ? `[workload ${BYTES}]` : "[workload]";
const HISTORY = Math.max(0, Number(values.history));
const TYPED = "Typing a follow-up question while Clio Coder is still streaming.";

/** Installed before any app script so the record clock and the render counters exist from the start. */
const INSTRUMENTATION = `(() => {
	// tsx keeps function names through a __name helper the page lacks, and evaluated callbacks call it.
	globalThis.__name ??= (target) => target;
	const WINDOW_FROM = 100;
	globalThis.__clioRenderCounts = {};
	const perf = {
		running: false, longTasks: [], frames: [], keystrokes: [], keystrokePaint: [], latencies: [],
		textEvents: 0, firstTextAt: 0, lastTextAt: 0, pendingTextAt: undefined, heap: [], windowCounts: null, lastCounts: null,
		reset() {
			this.longTasks = []; this.frames = []; this.keystrokes = []; this.keystrokePaint = []; this.latencies = [];
			this.textEvents = 0; this.firstTextAt = 0; this.lastTextAt = 0; this.pendingTextAt = undefined;
			this.heap = []; this.windowCounts = null; this.lastCounts = null;
		},
	};
	globalThis.__perf = perf;
	new PerformanceObserver((list) => {
		for (const entry of list.getEntries()) perf.longTasks.push({ start: entry.startTime, duration: entry.duration });
	}).observe({ type: "longtask", buffered: true });
	let last = performance.now();
	const tick = (now) => {
		if (perf.running) perf.frames.push(now - last);
		last = now;
		requestAnimationFrame(tick);
	};
	requestAnimationFrame(tick);
	// An input is paired with the keydown that typed its character, so a key that inserts nothing
	// cannot lend its timestamp to a later input.
	let keydown = null;
	document.addEventListener("keydown", (event) => { keydown = { at: performance.now(), key: event.key }; }, true);
	document.addEventListener("input", (event) => {
		if (keydown === null || event.data !== keydown.key) return;
		const started = keydown.at;
		keydown = null;
		perf.keystrokes.push(performance.now() - started);
		requestAnimationFrame(() => perf.keystrokePaint.push(performance.now() - started));
	}, true);
	const add = EventSource.prototype.addEventListener;
	EventSource.prototype.addEventListener = function (type, listener, options) {
		if (type !== "turn.text") return add.call(this, type, listener, options);
		return add.call(this, type, function (event) {
			const now = performance.now();
			if (perf.running) {
				perf.textEvents += 1;
				if (perf.firstTextAt === 0) perf.firstTextAt = now;
				// The send's own renders (draft acknowledged, turn started, queue read) land in the first
				// ~50 ms; the window opens at the 100th delta so it holds only what deltas cause.
				if (perf.textEvents === WINDOW_FROM) perf.windowCounts = { ...globalThis.__clioRenderCounts };
				perf.lastTextAt = now;
				perf.lastCounts = { ...globalThis.__clioRenderCounts };
				if (perf.pendingTextAt === undefined) perf.pendingTextAt = now;
			}
			return listener.call(this, event);
		}, options);
	};
	const observer = new MutationObserver(() => {
		if (perf.pendingTextAt === undefined) return;
		const started = perf.pendingTextAt;
		perf.pendingTextAt = undefined;
		requestAnimationFrame(() => perf.latencies.push(performance.now() - started));
	});
	document.addEventListener("DOMContentLoaded", () => {
		observer.observe(document.body, { childList: true, subtree: true, characterData: true });
	});
	setInterval(() => { if (perf.running && performance.memory) perf.heap.push(performance.memory.usedJSHeapSize); }, 250);
})();`;

interface Sample {
	longTasks: Array<{ start: number; duration: number }>;
	frames: number[];
	keystrokes: number[];
	keystrokePaint: number[];
	latencies: number[];
	textEvents: number;
	firstTextAt: number;
	lastTextAt: number;
	heap: number[];
	counts: Record<string, number>;
	windowCounts: Record<string, number> | null;
	lastCounts: Record<string, number> | null;
	domNodes: number;
}

const round = (value: number) => Number(value.toFixed(1));
function percentile(values: readonly number[], fraction: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))] ?? 0;
}
const summary = (values: readonly number[]) => ({
	count: values.length,
	p50: round(percentile(values, 0.5)),
	p95: round(percentile(values, 0.95)),
	max: round(values.length ? Math.max(...values) : 0),
});

const sample = (page: Page) =>
	page.evaluate(() => {
		const perf = (globalThis as unknown as { __perf: Omit<Sample, "counts" | "domNodes"> }).__perf;
		return {
			longTasks: perf.longTasks,
			frames: perf.frames,
			keystrokes: perf.keystrokes,
			keystrokePaint: perf.keystrokePaint,
			latencies: perf.latencies,
			textEvents: perf.textEvents,
			firstTextAt: perf.firstTextAt,
			lastTextAt: perf.lastTextAt,
			heap: perf.heap,
			windowCounts: perf.windowCounts,
			lastCounts: perf.lastCounts,
			counts: { ...(globalThis as unknown as { __clioRenderCounts: Record<string, number> }).__clioRenderCounts },
			domNodes: document.getElementsByTagName("*").length,
		};
	});
class Done extends Error {}
/**
 * Resume a saved conversation the fixture replays as HISTORY rich turns, then report how long the
 * page took to show its last turn, and what the open transcript costs at rest.
 */
/** With --trace, a Chrome performance trace of `run`, saved beside the report as `<label>-<name>.trace.json`. */
async function traced<T>(page: Page, name: string, run: () => Promise<T>): Promise<T> {
	if (!values.trace) return run();
	await browser.startTracing(page, { path: join(values.out, `${values.label}-${name}.trace.json`), screenshots: false });
	try {
		return await run();
	} finally {
		await browser.stopTracing();
	}
}
/** What a launch link carries after `#`: a fresh single-use ticket, as clio-coder gui prints it. */
function launch() {
	return fixtureLaunch(origin);
}
async function resumeHistory(page: Page, id: string) {
	await page.goto(`${origin}/#${await launch()}`);
	await page.getByPlaceholder("Describe a task or ask a question").waitFor();
	await setRunning(page, true);
	const started = await page.evaluate(() => performance.now());
	const shownMs = await traced(page, "history", async () => {
		await page.evaluate((path) => {
			history.pushState(null, "", path);
			dispatchEvent(new PopStateEvent("popstate"));
		}, `/sessions/${id}`);
		await page.getByText(`Earlier prompt ${HISTORY}:`, { exact: false }).waitFor({ timeout: 60_000 });
		const shown = (await page.evaluate(() => performance.now())) - started;
		await page.waitForTimeout(1_500);
		return shown;
	});
	const settled = await sample(page);
	const transcript = page.locator(".chat-transcript");
	// Scroll back through the transcript a screen at a time, as a reader does.
	await setRunning(page, true);
	for (let step = 0; step < 30; step++) {
		await transcript.evaluate((element) => {
			element.dispatchEvent(new WheelEvent("wheel", { deltaY: -element.clientHeight, bubbles: true }));
			element.scrollTop = Math.max(0, element.scrollTop - element.clientHeight);
		});
		await page.waitForTimeout(80);
	}
	const scrolled = await sample(page);
	await setRunning(page, false);
	const paged = values["page-back"] ? await traced(page, "page-back", () => pageBack(page)) : null;
	return {
		turns: HISTORY,
		lastTurnShownMs: Math.round(shownMs),
		renderedTurns: await page.locator(".chat-turn").count(),
		domNodes: settled.domNodes,
		heapMb: round(Math.max(0, ...settled.heap) / 2 ** 20),
		longTasksOver50: settled.longTasks.filter((task) => task.duration > 50).length,
		longestTaskMs: round(Math.max(0, ...settled.longTasks.map((task) => task.duration))),
		settledTurnRenders: settled.counts["turn.settled"] ?? 0,
		scrollBack: {
			frameIntervalMs: summary(scrolled.frames),
			longTasksOver50: scrolled.longTasks.filter((task) => task.duration > 50).length,
			domNodes: scrolled.domNodes,
		},
		...(paged ? { pageBack: paged } : {}),
	};
}
/**
 * Open the rest of a resumed conversation a page at a time. Each press is timed to the frame that
 * first shows earlier turns (`durationMs`) and to the frame that shows the whole page (`pageMs`).
 */
async function pageBack(page: Page) {
	const more = page.getByRole("button", { name: /Show \d+ earlier turns/u });
	const presses: Array<{
		renderedTurns: number;
		durationMs: number;
		pageMs: number;
		longTasksOver50: number;
		longestTaskMs: number;
	}> = [];
	for (let press = 0; press < 100 && (await more.count()) > 0; press++) {
		await setRunning(page, true);
		const timing = await more.evaluate(
			(button) =>
				new Promise<{ first: number; page: number }>((resolve) => {
					const count = () => document.querySelectorAll(".chat-turn").length;
					const from = count();
					const wanted = from + Number(/\d+/u.exec(button.textContent ?? "")?.[0] ?? 1);
					const started = performance.now();
					let first = -1;
					(button as HTMLElement).click();
					const check = () => {
						const now = performance.now();
						if (first < 0 && count() > from) first = now - started;
						if (count() >= wanted) requestAnimationFrame(() => resolve({ first, page: performance.now() - started }));
						else if (now - started > 10_000) resolve({ first, page: -1 });
						else requestAnimationFrame(check);
					};
					requestAnimationFrame(check);
				}),
		);
		await page.waitForTimeout(300);
		const pressed = await sample(page);
		await setRunning(page, false);
		presses.push({
			renderedTurns: await page.locator(".chat-turn").count(),
			durationMs: round(timing.first),
			pageMs: round(timing.page),
			longTasksOver50: pressed.longTasks.filter((task) => task.duration > 50).length,
			longestTaskMs: round(Math.max(0, ...pressed.longTasks.map((task) => task.duration))),
		});
	}
	const opened = await sample(page);
	return {
		presses,
		complete: (await more.count()) === 0,
		renderedTurns: await page.locator(".chat-turn").count(),
		domNodes: opened.domNodes,
	};
}
const setRunning = (page: Page, running: boolean) =>
	page.evaluate((flag) => {
		const perf = (globalThis as unknown as { __perf: { running: boolean; reset(): void } }).__perf;
		if (flag) perf.reset();
		perf.running = flag;
	}, running);
await mkdir(values.out, { recursive: true });
let origin = "http://127.0.0.1:4317";
// `--route` settings and a healthy target, so the composer carries a reported route as it does for real.
const h = await harness(
	{},
	{
		scenario: "markdown",
		clientDir: values.client,
		origin: () => origin,
		env: {
			CLIO_CODER_WEB_FIXTURE_ROUTE: "1",
			...(HISTORY > 0 ? { CLIO_CODER_WEB_FIXTURE_REPLAY_TURNS: String(HISTORY) } : {}),
		},
	},
);
// A saved connection, or the app opens the setup wizard instead of the home composer.
await seedSettings(h.home.path, h.home.env);
const project = join(h.home.path, "atlas-field-study");
await mkdir(join(project, "analysis"), { recursive: true });
await writeFile(join(project, "analysis", "convergence-notes.md"), "mesh convergence\n");
const workspace = (await (await h.post("/api/workspaces", { path: project })).json()) as { id?: string };
if (!workspace.id) throw new Error(`The fixture workspace did not open: ${JSON.stringify(workspace)}`);
// Loaded before the listener takes its own origin, which the harness's requests would no longer match.
const HISTORY_ID = "perf-history";
if (HISTORY > 0) {
	const loaded = await h.post(`/api/sessions/${HISTORY_ID}/load`, { workspaceId: workspace.id });
	if (!loaded.ok) throw new Error(`The saved conversation did not load: ${loaded.status} ${await loaded.text()}`);
}
const server = serve({ fetch: h.app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise<void>((resolve) => server.on("listening", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("The perf server has no address.");
origin = `http://127.0.0.1:${address.port}`;

const browser = await chromium.launch({
	executablePath: values.chrome,
	headless: !values.headed,
	args: ["--enable-precise-memory-info", "--disable-background-timer-throttling"],
});
const errors: string[] = [];
const report: Record<string, unknown> = {
	environment: {
		label: values.label,
		workloadBytes: BYTES,
		recordedAt: new Date().toISOString(),
		node: process.version,
		chrome: browser.version(),
		headless: !values.headed,
		cpu: cpus()[0]?.model,
		logicalCpus: cpus().length,
		memoryGb: Math.round(totalmem() / 2 ** 30),
		loadAverage: loadavg().map(round),
		viewport: "1600x1100",
		colorScheme: "dark",
		client: values.client,
	},
};
try {
	const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, colorScheme: "dark" });
	await context.addInitScript(INSTRUMENTATION);
	const page = await context.newPage();
	page.setDefaultTimeout(30_000);
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	if (HISTORY > 0) {
		report.history = await resumeHistory(page, HISTORY_ID);
		await page.screenshot({ path: join(values.out, `${values.label}-history.png`) });
		await context.close();
		throw new Done();
	}
	// A task starts from the home composer; its first, plain turn settles before measuring begins.
	await page.goto(`${origin}/#${await launch()}`);
	const home = page.getByPlaceholder("Describe a task or ask a question");
	await home.fill("Ready when you are.");
	await home.press("Enter");
	await page.waitForURL(/\/sessions\/[^/]+$/);
	const composer = page.getByLabel("Message CLIO Coder", { exact: true });
	await composer.waitFor();
	// A CSS match, not a role query: Playwright polls this for the whole turn, and a role query walks
	// the accessibility of every node in a 200 KB transcript, which showed up as the page's own long tasks.
	const stop = page.locator('button[aria-label="Stop turn"]');
	await stop.waitFor({ state: "detached" });
	await page.waitForTimeout(500);
	const working = page.locator('.wb-chip--status[data-tone="working"]');
	const turns: unknown[] = [];
	for (let turn = 1; turn <= TURNS; turn += 1) {
		const quiet = turn === 1;
		const before = await sample(page);
		await setRunning(page, true);
		const started = performance.now();
		let scroll: Record<string, unknown> | null = null;
		await traced(page, `turn${turn}`, async () => {
			await composer.fill(`${WORKLOAD} Audit the convergence notes, turn ${turn}.`);
			await page.locator(".composer__submit").click();
			await working.waitFor();
			if (!quiet) {
				await page.waitForTimeout(700);
				await composer.click();
				await page.keyboard.type(TYPED, { delay: 35 });
				const transcript = page.locator(".chat-transcript");
				const held = await transcript.evaluate((element) => {
					// The reader's wheel, so follow-latest reads the move as leaving rather than as a layout clamp.
					element.dispatchEvent(new WheelEvent("wheel", { deltaY: -element.clientHeight, bubbles: true }));
					element.scrollTop = Math.max(0, element.scrollHeight / 2 - 300);
					return element.scrollTop;
				});
				await page.waitForTimeout(1_200);
				const after = await transcript.evaluate((element) => element.scrollTop);
				scroll = {
					held,
					after,
					stayedPut: Math.abs(after - held) < 2,
					jumpPill: (await page.locator(".jump-to-latest").count()) > 0,
				};
			}
			await stop.waitFor({ state: "detached", timeout: 120_000 });
		});
		const durationMs = performance.now() - started;
		// Diagrams render once the turn settles and only near the viewport (600px). A turn that held the view
		// elsewhere leaves its diagram pending by design, so it is brought into view and timed from there.
		const turnElement = page.locator(".chat-turn").last();
		const drawn = turnElement.locator(".diagram.is-rendered svg");
		const settledAt = performance.now();
		// Two frames let follow-latest pin to the settled height before the edge is read.
		const transcriptBox = page.locator(".chat-transcript");
		const pinnedAfterSettle = await transcriptBox.evaluate(
			(element) =>
				new Promise<boolean>((resolve) =>
					requestAnimationFrame(() =>
						requestAnimationFrame(() => resolve(element.scrollTop + element.clientHeight >= element.scrollHeight - 2)),
					),
				),
		);
		const renderedAtSettle = (await drawn.count()) > 0;
		const diagram = turnElement.locator(".diagram").first();
		const nearAtSettle =
			renderedAtSettle ||
			(await diagram.evaluate((node) => {
				const box = node.getBoundingClientRect();
				return box.bottom > -600 && box.top < innerHeight + 600;
			}));
		let scrolledAt: number | null = null;
		if (!nearAtSettle) {
			await diagram.scrollIntoViewIfNeeded();
			scrolledAt = performance.now();
		}
		await drawn.first().waitFor();
		const diagramsAt = performance.now();
		await page.waitForTimeout(1_000);
		await setRunning(page, false);
		const after = await sample(page);
		const draft = await composer.inputValue();
		const during = after.longTasks.filter((task) => task.start <= after.lastTextAt).map((task) => task.duration);
		const later = after.longTasks.filter((task) => task.start > after.lastTextAt).map((task) => task.duration);
		const delta = (name: string, from: Record<string, number> | null, to: Record<string, number> | null) =>
			(to?.[name] ?? 0) - (from?.[name] ?? 0);
		turns.push({
			turn,
			quiet,
			durationMs: Math.round(durationMs),
			// Null when the diagram had to be scrolled into view; then `diagram.drawnAfterScrollMs` times it.
			diagramsDrawnMs: scrolledAt === null ? Math.round(diagramsAt - started - durationMs) : null,
			diagram: {
				renderedAtSettle,
				scrolledIntoView: scrolledAt !== null,
				drawnAfterScrollMs: scrolledAt === null ? null : Math.round(diagramsAt - scrolledAt),
				settleToDrawnMs: Math.round(diagramsAt - settledAt),
			},
			textEvents: after.textEvents,
			streamMs: Math.round(after.lastTextAt - after.firstTextAt),
			domNodes: { before: before.domNodes, after: after.domNodes },
			heapPeakMb: round(Math.max(0, ...after.heap) / 2 ** 20),
			longTasks: {
				over50DuringStream: during.filter((value) => value > 50).length,
				longestDuringStream: round(Math.max(0, ...during)),
				over50AfterStream: later.filter((value) => value > 50).length,
				longestAfterStream: round(Math.max(0, ...later)),
			},
			frameIntervalMs: {
				...summary(after.frames),
				// An interval past 1.5 times the median is at least one frame the compositor did not get.
				missed: after.frames.filter((value) => value > 1.5 * percentile(after.frames, 0.5)).length,
			},
			keystrokeToInputMs: summary(after.keystrokes),
			keystrokeToNextFrameMs: summary(after.keystrokePaint),
			textEventToPaintMs: summary(after.latencies),
			// Renders between the 100th and the last text event. In the quiet turn nothing but a streamed
			// delta, a tool event or the one-second clock can cause one.
			rendersDuringStream: {
				composer: delta("composer", after.windowCounts, after.lastCounts),
				settledTurn: delta("turn.settled", after.windowCounts, after.lastCounts),
				liveTurn: delta("turn.live", after.windowCounts, after.lastCounts),
			},
			rendersWholeTurn: {
				composer: delta("composer", before.counts, after.counts),
				settledTurn: delta("turn.settled", before.counts, after.counts),
				liveTurn: delta("turn.live", before.counts, after.counts),
			},
			...(quiet ? { pinnedAfterSettle } : { draftKept: draft === TYPED, scroll }),
		});
		await composer.fill("");
		await page.locator(".chat-transcript").evaluate((element) => {
			element.scrollTop = element.scrollHeight;
		});
		await page.waitForTimeout(500);
	}
	report.turns = turns;
	// The whole answer of the last turn as the server holds it, and whether the page shows it cut.
	const sessionId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1) ?? "");
	const snapshot = h.supervisor.get(sessionId);
	const lastTurnId = snapshot.turns.at(-1)?.id;
	const answer = snapshot.timeline.filter((item) => item.turnId === lastTurnId && item.kind === "text");
	report.lastTurnText = {
		length: answer.reduce((sum, item) => sum + item.text.length, 0),
		truncated: answer.some((item) => item.text.endsWith("[… stream truncated …]")),
		truncatedInGui: (await page.locator(".chat-turn").last().getByText("[… stream truncated …]").count()) > 0,
	};
	await page.screenshot({ path: join(values.out, `${values.label}-end.png`) });
	await context.close();
} catch (error) {
	if (!(error instanceof Done)) throw error;
} finally {
	await browser.close();
	if ("closeAllConnections" in server) server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await h.close();
}
report.errors = errors;
report.regressions = regressions(report);
const file = join(values.out, `${values.label}.json`);
await writeFile(file, `${JSON.stringify(report, null, "\t")}\n`);
console.log(JSON.stringify(report, null, 2));
console.log(`Wrote ${file}`);
if (values.check && (report.regressions as string[]).length > 0) {
	console.error(`[perf] ${(report.regressions as string[]).length} regression(s):`);
	for (const line of report.regressions as string[]) console.error(`  - ${line}`);
	process.exitCode = 1;
}

/**
 * What must hold whatever the machine: no page error, a streamed turn keeps the typed draft and the place the
 * reader scrolled to, a quiet turn stays pinned to the live edge, the answer arrives whole, and a resumed
 * conversation shows its newest turn. Frame, input and paint figures are reported, never judged here.
 */
function regressions(measured: Record<string, unknown>): string[] {
	const found = (measured.errors as string[]).map((error) => `page error: ${error}`);
	const history = measured.history as { renderedTurns: number } | undefined;
	if (HISTORY > 0) {
		if (!history || history.renderedTurns < 1) found.push("the resumed conversation rendered no turn");
		return found;
	}
	const turns = (measured.turns ?? []) as Array<{
		turn: number;
		quiet: boolean;
		pinnedAfterSettle?: boolean;
		draftKept?: boolean;
		scroll?: { stayedPut: boolean } | null;
	}>;
	if (turns.length !== TURNS) found.push(`measured ${turns.length} of ${TURNS} turns`);
	for (const turn of turns) {
		if (turn.quiet && turn.pinnedAfterSettle !== true)
			found.push(`turn ${turn.turn} left the live edge after it settled`);
		if (!turn.quiet && turn.draftKept !== true) found.push(`turn ${turn.turn} lost the draft typed while it streamed`);
		if (!turn.quiet && turn.scroll?.stayedPut !== true)
			found.push(`turn ${turn.turn} moved the reader's scroll position`);
	}
	const text = measured.lastTurnText as { truncated: boolean; truncatedInGui: boolean } | undefined;
	if (!text) found.push("the last answer was not read back");
	else if (text.truncatedInGui && !text.truncated)
		found.push("the page shows the last answer cut though the server holds it whole");
	return found;
}
