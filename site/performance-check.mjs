#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const site = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(site, "../apps/clio-coder-gui/package.json"));
const { chromium } = require("playwright-core");
const { values } = parseArgs({
	options: {
		url: { type: "string", default: "http://localhost:4173" },
		out: { type: "string", default: "/tmp/clio-site-review/performance.json" },
		chrome: {
			type: "string",
			default: process.env.CLIO_CODER_CHROME ?? "/home/akougkas/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
		},
		baseline: { type: "boolean", default: false },
	},
});
const browser = await chromium.launch({ executablePath: values.chrome, headless: true });
const results = [];
try {
	for (const path of ["/", "/docs.html", "/learn.html"]) {
		const context = await browser.newContext({
			viewport: { width: 390, height: 844 },
			deviceScaleFactor: 2,
			reducedMotion: "no-preference",
		});
		const page = await context.newPage();
		const session = await context.newCDPSession(page);
		await session.send("Network.enable");
		await session.send("Network.setCacheDisabled", { cacheDisabled: true });
		await session.send("Network.emulateNetworkConditions", {
			offline: false,
			latency: 100,
			downloadThroughput: 250000,
			uploadThroughput: 125000,
		});
		await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
		await page.addInitScript(() => {
			window.__clioPerformance = { lcp: 0, cls: 0 };
			new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) window.__clioPerformance.lcp = entry.startTime;
			}).observe({ type: "largest-contentful-paint", buffered: true });
			new PerformanceObserver((list) => {
				for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__clioPerformance.cls += entry.value;
			}).observe({ type: "layout-shift", buffered: true });
		});
		await page.goto(`${values.url}${path}?__static=1`, { waitUntil: "networkidle" });
		await page.waitForTimeout(1000);
		const metrics = await page.evaluate(() => {
			const resources = performance.getEntriesByType("resource");
			return {
				...window.__clioPerformance,
				fcp: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? 0,
				bytes: resources.reduce((sum, r) => sum + r.transferSize, 0),
				requests: resources.length,
				images: [...document.images]
					.filter((img) => img.complete && img.naturalWidth)
					.map((img) => ({ src: new URL(img.currentSrc).pathname, width: img.naturalWidth })),
				resources: resources.map((r) => ({ path: new URL(r.name).pathname, bytes: r.transferSize, duration: r.duration })),
			};
		});
		results.push({ path, ...metrics });
		console.log(
			`${path}: FCP ${Math.round(metrics.fcp)} ms; LCP ${Math.round(metrics.lcp)} ms; CLS ${metrics.cls.toFixed(4)}; ${(metrics.bytes / 1024).toFixed(1)} KiB in ${metrics.requests} requests`,
		);
		if (!values.baseline) {
			assert.ok(metrics.fcp > 0 && metrics.fcp < 2500, "FCP budget");
			assert.ok(metrics.lcp > 0 && metrics.lcp < 3000, "LCP budget");
			assert.ok(metrics.cls < 0.1, "Layout stability budget");
		}
		await context.close();
	}
} finally {
	await browser.close();
	const out = resolve(values.out);
	await mkdir(dirname(out), { recursive: true });
	await writeFile(
		out,
		`${JSON.stringify(
			{
				conditions:
					"Local dev server, cold cache, 390px at DPR 2, 2 Mbps download, 100ms latency, 4x CPU slowdown. Lab observations; not field Core Web Vitals.",
				results,
			},
			null,
			2,
		)}\n`,
	);
}
