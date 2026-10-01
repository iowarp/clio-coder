#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const site = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(site, "../apps/clio-coder-gui/package.json"));
const { chromium } = require("playwright-core");
const { default: AxeBuilder } = require("@axe-core/playwright");
const { values } = parseArgs({
	options: {
		url: { type: "string", default: "http://localhost:4173" },
		review: { type: "boolean", default: false },
		out: { type: "string", default: "/tmp/clio-site-review" },
		chrome: {
			type: "string",
			default: process.env.CLIO_CODER_CHROME ?? "/home/akougkas/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
		},
	},
});
const out = resolve(values.out);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: values.chrome, headless: true });
const results = [];
const failures = [];
const brand = JSON.parse(await readFile(join(site, "design-system.json"), "utf8"));
const catalog = JSON.parse(await readFile(join(site, "public-docs.json"), "utf8"));
const docs = catalog.map((item) =>
	item.path === "README.md" ? "/docs.html" : `/docs/${item.path.replace(/\.md$/, ".html")}`,
);
const primary = [
	"/",
	"/docs.html",
	"/learn.html",
	"/tutorials/first-session.html",
	"/tutorials/desktop-and-terminal.html",
	"/tutorials/temperature-calibration.html",
	// --review checks a preview built with --review, which adds the draft guides.
	...(values.review
		? JSON.parse(await readFile(join(site, "content/drafts/review-catalog.json"), "utf8")).articles.map(
				(item) => item.proposedRoute,
			)
		: []),
];
const cases = [
	...["dark", "light"].flatMap((theme) =>
		[320, 390, 768, 850, 1024, 1440].flatMap((width) => primary.map((path) => ({ path, theme, width }))),
	),
	...["dark", "light"].flatMap((theme) =>
		docs.filter((path) => path !== "/docs.html").map((path) => ({ path, theme, width: 1440 })),
	),
];
try {
	for (const { path, theme, width } of cases) {
		const context = await browser.newContext({
			viewport: { width, height: 960 },
			colorScheme: theme,
			reducedMotion: "reduce",
		});
		const page = await context.newPage();
		const errors = [];
		page.on("pageerror", (error) => errors.push(error.message));
		page.on("response", (response) => {
			if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
		});
		page.on("console", (message) => {
			if (message.type() === "error") errors.push(message.text());
		});
		try {
			const response = await page.goto(`${values.url}${path}?theme=${theme}&__static=1`, { waitUntil: "load" });
			assert.equal(response.status(), 200);
			await page.evaluate(() => document.fonts.ready);
			const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
			assert.equal(overflow, false, `Horizontal overflow at ${width}px`);
			assert.equal(await page.locator("main h1").count(), 1, "One main heading");
			assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
			const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
			assert.deepEqual(
				axe.violations.map((v) => ({
					id: v.id,
					nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary })),
				})),
				[],
				"Accessibility violations",
			);
			assert.deepEqual(errors, [], "Browser errors");
			if ([390, 1440].includes(width) && primary.includes(path)) {
				// Load all actual captures for a complete export, including those below the fold.
				await page.evaluate(() => {
					for (const img of document.images) if (img.hasAttribute("src")) img.loading = "eager";
				});
				await page.waitForFunction(
					() => [...document.images].filter((img) => img.hasAttribute("src")).every((img) => img.complete),
					null,
					{ timeout: 10000 },
				);
				assert.equal(
					await page.evaluate(() =>
						[...document.images].filter((img) => img.hasAttribute("src")).every((img) => img.naturalWidth > 0),
					),
					true,
					"Product images loaded",
				);
				const name = path === "/" ? "overview" : path.replace(/^\//, "").replaceAll("/", "-").replace(".html", "");
				await page.screenshot({ path: join(out, `${name}-${width}-${theme}.png`), fullPage: true });
			}
			results.push({ path, theme, width, pass: true });
		} catch (error) {
			failures.push({ path, theme, width, error: error.message });
		}
		await context.close();
		if ((results.length + failures.length) % 10 === 0)
			console.log(`Browser layouts passed: ${results.length}; failures: ${failures.length}; total: ${cases.length}`);
	}
	const context = await browser.newContext({
		viewport: { width: 390, height: 844 },
		permissions: ["clipboard-read", "clipboard-write"],
	});
	const page = await context.newPage();
	await page.goto(values.url);
	await page.locator(".nav-more summary").click();
	assert.equal(await page.locator(".nav-more").getAttribute("open"), "");
	await page.keyboard.press("Escape");
	assert.equal(await page.locator(".nav-more").getAttribute("open"), null);
	assert.equal(await page.locator(".nav-more summary").evaluate((el) => el === document.activeElement), true);
	const initial = await page.locator("html").getAttribute("data-theme");
	await page.locator("[data-theme-toggle]").click();
	await page.reload();
	assert.notEqual(await page.locator("html").getAttribute("data-theme"), initial, "Theme preference persists");
	await page.locator("#start").scrollIntoViewIfNeeded();
	await page.locator("#start .code-block .copy").first().click();
	assert.equal(
		await page.evaluate(() => navigator.clipboard.readText()),
		"curl -fsSL https://coder.iowarp.ai/install.sh | sh",
	);
	await page.goto(`${values.url}/docs.html`);
	await page.locator(".docs-menu > summary").click();
	await page.locator("#doc-search").fill("model");
	await page.waitForFunction(() => document.querySelectorAll("#search-hits a").length > 0);
	assert.ok(await page.locator("#search-hits").innerText());
	await page.locator("#doc-search").fill("zzzz-no-such-topic");
	await page.waitForFunction(() => document.querySelector("#search-status")?.textContent.includes("No matching"));
	await page.goto(`${values.url}/docs.html?d=guide/tool-usage.md`);
	await page.waitForURL("**/docs/guide/tool-usage.html");
	await page.goto(`${values.url}/start.html`);
	await page.waitForURL("**/#start");
	const missing = await page.goto(`${values.url}/does-not-exist`);
	assert.equal(missing.status(), 404);
	assert.match(await page.locator("h1").innerText(), /back/);
	await page.goto(`${values.url}/?__static=1`);
	const copied = page.locator("#start .code-block .copy").first();
	await copied.click();
	await copied.click();
	await expectCopyReset();
	async function expectCopyReset() {
		await page.waitForFunction(() => document.querySelector("#start .code-block .copy")?.textContent === "Copy");
		assert.equal(await copied.getAttribute("data-copy-state"), null, "Repeated copying restores the normal state");
	}
	await page.locator(".faq-items summary").first().click();
	assert.equal(await page.locator(".faq-items details").first().getAttribute("open"), "");
	await page.locator(".faq-items summary").first().click();
	assert.equal(await page.locator(".faq-items details").first().getAttribute("open"), null);
	await page.locator(".nav-more summary").click();
	await page.locator(".nav-more a").last().focus();
	await page.keyboard.press("Tab");
	await page.waitForFunction(() => !document.querySelector(".nav-more").open);
	await page.locator(".capture-link").click();
	await page.waitForFunction(
		() =>
			document.querySelector(".media-dialog img").complete && document.querySelector(".media-dialog img").naturalWidth > 0,
	);
	assert.equal(await page.locator(".media-dialog").evaluate((el) => el.open), true);
	const dialogAxe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
	assert.deepEqual(dialogAxe.violations, [], "Accessible screenshot dialog");
	await page.locator('[data-media="next"]').click();
	assert.match(await page.locator("#media-caption").innerText(), /terminal at start/);
	await page.locator('[data-media="zoom"]').click();
	await page.waitForFunction(() => {
		const viewport = document.querySelector(".image-view");
		return viewport.scrollWidth > viewport.clientWidth;
	});
	assert.equal(await page.locator('[data-media="zoom"]').getAttribute("aria-pressed"), "true");
	await page.locator('[data-media="zoom"]').click();
	await page.keyboard.press("ArrowRight");
	assert.match(await page.locator("#media-caption").innerText(), /Clio Coder desktop/);
	await page.keyboard.press("ArrowRight");
	assert.match(await page.locator("#media-caption").innerText(), /through verify/);
	await page.keyboard.press("Escape");
	assert.equal(await page.locator(".media-dialog").evaluate((el) => el.open), false);
	assert.equal(
		await page.locator(".capture-link").evaluate((el) => el === document.activeElement),
		true,
		"Viewer returns focus",
	);
	await page.goto(`${values.url}/docs.html?__static=1`);
	await page.locator(".docs-menu > summary").click();
	await page.locator("#doc-search").fill("model");
	await page.waitForFunction(() => document.querySelectorAll("#search-hits a").length > 0);
	await page.keyboard.press("ArrowDown");
	assert.equal(
		await page
			.locator("#search-hits a")
			.first()
			.evaluate((el) => el === document.activeElement),
		true,
	);
	await page.keyboard.press("ArrowUp");
	assert.equal(await page.locator("#doc-search").evaluate((el) => el === document.activeElement), true);
	await page.keyboard.press("Escape");
	assert.equal(await page.locator("#doc-search").inputValue(), "");
	assert.equal(await page.locator("#search-hits a").count(), 0);
	await page
		.locator("#doc h2")
		.last()
		.evaluate((el) => el.scrollIntoView({ block: "start", behavior: "instant" }));
	await page.waitForFunction(() => {
		const last = document.querySelector("#doc h2:last-of-type");
		return document.querySelector(`.doc-toc-mobile a[href="#${last.id}"]`)?.getAttribute("aria-current") === "location";
	});
	await page.goto(`${values.url}/start.html?theme=light`);
	assert.equal(new URL(page.url()).search, "?theme=light", "Redirect preserves the query before its fragment");
	assert.equal(new URL(page.url()).hash, "#start");
	await context.close();
	const motionContext = await browser.newContext({
		viewport: { width: 1024, height: 768 },
		reducedMotion: "no-preference",
		hasTouch: true,
	});
	const motionPage = await motionContext.newPage();
	await motionPage.goto(`${values.url}/?__static=1`);
	assert.ok(await motionPage.locator('[data-reveal="pending"]').count(), "Below-fold elements have an entrance state");
	await motionPage.locator("#project").scrollIntoViewIfNeeded();
	await motionPage.waitForFunction(() => document.querySelector("#project").dataset.reveal === "visible");
	await motionPage.emulateMedia({ reducedMotion: "reduce" });
	await motionPage.waitForFunction(() => !document.querySelector('[data-reveal="pending"]'));
	assert.equal(await motionPage.locator(".hero-stage").evaluate((el) => getComputedStyle(el).animationName), "none");
	await motionPage.setViewportSize({ width: 768, height: 1024 });
	assert.equal(
		await motionPage.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),
		false,
		"Touch tablet orientation fits",
	);
	await motionPage.locator(".capture-link").tap();
	await motionPage.waitForFunction(() => document.querySelector(".media-dialog img").complete);
	await motionPage.screenshot({ path: join(out, "screenshot-viewer-tablet.png") });
	await motionPage.locator(".media-close").tap();
	await motionContext.close();
	const themeContext = await browser.newContext({ colorScheme: "light", viewport: { width: 390, height: 844 } });
	const themePage = await themeContext.newPage();
	await themePage.goto(`${values.url}/?__static=1`);
	const expectedDefault = brand.defaultTheme === "system" ? "light" : brand.defaultTheme;
	assert.equal(
		await themePage.locator("html").getAttribute("data-theme"),
		expectedDefault,
		"First visit uses the configured default",
	);
	await themePage.emulateMedia({ colorScheme: "dark" });
	await themePage.emulateMedia({ colorScheme: "light" });
	await themePage.waitForFunction((expected) => document.documentElement.dataset.theme === expected, expectedDefault);
	const savedTheme = expectedDefault === "dark" ? "light" : "dark";
	await themePage.locator("[data-theme-toggle]").click();
	await themePage.reload();
	assert.equal(
		await themePage.locator("html").getAttribute("data-theme"),
		savedTheme,
		"Saved visitor preference beats the default",
	);
	await themePage.goto(`${values.url}/?theme=dark&__static=1`);
	assert.equal(
		await themePage.locator("html").getAttribute("data-theme"),
		"dark",
		"Explicit URL theme wins for the visit",
	);
	await themePage.goto(`${values.url}/docs.html?__static=1`);
	assert.equal(
		await themePage.locator("html").getAttribute("data-theme"),
		savedTheme,
		"URL override preserves the saved choice",
	);
	await themeContext.close();
	const plain = await browser.newContext({
		javaScriptEnabled: false,
		colorScheme: "light",
		viewport: { width: 390, height: 844 },
	});
	const plainPage = await plain.newPage();
	await plainPage.goto(`${values.url}/docs.html`);
	assert.equal(
		await plainPage.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--paper").trim()),
		brand.palette[brand.themes[expectedDefault].paper],
		"No-JavaScript CSS uses the configured default",
	);
	assert.ok((await plainPage.locator("#doc").innerText()).includes("install.sh"));
	if ((await plainPage.locator(".docs-menu").getAttribute("open")) === null)
		await plainPage.locator(".docs-menu > summary").click();
	await plainPage
		.locator(".doc-nav-group")
		.first()
		.evaluate((el) => {
			el.open = true;
		});
	assert.ok(await plainPage.locator("#all-docs a").first().isVisible());
	await plainPage.goto(values.url);
	await plainPage.locator(".nav-more summary").click();
	assert.ok(await plainPage.locator(".nav-more a").first().isVisible());
	await plain.close();
	console.log(
		"Interactions passed: menu keyboard, theme persistence, repeated copying, FAQ, screenshot viewer, search keyboard, active contents, redirects, runtime reduced motion, touch tablet rotation, 404, and no-JavaScript navigation.",
	);
} finally {
	await browser.close();
	await writeFile(
		join(out, "browser-results.json"),
		`${JSON.stringify({ passed: results.length, failed: failures.length, results, failures }, null, 2)}\n`,
	);
}
if (failures.length) {
	console.error(JSON.stringify(failures, null, 2));
	process.exitCode = 1;
} else console.log(`All ${results.length} browser layouts passed with no WCAG A/AA violations. Screenshots: ${out}`);
