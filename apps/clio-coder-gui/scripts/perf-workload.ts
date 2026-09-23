// Streaming performance against the ACP fixture; DESIGN.md "Streaming cadence" has the budgets and
// the last recorded results. Each turn streams the Markdown workload in
// `tests/fixtures/stream-workload.mjs` (6.7 KB by default, or `--bytes`, in 5-character chunks with a
// 4 ms tick every four chunks and tool bursts between blocks) into a production build in headless
// Chrome, and reports long tasks, animation-frame intervals, keystroke latency, event-to-paint
// latency, DOM and heap growth. It then waits for the turn's two diagrams (one valid, one malformed)
// to settle and keeps measuring for another second, because diagram layout runs after the stream.
// The first turn is quiet: nobody types, so every composer render in its streaming window would have
// been caused by a streamed delta. The later turns type 64 characters into the composer and scroll
// the transcript up while text arrives, then check the draft and the scroll held.
//
//   npx vite build --outDir <scratch>/client-build --emptyOutDir
//   pnpm run perf --client <scratch>/client-build/ --out <scratch>/perf --label now
//   pnpm run perf --client <scratch>/client-build/ --out <scratch>/perf --label now-16k --bytes 16384
//
// Headless Chrome paints at the rate its compositor chooses; the report records the measured
// animation-frame interval rather than assuming one, and never stands for a real 120 Hz display.

import { mkdir, writeFile } from "node:fs/promises";
import { cpus, loadavg, totalmem } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { serve } from "@hono/node-server";
import { chromium, type Page } from "playwright-core";
import { harness } from "../tests/harness/app.js";

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
	},
});
if (!values.client) throw new Error("--client <private build> is required.");
const TURNS = Math.max(2, Number(values.turns));
const BYTES = Number(values.bytes);
const WORKLOAD = BYTES > 0 ? `[workload ${BYTES}]` : "[workload]";
const TYPED = "Typing a follow-up question while Clio Coder is still streaming.";

/** Installed before any app script so the receipt clock and the render counters exist from the start. */
const INSTRUMENTATION = `(() => {
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
		env: { CLIO_CODER_WEB_FIXTURE_ROUTE: "1" },
	},
);
const project = join(h.home.path, "atlas-field-study");
await mkdir(join(project, "analysis"), { recursive: true });
await writeFile(join(project, "analysis", "convergence-notes.md"), "mesh convergence\n");
const workspace = (await (await h.post("/api/workspaces", { path: project })).json()) as { id?: string };
if (!workspace.id) throw new Error(`The fixture workspace did not open: ${JSON.stringify(workspace)}`);
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
	await page.goto(`${origin}/#token=test-token`);
	await page.getByRole("heading", { level: 1 }).waitFor();
	await page.goto(`${origin}/workspaces/${workspace.id}/sessions`);
	await page.getByRole("button", { name: "New conversation", exact: true }).click();
	const composer = page.getByLabel("Message Clio Coder", { exact: true });
	await composer.waitFor();
	await page.waitForTimeout(500);
	const status = page.locator(".session-status");
	const turns: unknown[] = [];
	for (let turn = 1; turn <= TURNS; turn += 1) {
		const quiet = turn === 1;
		const before = await sample(page);
		await setRunning(page, true);
		const started = performance.now();
		await composer.fill(`${WORKLOAD} Audit the convergence notes, turn ${turn}.`);
		await page.locator(".composer__submit").click();
		await status.getByText("Clio Coder is working").waitFor();
		let scroll: Record<string, unknown> | null = null;
		if (!quiet) {
			await page.waitForTimeout(700);
			await composer.click();
			await page.keyboard.type(TYPED, { delay: 35 });
			const transcript = page.locator(".chat-transcript");
			const held = await transcript.evaluate((element) => {
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
		await status.getByText("Ready for your message").waitFor({ timeout: 120_000 });
		const durationMs = performance.now() - started;
		// Diagrams render after the turn settles; a diagram the view followed past counts as near.
		const turnElement = page.locator(".chat-turn").last();
		await turnElement.locator(".diagram.is-rendered svg").waitFor();
		await turnElement.locator(".diagram .diagram__status [role=alert]").waitFor();
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
			diagramsDrawnMs: Math.round(diagramsAt - started - durationMs),
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
			...(quiet ? {} : { draftKept: draft === TYPED, scroll }),
		});
		await composer.fill("");
		await page.locator(".chat-transcript").evaluate((element) => {
			element.scrollTop = element.scrollHeight;
		});
		await page.waitForTimeout(500);
	}
	report.turns = turns;
	await page.screenshot({ path: join(values.out, `${values.label}-end.png`) });
	await context.close();
} finally {
	await browser.close();
	if ("closeAllConnections" in server) server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await h.close();
}
report.errors = errors;
const file = join(values.out, `${values.label}.json`);
await writeFile(file, `${JSON.stringify(report, null, "\t")}\n`);
console.log(JSON.stringify(report, null, 2));
console.log(`Wrote ${file}`);
