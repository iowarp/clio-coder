import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AxeBuilder } from "@axe-core/playwright";
import { serve } from "@hono/node-server";
import { chromium } from "playwright-core";
import { harness } from "../tests/harness/app.js";
import { seedEvidence } from "../tests/harness/evidence-fixture.js";
import { seedFleet } from "../tests/harness/fleet-fixture.js";
import { seedLibrary } from "../tests/harness/library-fixture.js";
import { seedReports } from "../tests/harness/reports-fixture.js";
import { seedSettings } from "../tests/harness/settings-fixture.js";
import { traceFixture } from "../tests/harness/trace-fixture.js";

const { values } = parseArgs({ options: { chrome: { type: "string", default: "/usr/bin/google-chrome" } } });
const output = await mkdtemp(join(tmpdir(), "clio-web-browser-"));
let origin = "http://127.0.0.1:0";
const h = await harness(
	{ installDelayMs: 150 },
	{
		pwa: true,
		scenario: "markdown",
		origin: () => origin,
		clientDir: fileURLToPath(new URL("../dist/client/", import.meta.url)),
	},
);
await seedSettings(h.home.path, h.home.env);
await seedFleet(h.home.path, h.home.env);
await seedEvidence(h.home.path, h.home.env);
const reportsSeed = await seedReports(h.home.path, h.home.env);
await seedLibrary(h.home.path, h.home.env);
const fixture = traceFixture(join(h.home.path, "state"));
fixture.finish();
const server = serve({ fetch: h.app.fetch, hostname: "127.0.0.1", port: 0 });
await new Promise<void>((resolve) => server.on("listening", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium
	.launch({
		executablePath: values.chrome,
		headless: true,
		args: ["--disable-dev-shm-usage"],
	})
	.catch(async (error: unknown) => {
		if ("closeAllConnections" in server) server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		fixture.close();
		await h.close();
		throw error;
	});
const failures: string[] = [],
	errors: string[] = [],
	checks: { page: string; width: number; seriousOrCritical: number; minorOrModerate: string[]; overflow: boolean }[] =
		[];
const statuses: { path: string; status: number }[] = [];
let success = false;
try {
	for (const width of [1600, 1050, 390]) {
		const context = await browser.newContext({ viewport: { width, height: 1050 }, reducedMotion: "reduce" });
		await context.route("**/*", async (route) => {
			const url = new URL(route.request().url());
			if (url.origin === origin) await route.continue();
			else {
				failures.push(`External request: ${url.origin}${url.pathname}`);
				await route.abort();
			}
		});
		const page = await context.newPage();
		page.setDefaultTimeout(15000);
		page.on("pageerror", (error) => errors.push(error.message));
		page.on("requestfailed", (request) => {
			const path = new URL(request.url()).pathname;
			// Closing a tab or leaving a trace intentionally closes its EventSource.
			if (
				request.failure()?.errorText === "net::ERR_ABORTED" &&
				(path === "/api/events" || /^\/api\/traces\/runs\/[^/]+\/live$/.test(path))
			)
				return;
			// The blueprint isolation probe asks the sandbox for the API and expects the content policy to refuse.
			if (request.failure()?.errorText === "net::ERR_BLOCKED_BY_CSP" && path === "/api/meta") return;
			failures.push(`${path}: ${request.failure()?.errorText}`);
		});
		page.on("response", (response) => {
			if (response.status() >= 400) statuses.push({ path: new URL(response.url()).pathname, status: response.status() });
		});
		async function check(name: string, options: { blueprint?: boolean } = {}) {
			await page.evaluate(() => document.fonts.ready);
			// A theme change lands as an attribute first; let the cascade and a paint settle before axe reads colours.
			await page.waitForFunction(
				() =>
					getComputedStyle(document.body).color ===
					(document.documentElement.dataset.theme === "dark" ? "rgb(226, 230, 216)" : "rgb(46, 62, 52)"),
			);
			await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
			// Axe preloads stylesheets with its own XHR; the blueprint sandbox's connect-src refuses that fetch, so
			// blueprint checks skip preloading. Every rule still runs, inside the frame as well.
			const builder = new AxeBuilder({ page });
			if (options.blueprint) builder.options({ preload: false });
			const axe = await builder.analyze();
			const serious = axe.violations.filter((item) => item.impact === "serious" || item.impact === "critical");
			const overflow = await page.evaluate(
				() => document.documentElement.scrollWidth > document.documentElement.clientWidth,
			);
			checks.push({
				page: name,
				width,
				seriousOrCritical: serious.length,
				minorOrModerate: axe.violations
					.filter((item) => item.impact !== "serious" && item.impact !== "critical")
					.map((item) => item.id),
				overflow,
			});
			await writeFile(join(output, `${width}-${name}-axe.json`), JSON.stringify(axe.violations, null, 2));
			assert.deepEqual(
				serious.map((item) => ({
					id: item.id,
					nodes: item.nodes.map((node) => ({ target: node.target, summary: node.failureSummary })),
				})),
				[],
				`${name} at ${width}px`,
			);
			assert.equal(overflow, false, `${name} overflows at ${width}px`);
		}
		async function navigate(label: string) {
			const menu = page.getByRole("button", { name: "Open navigation", exact: true });
			if (await menu.isVisible()) await menu.click();
			await page
				.getByRole("navigation", { name: "Main navigation" })
				.filter({ visible: true })
				.getByRole("link", { name: label, exact: true })
				.click();
		}
		await page.goto(`${origin}/#token=test-token`);
		await page.getByRole("heading", { level: 1 }).waitFor();
		await page.keyboard.press("Tab");
		assert.equal(await page.locator(".skip-link").evaluate((element) => document.activeElement === element), true);
		await page.keyboard.press("Enter");
		assert.equal(await page.locator("#main").evaluate((element) => document.activeElement === element), true);
		assert.equal(await page.locator("footer").count(), 0);
		const header = await page.locator(".masthead").boundingBox();
		assert.ok(header && header.height <= 60);
		assert.equal(
			await page
				.locator(".brand img")
				.first()
				.evaluate((image) => (image as HTMLImageElement).naturalWidth > 0),
			true,
		);
		await page.getByRole("button", { name: "App preferences", exact: true }).click();
		await page.getByText("Install Clio Coder", { exact: true }).click();
		await page.getByRole("button", { name: "Forget this browser" }).waitFor();
		await check("app-preferences");
		await page.keyboard.press("Escape");
		assert.equal(
			await page
				.getByRole("button", { name: "App preferences", exact: true })
				.evaluate((el) => document.activeElement === el),
			true,
		);
		await check("home");
		if (width === 1600) await page.screenshot({ path: join(output, "home.png"), fullPage: true });
		await page.getByRole("button", { name: "Dark theme", exact: true }).click();
		await page.locator(':root[data-theme="dark"]').waitFor();
		await check("home-dark");
		await page.screenshot({ path: join(output, `${width}-home-dark.png`), fullPage: true });
		await page.getByRole("button", { name: "Light theme", exact: true }).click();
		if (width === 390) {
			await page.getByRole("button", { name: "Open navigation", exact: true }).click();
			await check("navigation");
			await page.keyboard.press("Escape");
			assert.equal(
				await page
					.getByRole("button", { name: "Open navigation", exact: true })
					.evaluate((node) => document.activeElement === node),
				true,
			);
		}
		await navigate("Toolchain");
		await page.getByRole("article", { name: "herdr", exact: true }).waitFor();
		await check("toolchain");
		await navigate("Traces");
		await page.locator('a[href="/traces/run-0000"]').waitFor();
		await check("traces");
		await page.locator('a[href="/traces/run-0000"]').click();
		await page.getByRole("heading", { name: "Inspect fixture 0", exact: true }).waitFor();
		await page.getByText("Fixture workspace", { exact: false }).first().waitFor({ state: "attached" });
		await check("trace-run");
		await navigate("Fleet");
		await page.getByRole("heading", { name: "fixture-council", exact: true }).waitFor();
		await check("fleet");
		await page.locator('a[href="/fleet/fleet-149"]').click();
		await page.getByText("Fixture step passed.", { exact: true }).waitFor();
		await page.getByRole("heading", { name: "review · pass", exact: true }).waitFor();
		await check("fleet-run");
		await page.getByRole("button", { name: "Dark theme", exact: true }).click();
		await check("fleet-run-dark");
		await page.goto(`${origin}/evidence`);
		await page.locator('a[href="/evidence/evidence-039"]').waitFor();
		await check("evidence");
		await page.locator('a[href="/evidence/evidence-039"]').click();
		await page.getByRole("heading", { name: "Trust by run", exact: true }).waitFor();
		await check("evidence-detail-dark");
		await page.getByRole("button", { name: "Light theme", exact: true }).click();
		await check("evidence-detail");
		await navigate("Evals");
		await page.locator(`a[href="/evals/${reportsSeed.ids.at(-1)}"]`).waitFor();
		await check("evals");
		await page.locator(`a[href="/evals/${reportsSeed.ids.at(-1)}"]`).click();
		await page.getByRole("heading", { name: "Trials", exact: true }).waitFor();
		await check("eval-detail");
		await navigate("Docs");
		await page.locator(".docs-page .markdown").waitFor();
		await check("docs-map");
		await page.getByLabel("Search the documentation", { exact: true }).fill("trace");
		await page.getByRole("button", { name: "Search docs", exact: true }).click();
		const docResults = page.getByRole("region", { name: "Search results" });
		await docResults.getByRole("link", { name: /Trace Store/i }).click();
		await page.locator(".docs-path").filter({ hasText: "architecture/trace-store.md" }).waitFor();
		await check("docs-page");
		if (width === 1600 || width === 390) {
			// A blueprint is an in-app reading view: same page, sandboxed frame, no popup.
			await page.locator('.docs-page .markdown a[href="/docs/blueprints/trace_blueprint.html"]').click();
			await page.waitForURL(`${origin}/docs/blueprints/trace_blueprint.html`);
			const frameElement = page.locator("iframe.blueprint-frame__document");
			await frameElement.waitFor({ state: "attached" });
			assert.equal(await frameElement.getAttribute("sandbox"), "allow-scripts");
			assert.equal(await frameElement.getAttribute("src"), "/docs-html/trace_blueprint.html?embed=1&theme=light");
			const blueprint = page.frameLocator("iframe.blueprint-frame__document");
			await page.locator(".blueprint-frame.is-ready").waitFor();
			await blueprint.getByRole("button", { name: "Copy code snippet" }).first().waitFor();
			assert.equal(context.pages().length, 1, "Blueprints open in the same page");
			assert.equal(new URL(page.url()).pathname, "/docs/blueprints/trace_blueprint.html");
			await page.getByRole("heading", { name: "Trace store contract", exact: true }).waitFor();
			// Handmade copy, code and drawings survive presentation; only the document's own chrome is hidden.
			await blueprint.locator(".reference-prose h2", { hasText: "Tables" }).waitFor();
			assert.ok(
				(await blueprint.locator("pre code.language-sql").first().innerText()).includes("PRAGMA journal_mode=WAL"),
			);
			assert.equal(await blueprint.locator(".document-header svg").count(), 1);
			assert.equal(await blueprint.locator(".document-header").isVisible(), false);
			assert.equal(await blueprint.locator("a.sidebar-source").isVisible(), false);
			assert.equal(await blueprint.locator('.reference-prose > blockquote[data-clio-self-reference="true"]').count(), 1);
			assert.equal(await blueprint.locator(".reference-prose > blockquote").first().isVisible(), false);
			assert.equal(await blueprint.locator("html").getAttribute("data-theme"), "light");
			assert.equal(
				await blueprint.locator("body").evaluate((body) => getComputedStyle(body).backgroundColor),
				"rgb(238, 232, 216)",
				"Blueprint body follows the application's light palette",
			);
			// The sandbox denies storage and API access, and its origin is opaque.
			const isolation = await blueprint.locator("html").evaluate(async () => {
				let storage = false;
				try {
					sessionStorage.getItem("clio-coder-token");
				} catch {
					storage = true;
				}
				let api = false;
				try {
					await fetch("/api/meta");
				} catch {
					api = true;
				}
				return { storage, api, origin: window.origin };
			});
			assert.deepEqual(isolation, { storage: true, api: true, origin: "null" });
			// Theme changes travel by message: no reload, and the reading position survives.
			await blueprint.locator("html").evaluate(() => {
				(window as unknown as { clioSmokeMarker: number }).clioSmokeMarker = 1;
				window.scrollTo(0, 400);
			});
			assert.equal(
				await blueprint.locator("html").evaluate((html) => getComputedStyle(html).scrollBehavior),
				"auto",
				"Blueprints honor reduced motion",
			);
			assert.equal(await blueprint.locator("html").evaluate(() => Math.round(window.scrollY)), 400);
			await page.getByRole("button", { name: "Dark theme", exact: true }).click();
			await blueprint.locator('html[data-theme="dark"]').waitFor();
			assert.deepEqual(
				await blueprint.locator("html").evaluate(() => ({
					marker: (window as unknown as { clioSmokeMarker?: number }).clioSmokeMarker,
					scrollY: Math.round(window.scrollY),
					background: getComputedStyle(document.body).backgroundColor,
				})),
				{ marker: 1, scrollY: 400, background: "rgb(32, 42, 37)" },
			);
			await check("docs-blueprint-dark", { blueprint: true });
			await page.getByRole("button", { name: "Light theme", exact: true }).click();
			await blueprint.locator('html[data-theme="light"]').waitFor();
			await check("docs-blueprint", { blueprint: true });
			// Messages from a foreign source or with an unsafe destination never move the application.
			await page.evaluate(() => window.postMessage({ type: "clio:blueprint", event: "navigate", href: "/sessions" }, "*"));
			await blueprint.locator("html").evaluate(() => {
				parent.postMessage({ type: "clio:blueprint", event: "navigate", href: "https://example.com/" }, "*");
				parent.postMessage({ type: "clio:blueprint", event: "navigate", href: "/docs/../api/meta" }, "*");
				parent.postMessage({ type: "clio:blueprint", event: "navigate", href: "/docs/%2e%2e/api/meta.md" }, "*");
				parent.postMessage({ type: "clio:blueprint", event: "navigate", href: "/docs/%5c..%5cguide/x.md" }, "*");
				parent.postMessage({ type: "clio:blueprint", event: "navigate", href: "/docs/%zz/guide.md" }, "*");
				parent.postMessage(
					{ type: "clio:blueprint", event: "navigate", href: "/docs/blueprints/%2e%2e%2fescape.html" },
					"*",
				);
				parent.postMessage({ type: "clio:blueprint", event: "navigate", href: "javascript:alert(1)" }, "*");
			});
			await page.waitForTimeout(300);
			assert.equal(new URL(page.url()).pathname, "/docs/blueprints/trace_blueprint.html");
			// External links are refused by the child and surfaced as a plain link; nothing navigates on its own.
			await blueprint.locator("html").evaluate(() => {
				const anchor = document.createElement("a");
				anchor.href = "https://example.com/spec";
				anchor.textContent = "smoke external link";
				document.querySelector(".reference-prose")?.prepend(anchor);
			});
			await blueprint.getByRole("link", { name: "smoke external link" }).click();
			const externalNotice = page.locator(".blueprint-external");
			await externalNotice.waitFor();
			const externalLink = externalNotice.getByRole("link", { name: "https://example.com/spec" });
			assert.equal(await externalLink.getAttribute("target"), "_blank");
			assert.equal(new URL(page.url()).pathname, "/docs/blueprints/trace_blueprint.html");
			assert.equal(context.pages().length, 1);
			assert.equal(
				await blueprint.locator("html").evaluate(() => (window as unknown as { clioSmokeMarker?: number }).clioSmokeMarker),
				1,
				"The child frame did not navigate",
			);
			await externalNotice.getByRole("button", { name: "Dismiss", exact: true }).click();
			// Links inside the blueprint stay in the application, modified clicks included.
			await blueprint.locator(".related-nav a.next").click();
			await page.waitForURL(`${origin}/docs/blueprints/tui_design_blueprint.html`);
			await page.locator(".blueprint-frame.is-ready").waitFor();
			await blueprint.locator(".reference-prose h2", { hasText: "Output styles" }).waitFor();
			await blueprint.locator('.related-nav a[href="trace_blueprint.html"]').click({ modifiers: ["Control"] });
			await page.waitForURL(`${origin}/docs/blueprints/trace_blueprint.html`);
			await page.locator(".blueprint-frame.is-ready").waitFor();
			assert.equal(context.pages().length, 1);
			// A blueprint's relative Markdown link opens the guide in the application.
			await blueprint.locator("html").evaluate(() => {
				const anchor = document.createElement("a");
				anchor.href = "../architecture/trace-store.md";
				anchor.textContent = "smoke guide link";
				document.querySelector(".reference-prose")?.prepend(anchor);
			});
			await blueprint.getByRole("link", { name: "smoke guide link" }).click();
			await page.waitForURL(`${origin}/docs/architecture/trace-store.md`);
			await page.locator(".docs-path").filter({ hasText: "architecture/trace-store.md" }).waitFor();
			// The reading view switch pairs the guide with its blueprint.
			const readingView = page.getByRole("navigation", { name: "Reading view" });
			await readingView.getByRole("link", { name: "Blueprint", exact: true }).click();
			await page.waitForURL(`${origin}/docs/blueprints/trace_blueprint.html`);
			await page.locator(".blueprint-frame.is-ready").waitFor();
			await readingView.getByRole("link", { name: "Guide", exact: true }).click();
			await page.waitForURL(`${origin}/docs/architecture/trace-store.md`);
			await page.locator(".docs-path").filter({ hasText: "architecture/trace-store.md" }).waitFor();
			if (width === 1600) {
				// A fragment on the blueprint route scrolls the document to that heading.
				await page.goto(`${origin}/docs/blueprints/trace_blueprint.html#tables`);
				await page.locator(".blueprint-frame.is-ready").waitFor();
				const documentFrame = page
					.frames()
					.find((frame) => frame.url().startsWith(`${origin}/docs-html/trace_blueprint.html?`));
				assert.ok(documentFrame, "The blueprint document frame is attached");
				await documentFrame.waitForFunction(() => {
					const heading = document.getElementById("tables");
					if (!heading) return false;
					const top = heading.getBoundingClientRect().top;
					return window.scrollY > 0 && top >= 0 && top < 40;
				});
				// Keyboard: the frame is the next stop after the reading view, and focus continues into the document.
				await page.getByRole("navigation", { name: "Reading view" }).getByRole("link", { name: "Blueprint" }).focus();
				await page.keyboard.press("Tab");
				assert.equal(await page.evaluate(() => document.activeElement?.tagName), "IFRAME");
				await page.keyboard.press("Tab");
				assert.equal(await blueprint.locator("html").evaluate(() => document.activeElement?.tagName), "A");
				assert.equal(
					await page.locator("iframe.blueprint-frame__document").getAttribute("title"),
					"Trace store contract · blueprint",
				);
				// A missing file is an explicit, retryable state rather than a blank frame.
				await page.goto(`${origin}/docs/blueprints/missing_blueprint.html`);
				const missing = page.getByRole("alert").filter({ hasText: "No blueprint file named missing_blueprint.html" });
				await missing.waitFor();
				await missing.getByRole("button", { name: "Try again", exact: true }).click();
				await missing.waitFor();
				assert.equal(await page.locator("iframe").count(), 0);
				await check("docs-blueprint-missing");
				// A document that never announces itself reports a timeout, and still appears once it arrives.
				const held: (() => Promise<void>)[] = [];
				await page.route("**/docs-html/tui_design_blueprint.html?*", async (route) => {
					if (route.request().resourceType() === "document") held.push(() => route.continue());
					else await route.continue();
				});
				await page.goto(`${origin}/docs/blueprints/tui_design_blueprint.html`);
				await page.getByRole("button", { name: "Reload blueprint", exact: true }).waitFor({ timeout: 20000 });
				assert.equal(held.length, 1);
				await held[0]?.();
				await page.locator(".blueprint-frame.is-ready").waitFor();
				await page.unroute("**/docs-html/tui_design_blueprint.html?*");
				assert.equal(await page.getByRole("button", { name: "Reload blueprint", exact: true }).count(), 0);
				await page.goto(`${origin}/docs/blueprints/index.html`);
				await page.waitForURL(`${origin}/docs`);
				await page.locator(".docs-page .markdown").waitFor();
				await navigate("Docs");
				await page.getByLabel("Search the documentation", { exact: true }).fill("trace");
				await page.getByRole("button", { name: "Search docs", exact: true }).click();
				await docResults.getByRole("link", { name: /Trace Store/i }).click();
				await page.locator(".docs-path").filter({ hasText: "architecture/trace-store.md" }).waitFor();
			}
		}
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `docs-${width}.png`), fullPage: false });
		await page.getByRole("button", { name: "Dark theme", exact: true }).click();
		await check("docs-dark");
		await page.getByRole("button", { name: "Light theme", exact: true }).click();
		await navigate("Sessions");
		await page.getByLabel("Workspace path", { exact: true }).fill(h.home.path);
		await page.getByRole("button", { name: "Open workspace", exact: true }).click();
		await page.getByRole("button", { name: "New session", exact: true }).waitFor();
		await check("sessions");
		const workspaceUrl = page.url();
		await navigate("Settings");
		await page.getByLabel("Filter settings", { exact: true }).fill("chat.model");
		await page.getByText("fixture-local-model", { exact: true }).waitFor();
		await check("settings-inspection");
		if (width === 1600 || width === 390) await page.screenshot({ path: join(output, `settings-${width}.png`) });
		await page.getByRole("button", { name: "Dark theme", exact: true }).click();
		await check("settings-inspection-dark");
		await page.getByRole("button", { name: "Light theme", exact: true }).click();
		await page.getByRole("link", { name: "Why", exact: true }).click();
		await page.getByRole("heading", { name: "fixture-hook", exact: true }).waitFor();
		await check("config-graph");
		if (width === 1600) await page.screenshot({ path: join(output, "config-graph.png") });
		await page.getByRole("button", { name: "Dark theme", exact: true }).click();
		await check("config-graph-dark");
		await page.getByRole("button", { name: "Light theme", exact: true }).click();
		await page.getByRole("link", { name: "Targets", exact: true }).click();
		await page.getByRole("article", { name: "fixture-target", exact: true }).waitFor();
		await check("targets");
		await page.getByRole("button", { name: "Use for chat & fleet", exact: true }).click();
		await page.getByRole("heading", { name: "Target operation · succeeded", exact: true }).waitFor();
		await page.getByRole("button", { name: "Dark theme", exact: true }).click();
		await check("targets-dark");
		await page.getByRole("button", { name: "Light theme", exact: true }).click();
		await page.getByRole("link", { name: "Routing", exact: true }).click();
		await page.getByRole("heading", { name: /^Agent bindings ·/ }).waitFor();
		await check("routing");
		await page.getByRole("button", { name: "Dark theme", exact: true }).click();
		await check("routing-dark");
		await page.goto(`${origin}/usage`);
		await page.getByRole("heading", { name: "Recorded facts", exact: true }).waitFor();
		await check("usage-dark");
		await page.getByRole("button", { name: "Light theme", exact: true }).click();
		await check("usage");
		await navigate("Library");
		await page.getByRole("heading", { name: "fixture-skill", exact: true }).waitFor();
		await check("library-skills");
		for (const collection of ["Agents", "Prompts", "Fleets", "Plugins", "Extensions", "Verifiers"]) {
			await page.getByRole("button", { name: new RegExp(`^${collection} · [1-9]`) }).click();
			await page.locator(".config-entries article").first().waitFor();
			await check(`library-${collection.toLowerCase()}`);
		}
		await page.getByRole("button", { name: "Dark theme", exact: true }).click();
		await check("library-dark");
		await navigate("System");
		await page.getByRole("heading", { name: "Clio folders", exact: true }).waitFor();
		await check("system-dark");
		await page.getByRole("link", { name: "Other coding agents", exact: true }).click();
		await page.getByRole("heading", { name: "Codex", exact: true }).waitFor();
		await check("interop-dark");
		await page.getByRole("button", { name: "Light theme", exact: true }).click();
		await check("interop");
		await page.getByRole("button", { name: "Dark theme", exact: true }).click();
		await page.getByRole("button", { name: "Light theme", exact: true }).click();
		await page.goto(workspaceUrl);
		await page.getByRole("button", { name: "New session", exact: true }).waitFor();
		await page.getByRole("button", { name: "New session", exact: true }).click();
		await page
			.getByLabel("Message Clio Coder", { exact: true })
			.fill("Show the fixture findings with code and a diagram.");
		await page.getByRole("button", { name: "Send message", exact: true }).click();
		await page.locator(".diagram.is-rendered svg").waitFor();
		await page.locator(".token.keyword").first().waitFor();
		const diagram = await page.locator(".diagram svg").evaluate((node) => {
			const svg = node as SVGSVGElement;
			return {
				width: svg.getBoundingClientRect().width,
				height: svg.getBoundingClientRect().height,
				viewBox: svg.getAttribute("viewBox"),
				markup: svg.outerHTML,
			};
		});
		await writeFile(join(output, `diagram-${width}.json`), JSON.stringify(diagram, null, 2));
		assert.equal(
			await page.locator(".diagram svg script, .diagram svg foreignObject, .diagram svg a, .diagram svg image").count(),
			0,
		);
		assert.equal(
			await page.locator(".diagram svg").evaluate((svg) => {
				const bounds = svg.getBoundingClientRect();
				return [...svg.querySelectorAll(".node")].every((node) => {
					const rectangle = node.getBoundingClientRect();
					return (
						rectangle.left >= bounds.left - 1 &&
						rectangle.right <= bounds.right + 1 &&
						rectangle.top >= bounds.top - 1 &&
						rectangle.bottom <= bounds.bottom + 1
					);
				});
			}),
			true,
			"Every diagram node is inside the rendered viewport.",
		);
		if (width === 390) {
			const code = page.locator(".code-block pre").first();
			await code.focus();
			await page.keyboard.press("ArrowRight");
			await page.waitForFunction(() => (document.querySelector(".code-block pre")?.scrollLeft ?? 0) > 0);
			await code.evaluate((node) => {
				node.scrollLeft = 0;
				node.blur();
			});
		}
		assert.equal(await page.locator(".chat-timeline script").count(), 0);
		assert.equal(await page.locator('.chat-timeline a[href^="javascript:"]').count(), 0);
		assert.equal(await page.evaluate(() => Object.hasOwn(window, "modelMarkupExecuted")), false);
		assert.ok((await page.locator(".chat-timeline").innerText()).includes("<script>window.modelMarkupExecuted"));
		await check("conversation");
		await page.screenshot({ path: join(output, `conversation-${width}.png`), fullPage: true });
		await page.getByRole("button", { name: "Dark theme", exact: true }).click();
		await check("conversation-dark");
		if (width === 1600) await page.screenshot({ path: join(output, "conversation-dark.png"), fullPage: true });
		await page.getByRole("button", { name: "Light theme", exact: true }).click();
		await page.getByText("Session controls", { exact: true }).click();
		await page.getByRole("button", { name: "Save settings", exact: true }).waitFor();
		await check("session-controls");
		await page.getByText("Session controls", { exact: true }).click();
		await page.getByLabel("Message Clio Coder", { exact: true }).fill("[approval] Write the fixture file.");
		await page.getByRole("button", { name: "Send message", exact: true }).click();
		await page.getByRole("button", { name: "Allow once", exact: true }).waitFor();
		await check("permission");
		await page.getByRole("button", { name: "Dark theme", exact: true }).click();
		await check("permission-dark");
		await page.getByRole("button", { name: "Light theme", exact: true }).click();
		await page.getByRole("button", { name: "Allow once", exact: true }).click();
		await page.getByText("Tool executed.", { exact: true }).waitFor();
		await page.getByLabel("Message Clio Coder", { exact: true }).fill("[stream] Show progress until cancelled.");
		await page.getByRole("button", { name: "Send message", exact: true }).click();
		await page.getByRole("button", { name: "Cancel turn", exact: true }).click();
		await page.waitForFunction(() => !document.querySelector(".session-status")?.textContent?.includes("working"));
		await check("cancelled");
		await page.getByRole("button", { name: "Close session", exact: true }).click();
		await page.waitForFunction(() => document.querySelector(".session-status")?.textContent?.includes("closed"));
		await navigate("Sessions");
		await page.getByLabel("Workspace path", { exact: true }).fill(join(h.home.path, "does-not-exist"));
		await page.getByRole("button", { name: "Open workspace", exact: true }).click();
		const toast = page.locator(".problem-toast");
		await toast.waitFor();
		assert.match(await toast.innerText(), /validation/);
		assert.match(await toast.innerText(), /Reference: [0-9a-f-]+/);
		await check("problem-toast");
		await context.close();
	}
	assert.deepEqual(errors, []);
	assert.deepEqual(failures, []);
	assert.deepEqual(
		statuses.filter(
			(item) =>
				!(item.path === "/api/workspaces" && item.status === 422) &&
				!(item.path === "/docs-html/missing_blueprint.html" && item.status === 404),
		),
		[],
	);
	success = true;
} finally {
	const report = {
		output,
		success,
		chrome: browser.version(),
		checks,
		requestFailures: failures,
		scriptErrors: errors,
		errorResponses: statuses,
	};
	await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
	console.log(JSON.stringify(report, null, 2));
	await browser.close();
	if ("closeAllConnections" in server) server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	fixture.close();
	await h.close();
}
