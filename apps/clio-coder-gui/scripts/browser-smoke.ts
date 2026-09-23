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
await seedReports(h.home.path, h.home.env);
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
let failedPage: { screenshot(options: { path: string; fullPage: boolean }): Promise<unknown> } | null = null;
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
		failedPage = page;
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
			failures.push(`${path}: ${request.failure()?.errorText}`);
		});
		page.on("response", (response) => {
			if (response.status() >= 400) statuses.push({ path: new URL(response.url()).pathname, status: response.status() });
		});
		async function check(name: string) {
			await page.evaluate(() => document.fonts.ready);
			// A theme change lands as an attribute first; let the cascade and a paint settle before axe reads colours.
			await page.waitForFunction(
				() =>
					getComputedStyle(document.body).color ===
					(document.documentElement.dataset.theme === "dark" ? "rgb(227, 231, 217)" : "rgb(31, 43, 36)"),
			);
			await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
			const builder = new AxeBuilder({ page });
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
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `toolchain-${width}.png`), fullPage: true });
		await navigate("Traces");
		await page.locator('a[href="/traces/run-0000"]').waitFor();
		await check("traces");
		await page.locator('a[href="/traces/run-0000"]').click();
		await page.getByRole("heading", { name: "Inspect fixture 0", exact: true }).waitFor();
		await page.getByText("Fixture workspace", { exact: false }).first().waitFor({ state: "attached" });
		await check("trace-run");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `trace-run-${width}.png`), fullPage: true });
		await navigate("Fleet");
		await page.getByRole("heading", { name: "fixture-council", exact: true }).waitFor();
		await page.getByText("not a live event stream", { exact: false }).waitFor();
		await check("fleet");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `fleet-${width}.png`), fullPage: true });
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
		// The inspectors live inside closed disclosures, so they are opened before they are judged.
		const openInspectors = async (name: string) => {
			await page.locator("main details").evaluateAll((nodes) => {
				for (const node of nodes) (node as HTMLDetailsElement).open = true;
			});
			await page.locator("main .facts").first().waitFor();
			const raw = await page
				.locator("main pre")
				.evaluateAll((nodes) => nodes.map((node) => node.textContent ?? "").filter((text) => /^\s*[{[]/.test(text)));
			assert.deepEqual(raw, [], `${name} still renders a raw JSON dump`);
			await check(`${name}-inspectors`);
			if (width === 1600 || width === 390)
				await page.screenshot({ path: join(output, `${name}-inspectors-${width}.png`), fullPage: true });
		};
		await openInspectors("evidence-detail");
		await navigate("Docs");
		await page.locator(".docs-page .markdown").waitFor();
		await check("docs-map");
		await page.getByLabel("Search the documentation", { exact: true }).fill("trace");
		await page.getByRole("button", { name: "Search docs", exact: true }).click();
		const docResults = page.getByRole("region", { name: "Search results" });
		await docResults.getByRole("link", { name: /Trace Store/i }).click();
		await page.locator(".docs-path").filter({ hasText: "architecture/trace-store.md" }).waitFor();
		await check("docs-page");
		assert.equal(await page.locator("iframe").count(), 0, "Docs render in the application without a legacy frame");
		assert.equal(await page.getByRole("navigation", { name: "Reading view" }).count(), 0);
		const outline = page.getByRole("navigation", { name: "On this page" });
		// Wide screens keep the outline open beside the text; narrower ones start it collapsed.
		if (!(await outline.locator("details").evaluate((element) => (element as HTMLDetailsElement).open)))
			await outline.locator("summary").click();
		await outline.getByRole("link", { name: "Tables", exact: true }).click();
		await page.waitForURL(`${origin}/docs/architecture/trace-store.md#tables`);
		await page.waitForFunction(() => {
			const top = document.getElementById("tables")?.getBoundingClientRect().top;
			return top !== undefined && top >= 0 && top < 120;
		});
		assert.equal(context.pages().length, 1);
		if (width > 750) {
			// The rail collapses to icons, keeps every destination reachable by name, and expands again.
			const rail = page.locator(".desktop-navigation");
			const railWidth = () => rail.evaluate((element) => Math.round(element.getBoundingClientRect().width));
			const expanded = await railWidth();
			await page.keyboard.press("Control+\\");
			await page.waitForFunction(
				(before) => (document.querySelector(".desktop-navigation")?.getBoundingClientRect().width ?? before) < before / 2,
				expanded,
			);
			await check("docs-rail-collapsed");
			assert.equal(await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link").count(), 10);
			assert.equal(await page.getByRole("link", { name: "Settings", exact: true }).getAttribute("data-tip"), "Settings");
			await page.getByRole("button", { name: "Expand sidebar", exact: true }).click();
			await page.waitForFunction(
				(before) => (document.querySelector(".desktop-navigation")?.getBoundingClientRect().width ?? 0) >= before - 1,
				expanded,
			);
			assert.equal(
				await page.getByRole("button", { name: "Collapse sidebar", exact: true }).getAttribute("aria-expanded"),
				"true",
			);
		}
		await page.getByRole("button", { name: "Dark theme", exact: true }).click();
		await check("docs-page-dark");
		await page.getByRole("button", { name: "Light theme", exact: true }).click();
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
		// The write surface: a select saves through the engine, a project-set value refuses, a destructive
		// change needs its named confirmation.
		const setting = (path: string) => page.locator(".setting-control", { has: page.getByText(path, { exact: true }) });
		await page.getByRole("heading", { name: "Chat", exact: true }).waitFor();
		const thinking = setting("chat.thinkingLevel");
		const level = (await thinking.getByRole("combobox").inputValue()) === "low" ? "high" : "low";
		await thinking.getByRole("combobox").selectOption(level);
		await thinking.getByRole("button", { name: "Save", exact: true }).click();
		await thinking.getByRole("status").getByText("Used by the next relevant request").waitFor();
		await check("settings-saved");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `settings-controls-${width}.png`), fullPage: true });
		await page.getByRole("button", { name: /^Permissions & Limits · / }).click();
		await setting("safety.autonomy").getByText("Set by the project layer").waitFor();
		if (await setting("safety.autonomy").getByRole("combobox").count())
			throw new Error("A project-set value still offers an editor.");
		await page.getByRole("button", { name: /^Fleet · / }).click();
		const history = setting("fleet.history.maxRuns");
		await history.getByRole("spinbutton").fill(width === 1600 ? "900" : width === 1050 ? "800" : "700");
		if (!(await history.getByRole("button", { name: "Save", exact: true }).isDisabled()))
			throw new Error("A destructive setting saved without its confirmation.");
		await history.getByRole("checkbox").check();
		await check("settings-confirm");
		if (width === 1600) await page.screenshot({ path: join(output, "settings-confirm.png"), fullPage: true });
		await history.getByRole("button", { name: "Save", exact: true }).click();
		await history.getByRole("status").waitFor();
		await page.getByLabel("Find a setting", { exact: true }).fill("no-such-setting-anywhere");
		await page.getByText("No settings match.", { exact: true }).waitFor();
		await page.getByRole("button", { name: "Dark theme", exact: true }).click();
		await page.getByLabel("Find a setting", { exact: true }).fill("retry");
		await check("settings-controls-dark");
		await page.getByRole("button", { name: "Light theme", exact: true }).click();
		await page.getByRole("link", { name: "Effective values", exact: true }).click();
		await page.getByLabel("Filter settings", { exact: true }).fill("chat.model");
		await page.getByText("fixture-local-model", { exact: true }).waitFor();
		await check("settings-inspection");
		if (width === 1600 || width === 390) await page.screenshot({ path: join(output, `settings-${width}.png`) });
		await page.getByRole("button", { name: "Dark theme", exact: true }).click();
		await check("settings-inspection-dark");
		await page.getByRole("button", { name: "Light theme", exact: true }).click();
		await page.getByRole("link", { name: "Why", exact: true }).click();
		await page.getByRole("heading", { name: "fixture-hook", exact: true }).waitFor();
		await page.getByRole("heading", { name: "From source to behavior", exact: true }).waitFor();
		await check("config-graph");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `config-graph-${width}.png`), fullPage: true });
		await page.getByRole("button", { name: "Dark theme", exact: true }).click();
		await check("config-graph-dark");
		await page.getByRole("button", { name: "Light theme", exact: true }).click();
		await page.getByRole("link", { name: "Targets", exact: true }).click();
		await page.getByRole("article", { name: "fixture-target", exact: true }).waitFor();
		await check("targets");
		// Onboarding: a catalog runtime refuses to save without a model, and a local endpoint saves
		// through the real CLI with no key field anywhere on the form.
		await page.getByRole("button", { name: "Add a connection", exact: true }).click();
		const onboarding = page.getByRole("form", { name: "Add a connection", exact: true });
		await onboarding.getByLabel("Runtime", { exact: true }).selectOption("anthropic");
		await onboarding.getByText("so choose a model").waitFor();
		if (!(await onboarding.getByRole("button", { name: "Save connection", exact: true }).isDisabled()))
			throw new Error("A catalog runtime offered to save without a model.");
		if (await onboarding.locator('input[type="password"]').count())
			throw new Error("The onboarding form rendered a credential field.");
		await onboarding.getByLabel("Runtime", { exact: true }).selectOption("openai-compat");
		await onboarding.getByLabel("Connection id", { exact: true }).fill(`smoke-${width}`);
		await onboarding.getByLabel("Endpoint URL", { exact: true }).fill("http://127.0.0.1:9");
		await onboarding.getByLabel(/^Default model/).fill("smoke-model");
		await check("targets-onboarding");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `targets-onboarding-${width}.png`), fullPage: true });
		await onboarding.getByRole("button", { name: "Save connection", exact: true }).click();
		await page.getByRole("article", { name: `smoke-${width}`, exact: true }).waitFor();
		await page.getByText("could not verify model").waitFor();
		await page
			.getByRole("article", { name: "fixture-target", exact: true })
			.getByRole("button", { name: "Use for chat & fleet", exact: true })
			.click();
		await page.getByRole("heading", { name: "Target operation · succeeded", exact: true }).waitFor();
		await page.getByRole("button", { name: "Dark theme", exact: true }).click();
		await check("targets-dark");
		await page.getByRole("button", { name: "Light theme", exact: true }).click();
		await page.getByRole("link", { name: "Routing", exact: true }).click();
		await page.getByRole("heading", { name: /^Agent bindings ·/ }).waitFor();
		await check("routing");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `routing-${width}.png`), fullPage: true });
		await page.getByRole("button", { name: "Dark theme", exact: true }).click();
		await check("routing-dark");
		await page.goto(`${origin}/usage`);
		await page.getByRole("heading", { name: "Token composition", exact: true }).waitFor();
		// The five bars compare fields with one another, which is the one thing a reader can get
		// wrong by looking; the caveat is part of the panel, not a footnote that can drift away.
		await page.getByText("they are not additive percentages", { exact: false }).waitFor();
		await check("usage-dark");
		await page.getByRole("button", { name: "Light theme", exact: true }).click();
		await check("usage");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `usage-${width}.png`), fullPage: true });
		await navigate("Library");
		// The catalog is the landing collection: plan, review, apply, then remove, all against the bundled index.
		const offer = page.getByRole("listitem", { name: "skill:archify", exact: true });
		await offer.waitFor();
		await check("library-catalog");
		await offer.getByRole("button", { name: "Install skill:archify for me", exact: true }).click();
		const review = page.getByRole("dialog", { name: "Install skill:archify", exact: true });
		await review.getByText("This is exactly what will be applied. Nothing has been written yet.").waitFor();
		await review.getByText("Staged and verified").waitFor();
		await check("library-plan");
		await review.getByRole("button", { name: "Apply this change", exact: true }).click();
		await review.getByText("The files are on disk and the install record matches.").waitFor();
		await review.getByText("Open conversations have not reloaded.").waitFor();
		await check("library-applied");
		if (width === 1600 || width === 390) await page.screenshot({ path: join(output, `library-applied-${width}.png`) });
		await review.getByRole("button", { name: "Done", exact: true }).click();
		await offer.locator(".status-mark", { hasText: "Ready" }).waitFor();
		// A second user install is no longer offered; the project scope still is.
		if (await offer.getByRole("button", { name: "Install skill:archify for me", exact: true }).count())
			throw new Error("An installed user copy still offers a user install.");
		await offer.getByRole("button", { name: "Install skill:archify in this project", exact: true }).waitFor();
		await page.getByRole("button", { name: /^Installed only · [1-9]/ }).click();
		await check("library-installed");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `library-installed-${width}.png`), fullPage: true });
		await page.getByRole("button", { name: "Dark theme", exact: true }).click();
		await check("library-installed-dark");
		if (width === 1600) await page.screenshot({ path: join(output, "library-installed-dark.png"), fullPage: true });
		await page.getByRole("button", { name: "Light theme", exact: true }).click();
		await offer.getByRole("button", { name: "Remove the user copy of skill:archify", exact: true }).click();
		const removal = page.getByRole("dialog", { name: "Remove skill:archify", exact: true });
		await removal.getByRole("button", { name: "Apply this change", exact: true }).click();
		await removal.getByText("The files and the install record are gone.").waitFor();
		await removal.getByRole("button", { name: "Done", exact: true }).click();
		await page.getByText("No packages match.").waitFor();
		await page
			.getByRole("tablist", { name: "Library collections" })
			.getByRole("tab", { name: /^Skills · [1-9]/ })
			.click();
		await page.getByRole("heading", { name: "fixture-skill", exact: true }).waitFor();
		await check("library-skills");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `library-skills-${width}.png`), fullPage: true });
		// The collections are one tab stop: an arrow key moves the selection and the focus together.
		await page.getByRole("tab", { name: /^Skills · / }).press("ArrowLeft");
		const agentsTab = page.getByRole("tab", { name: /^Agents · / });
		if ((await agentsTab.getAttribute("aria-selected")) !== "true")
			throw new Error("ArrowLeft from Skills did not select the Agents tab.");
		if (!(await agentsTab.evaluate((node) => node === document.activeElement)))
			throw new Error("ArrowLeft moved the selection without moving focus.");
		await page.getByText("Tool-call budget", { exact: true }).first().waitFor();
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `library-agents-${width}.png`), fullPage: true });
		for (const collection of ["Agents", "Prompts", "Fleets", "Extensions", "Verifiers"]) {
			await page.getByRole("tab", { name: new RegExp(`^${collection} · [1-9]`) }).click();
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
		await page.getByText("Would be offered", { exact: true }).waitFor();
		// Opening the page ran nothing. The probe is an explicit act, and the page survives it.
		await page.getByRole("button", { name: "Detect again and probe versions", exact: true }).click();
		await page.getByRole("button", { name: "Detect again and probe versions", exact: true }).waitFor();
		await check("interop");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `interop-${width}.png`), fullPage: true });
		await page.getByRole("button", { name: "Dark theme", exact: true }).click();
		await page.getByRole("button", { name: "Light theme", exact: true }).click();
		await page.goto(workspaceUrl);
		await page.getByRole("button", { name: "New session", exact: true }).waitFor();
		await page.getByRole("button", { name: "New session", exact: true }).click();
		await page
			.getByLabel("Message Clio Coder", { exact: true })
			.fill("Show the fixture findings with code and a diagram.");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await page.locator(".diagram.is-rendered svg").waitFor();
		// Highlighting waits until code nears the visible transcript; the composer is no longer
		// displaced by page scrolling, so bring that block into the one reading viewport.
		await page.locator(".code-block pre").first().scrollIntoViewIfNeeded();
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
		assert.equal(await page.locator(".chat-transcript script").count(), 0);
		assert.equal(await page.locator('.chat-transcript a[href^="javascript:"]').count(), 0);
		assert.equal(await page.evaluate(() => Object.hasOwn(window, "modelMarkupExecuted")), false);
		assert.ok((await page.locator(".chat-transcript").innerText()).includes("<script>window.modelMarkupExecuted"));
		await page.locator(".chat-transcript").evaluate((element) => {
			element.scrollTop = element.scrollHeight;
		});

		// Complete accounting lives with the turn outcome, not as a repeated line above the
		// composer. Its native disclosure must work from the keyboard and remain accessible open.
		assert.equal(await page.locator(".conversation__dock > .chat-usage").count(), 0);
		const usage = page.locator(".turn-usage").last();
		const usageSummary = usage.locator("summary");
		await usageSummary.focus();
		await page.keyboard.press("Enter");
		assert.equal(await usage.evaluate((element) => (element as HTMLDetailsElement).open), true);
		assert.equal(
			await usage
				.locator("dt")
				.allTextContents()
				.then((labels) => labels.join(" · ")),
			"Input · Output · Cache read · Cache write · Reasoning",
		);
		assert.deepEqual(await usage.locator("dd").allTextContents(), ["11", "12", "13", "14", "15"]);
		await check("conversation-usage");
		await page.keyboard.press("Enter");
		assert.equal(await usage.evaluate((element) => (element as HTMLDetailsElement).open), false);

		// The resting tray is compact, grows with a multiline draft, and keeps a followed
		// transcript at its live edge while that grid row changes height.
		const composerField = page.getByLabel("Message Clio Coder", { exact: true });
		const restingComposer = await page.locator(".composer").evaluate((element) => element.getBoundingClientRect().height);
		assert.ok(restingComposer <= 180, `resting composer is ${restingComposer}px tall at ${width}px`);
		const restingField = await composerField.evaluate((element) => element.getBoundingClientRect().height);
		await composerField.fill("one\ntwo\nthree\nfour\nfive\nsix\nseven\neight");
		await page.waitForFunction(
			(before) => (document.querySelector(".composer__field")?.getBoundingClientRect().height ?? 0) > before + 20,
			restingField,
		);
		await page.waitForFunction(() => {
			const transcript = document.querySelector(".chat-transcript");
			return !!transcript && transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <= 32;
		});
		const grownComposer = await page.evaluate(() => {
			const composer = document.querySelector(".composer")?.getBoundingClientRect();
			const transcript = document.querySelector(".chat-transcript");
			return {
				composerBottom: composer?.bottom ?? Number.POSITIVE_INFINITY,
				bottomGap: transcript
					? transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight
					: Number.POSITIVE_INFINITY,
			};
		});
		assert.ok(grownComposer.composerBottom <= 1050, "a growing draft pushed the composer below the viewport");
		assert.ok(grownComposer.bottomGap <= 32, "a growing draft moved a followed transcript away from its live edge");
		await composerField.fill("");
		await page.waitForFunction(
			(before) =>
				(document.querySelector(".composer__field")?.getBoundingClientRect().height ?? Number.POSITIVE_INFINITY) <=
				before + 1,
			restingField,
		);
		await composerField.evaluate((element) => (element as HTMLTextAreaElement).blur());

		await check("conversation");
		const conversationLayout = await page.evaluate(() => {
			const transcript = document.querySelector(".chat-transcript");
			const composer = document.querySelector(".composer");
			const header = document.querySelector(".conversation__header");
			const main = document.querySelector("main");
			return {
				pageScrolls: (document.scrollingElement?.scrollHeight ?? 0) > innerHeight + 2,
				mainScrolls: !!main && (main.scrollTop !== 0 || main.scrollLeft !== 0),
				transcriptScrolls: !!transcript && transcript.scrollHeight > transcript.clientHeight,
				headerVisible: !!header && header.getBoundingClientRect().top >= 50,
				composerVisible: !!composer && composer.getBoundingClientRect().bottom <= innerHeight,
			};
		});
		assert.deepEqual(conversationLayout, {
			pageScrolls: false,
			mainScrolls: false,
			transcriptScrolls: true,
			headerVisible: true,
			composerVisible: true,
		});
		await page.screenshot({ path: join(output, `conversation-${width}.png`), fullPage: true });
		await page.getByRole("button", { name: "Dark theme", exact: true }).click();
		await check("conversation-dark");
		if (width === 1600) await page.screenshot({ path: join(output, "conversation-dark.png"), fullPage: true });
		await page.getByRole("button", { name: "Light theme", exact: true }).click();
		await page.getByText("Session tools", { exact: true }).click();
		await page.getByText("Session controls", { exact: true }).click();
		await page.getByRole("button", { name: "Save settings", exact: true }).waitFor();
		await check("session-controls");
		await page.getByText("Session controls", { exact: true }).click();
		await page.keyboard.press("Escape");
		assert.equal(
			await page.locator(".conversation__tools").evaluate((element) => (element as HTMLDetailsElement).open),
			false,
		);
		assert.equal(
			await page.locator(".conversation__tools > summary").evaluate((element) => document.activeElement === element),
			true,
		);
		await page.getByText("Session tools", { exact: true }).click();
		await page.getByText("Clio Coder commands", { exact: true }).click();
		await page.locator(".command-panel__form select").first().selectOption("doctor");
		await page.locator('.command-panel select[name="pos:0"]').selectOption("deep");
		await page.getByRole("button", { name: "Review request" }).click();
		await page.getByText("/doctor deep", { exact: true }).waitFor();
		assert.equal(await page.getByText("Deep checks completed.", { exact: true }).count(), 0);
		await page.locator('.command-panel select[name="pos:0"]').selectOption("");
		assert.equal(
			await page.getByRole("button", { name: "Send command" }).count(),
			0,
			"changing an argument discards the reviewed request",
		);
		await page.locator('.command-panel select[name="pos:0"]').selectOption("deep");
		await page.getByRole("button", { name: "Review request" }).click();
		await page.getByRole("button", { name: "Send command" }).click();
		await page.getByText("Deep checks completed.", { exact: true }).waitFor();
		await page.locator(".command-panel__form select").first().selectOption("context");
		await page.locator('.command-panel select[name="subcommand"]').selectOption("compact");
		await page.locator('.command-panel textarea[name="pos:0"]').fill("Summarize the project");
		await page.getByRole("button", { name: "Review request" }).click();
		await page.getByText("/context compact Summarize the project", { exact: true }).waitFor();
		await page.getByRole("button", { name: "Send command" }).click();
		await page.getByText("Context action: compact Summarize the project", { exact: true }).waitFor();
		await check("session-commands");
		if (width === 1600) await page.screenshot({ path: join(output, "session-commands.png"), fullPage: true });
		await page.getByText("Clio Coder commands", { exact: true }).click();
		await page.getByText("Session tools", { exact: true }).click();
		await page.getByLabel("Message Clio Coder", { exact: true }).fill("[approval] Write the fixture file.");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await page.getByRole("button", { name: "Allow once", exact: true }).first().waitFor();
		await check("permission");
		await page.getByRole("button", { name: "Dark theme", exact: true }).click();
		await check("permission-dark");
		await page.getByRole("button", { name: "Light theme", exact: true }).click();
		await page.getByRole("button", { name: "Allow once", exact: true }).first().click();
		await page.getByText("Tool executed.", { exact: true }).waitFor();
		// A settled group collapses, so open it the way an operator would before reading the card.
		await page.locator(".activity__summary").last().click();
		const applied = page.locator(".diff.is-applied").last();
		await applied.waitFor();
		assert.match(await applied.innerText(), /applied/i);
		assert.match(await applied.innerText(), /approved/);
		// A refusal settles as a FAILED call. The card must keep the refused change on screen and
		// say who turned it down, which a bare status cannot.
		await page.getByLabel("Message Clio Coder", { exact: true }).fill("[approval] Write it again.");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await page.getByRole("button", { name: "Reject", exact: true }).first().click();
		await page.getByText("Permission rejected.", { exact: true }).waitFor();
		const refused = page.locator(".diff.is-rejected").last();
		await refused.waitFor();
		assert.match(await refused.innerText(), /not applied · you rejected this/i);
		assert.match(await refused.innerText(), /Nothing was written/);
		assert.match(await refused.innerText(), /approved/, "The refused content stays readable.");
		await check("permission-rejected");
		if (width === 1600) await page.screenshot({ path: join(output, "permission-rejected.png"), fullPage: true });
		// Dispatch steering. The fixture holds one live worker until it is stopped, so both write
		// paths on a run are pressed for real: guidance is queued, then the run is stopped.
		await page.getByLabel("Message Clio Coder", { exact: true }).fill("[fleet] Survey the fixture.");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await page.getByText(/Session tools · 1 worker running/).click();
		await page.getByRole("button", { name: "Guide scout", exact: true }).click();
		await page.getByLabel("Guidance for scout", { exact: true }).fill("Only read the README.");
		await page.getByRole("button", { name: "Send guidance", exact: true }).click();
		await page.getByText("Guidance queued. The worker reads it at its next step.", { exact: true }).waitFor();
		await check("fleet-steer");
		if (width === 1600) await page.screenshot({ path: join(output, "fleet-steer.png"), fullPage: true });
		// Mid-turn steering from the composer: queue a message for after the turn, see it listed,
		// take it back into the field, then hear the engine's refusal to interrupt as a sentence.
		await page.getByLabel("Message Clio Coder", { exact: true }).fill("Then summarise it.");
		await page.getByLabel("After this turn", { exact: true }).check();
		await page.locator(".composer__submit").click();
		await page.locator(".composer__queue-row").getByText("Then summarise it.", { exact: true }).waitFor();
		await check("composer-queue");
		if (width === 1600) await page.screenshot({ path: join(output, "composer-queue.png"), fullPage: true });
		await page.getByRole("button", { name: "Take them back", exact: true }).click();
		await page.waitForFunction(
			() => (document.querySelector(".composer__field") as HTMLTextAreaElement | null)?.value === "Then summarise it.",
		);
		await page.getByLabel("Message Clio Coder", { exact: true }).fill("");
		await page.getByRole("button", { name: "Interrupt", exact: true }).click();
		await page.getByText("A dispatched worker is attached; stop the turn instead.").waitFor();
		await page.getByText(/Session tools · 1 worker running/).click();
		await page.getByRole("button", { name: "Stop scout", exact: true }).click();
		await page.getByRole("button", { name: "Stop run", exact: true }).click();
		await page.getByText("The worker was stopped.", { exact: true }).waitFor();
		assert.equal(await page.getByRole("button", { name: "Guide scout", exact: true }).count(), 0);
		await page.locator(".conversation__tools > summary").click();
		await page.getByLabel("Message Clio Coder", { exact: true }).fill("[stream] Show progress until cancelled.");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await page.getByRole("button", { name: "Stop turn", exact: true }).click();
		await page.waitForFunction(() => !document.querySelector(".session-status")?.textContent?.includes("working"));
		await check("cancelled");
		await page.getByRole("button", { name: "Close session", exact: true }).click();
		await page.waitForFunction(() => document.querySelector(".session-status")?.textContent?.includes("closed"));
		await navigate("Sessions");
		await page.getByLabel("Workspace path", { exact: true }).fill(join(h.home.path, "does-not-exist"));
		await page.getByRole("button", { name: "Open workspace", exact: true }).click();
		const toast = page.locator(".notice-region .notice");
		await toast.waitFor();
		assert.match(await toast.innerText(), /validation/);
		assert.match(await toast.innerText(), /Reference: [0-9a-f-]+/);
		await check("problem-toast");
		// A stale token must not brick the app: the shell says what happened, stops reconnecting, and a
		// pasted launch link brings the same tab back.
		await page.goto(`${origin}/#token=${"stale".repeat(8)}`);
		await page.reload();
		await page.getByRole("heading", { name: "This browser is no longer connected", exact: true }).waitFor();
		await page.locator('.connection[title="Not connected"]').waitFor();
		if ((await page.locator(".notice-region .notice").count()) > 0)
			throw new Error("A refused token raised toasts on top of the reconnect panel.");
		await page.getByLabel("Launch link or token", { exact: true }).fill("not a link");
		await page.getByText("That text holds no launch token.", { exact: true }).waitFor();
		await check("reconnect");
		if (width === 1600 || width === 390) await page.screenshot({ path: join(output, `reconnect-${width}.png`) });
		// test-token is shorter than a bare token may be, so it is pasted as the link the server prints.
		await page.getByLabel("Launch link or token", { exact: true }).fill(`[clio-coder:gui] ${origin}/#token=test-token`);
		await page.getByRole("button", { name: "Connect this browser", exact: true }).click();
		await page.locator('.connection[data-connected="true"]').waitFor();
		await page
			.getByRole("heading", { name: "This browser is no longer connected", exact: true })
			.waitFor({ state: "detached" });
		await context.close();
	}
	assert.deepEqual(errors, []);
	assert.deepEqual(failures, []);
	// A refused stream must stop, not reconnect forever: EventSource retries on its own otherwise.
	assert.ok(statuses.filter((item) => item.path === "/api/events" && item.status === 401).length <= 3);
	assert.deepEqual(
		statuses.filter(
			(item) =>
				!(item.path === "/api/workspaces" && item.status === 422) &&
				// The stale-token step: one refused read and at most one refused stream per width.
				!(item.status === 401 && (item.path === "/api/meta" || item.path === "/api/events")),
		),
		[],
	);
	success = true;
} finally {
	// The last thing on screen is usually the whole diagnosis of a timed-out locator.
	if (!success) await failedPage?.screenshot({ path: join(output, "failure.png"), fullPage: false }).catch(() => {});
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
