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

const { values } = parseArgs({
	options: {
		chrome: { type: "string", default: "/usr/bin/google-chrome" },
		// A comma list, for rerunning one breakpoint while fixing it. The gate is all three.
		widths: { type: "string", default: "1600,1050,390" },
		// A private build, so a concurrent `vite build` into dist/client cannot pull pages out from under a run.
		client: { type: "string", default: fileURLToPath(new URL("../dist/client/", import.meta.url)) },
	},
});
const widths = values.widths.split(",").map(Number);
assert.ok(widths.length > 0 && widths.every((width) => [1600, 1050, 390].includes(width)), "widths: 1600, 1050, 390");
const output = await mkdtemp(join(tmpdir(), "clio-web-browser-"));
let origin = "http://127.0.0.1:0";
const h = await harness(
	{ installDelayMs: 150 },
	{
		pwa: true,
		scenario: "markdown",
		origin: () => origin,
		clientDir: values.client,
		// The real runtime always reports its safe settings and targets, so the smoke does too.
		env: { CLIO_CODER_WEB_FIXTURE_ROUTE: "1" },
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
	for (const width of widths) {
		const context = await browser.newContext({ viewport: { width, height: 1050 }, reducedMotion: "reduce" });
		// Turns on `client/render/render-probe.ts`, so the stream check below can count composer renders.
		await context.addInitScript("globalThis.__clioRenderCounts = {};");
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
			// Closing a tab or leaving a trace intentionally closes its EventSource. An image the page
			// replaced before its bytes arrived is cancelled, not broken; a missing one is a 404 below.
			if (
				request.failure()?.errorText === "net::ERR_ABORTED" &&
				(path === "/api/events" || /^\/api\/traces\/runs\/[^/]+\/live$/.test(path) || request.resourceType() === "image")
			)
				return;
			failures.push(
				`${path}: ${request.failure()?.errorText} (${request.resourceType()} on ${new URL(page.url()).pathname})`,
			);
		});
		page.on("response", (response) => {
			if (response.status() >= 400) statuses.push({ path: new URL(response.url()).pathname, status: response.status() });
		});
		async function check(name: string) {
			await page.evaluate(() => document.fonts.ready);
			// A theme change lands as an attribute first; let the cascade and a paint settle before axe reads colours.
			// Without an explicit choice no attribute is set and the system preference decides.
			await page.waitForFunction(
				() =>
					getComputedStyle(document.body).color ===
					((document.documentElement.dataset.theme ??
						(matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark"
						? "rgb(240, 236, 225)"
						: "rgb(26, 22, 18)"),
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
		// Format conformance and contract quality are separate facts; an unmeasured quality never reads as a pass.
		const checkRow = (label: string) => page.locator(".receipt-check", { has: page.getByText(label, { exact: true }) });
		const mark = (label: string, word: string) =>
			checkRow(label).locator(".receipt-check__state .status-mark", { hasText: word }).waitFor();
		await mark("Result format", "Conforms");
		await mark("Result quality", "Not measured");
		await mark("Claimed checks", "1 of 2 claims grounded");
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
		await page.getByLabel("Project folder", { exact: true }).fill(h.home.path);
		await page.getByRole("button", { name: "View saved sessions", exact: true }).click();
		await page.getByRole("button", { name: "New conversation", exact: true }).waitFor();
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
		await page.getByRole("button", { name: /^Fleet · / }).click();
		await setting("fleet.concurrency").getByText("Set by the project layer").waitFor();
		if (await setting("fleet.concurrency").getByRole("combobox").count())
			throw new Error("A project-set value still offers an editor.");
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
		await page.getByRole("heading", { name: "Target use · succeeded", exact: true }).waitFor();
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
		// The change reaches open conversations by reload; with none open the note says so.
		const refreshNote = review.locator(".library-session-note");
		await refreshNote.waitFor();
		assert.doesNotMatch(await refreshNote.innerText(), /did not reload/);
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
		await page.getByRole("button", { name: "New conversation", exact: true }).waitFor();
		await page.getByRole("button", { name: "New conversation", exact: true }).click();
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
		// Name each action's box in the failure, so a wrap on a narrow screen says which control caused it.
		const actionBoxes = await page.locator(".composer__actions > *").evaluateAll((elements) =>
			elements.map((element) => {
				const box = element.getBoundingClientRect();
				return `${element.className || element.tagName}:${Math.round(box.width)}@${Math.round(box.top)}`;
			}),
		);
		assert.ok(
			restingComposer <= 180,
			`resting composer is ${restingComposer}px tall at ${width}px; actions ${actionBoxes.join(", ")}`,
		);
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
		// A `/name` nothing owns is flagged before it is sent; a loaded template is not.
		await composerField.fill("/tpyo fix the build");
		await page.getByText("/tpyo is not a command or prompt template in this session").waitFor();
		await check("composer-unknown-command");
		await composerField.fill("/review-pr 42");
		await page.getByText("is not a command or prompt template").waitFor({ state: "detached" });
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
		// Conversation controls use ACP config options, and saved scope alone can switch targets.
		const route = page.locator(".route-picker");
		await route.locator("summary").click();
		await route.getByText("This conversation.", { exact: true }).waitFor();
		assert.equal(await route.getByLabel("Target", { exact: true }).isDisabled(), true);
		await route.getByLabel("Model", { exact: true }).selectOption("fixture-small");
		await route.getByLabel("Thinking", { exact: true }).selectOption("high");
		await check("route-picker-conversation");
		await route.getByRole("button", { name: "Apply to this conversation", exact: true }).click();
		await route.locator("summary").getByText("fixture · fixture-small", { exact: true }).waitFor();
		await page.waitForFunction(() => !(document.querySelector(".route-picker") as HTMLDetailsElement).open);
		assert.match((await route.locator("summary").getAttribute("title")) ?? "", /Thinking: high/);
		assert.equal(await route.locator("summary").evaluate((element) => document.activeElement === element), true);
		await route.locator("summary").click();
		await route.getByLabel("Apply to", { exact: true }).selectOption("every-project");
		await route.getByText("Saved for every project.", { exact: true }).waitFor();
		await route.getByLabel("Target", { exact: true }).selectOption("field-station");
		assert.equal(await route.getByLabel("Model", { exact: true }).inputValue(), "");
		await route.getByLabel("Model", { exact: true }).selectOption("survey-small");
		await route.getByText(/^field-station answered at /).waitFor();
		await check("route-picker");
		if (width === 1600 || width === 390) await page.screenshot({ path: join(output, `route-picker-${width}.png`) });
		await route.getByRole("button", { name: "Save for every project", exact: true }).click();
		await route.locator("summary").getByText("field-station · survey-small", { exact: true }).waitFor();
		await page.waitForFunction(() => !(document.querySelector(".route-picker") as HTMLDetailsElement).open);
		assert.equal(await route.evaluate((element) => (element as HTMLDetailsElement).open), false);
		assert.equal(await route.locator("summary").evaluate((element) => document.activeElement === element), true);
		// Escape closes it without saving and hands focus back to the chip.
		await route.locator("summary").click();
		await route.getByLabel("Thinking", { exact: true }).selectOption("low");
		await page.keyboard.press("Escape");
		assert.equal(await route.evaluate((element) => (element as HTMLDetailsElement).open), false);
		assert.equal(await route.locator("summary").evaluate((element) => document.activeElement === element), true);
		// Everything else that is not the conversation sits behind one Session tools menu.
		await page.locator(".conversation__tools > summary").click();
		await page.getByRole("button", { name: "Save label", exact: true }).waitFor();
		await page.getByText(/^Choose the target and model beside Send, under the message field\./).waitFor();
		await page.getByRole("combobox", { name: /^Working freedom for new conversations/ }).waitFor();
		await check("session-controls");
		await page.keyboard.press("Escape");
		assert.equal(
			await page.locator(".conversation__tools").evaluate((element) => (element as HTMLDetailsElement).open),
			false,
		);
		assert.equal(
			await page.locator(".conversation__tools > summary").evaluate((element) => document.activeElement === element),
			true,
		);
		await page.locator(".conversation__tools > summary").click();
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
		// The session board: the operator's tasks change through the tasks command, the plan and decisions only read.
		await page.getByText("Tasks and decisions", { exact: true }).click();
		const board = page.locator(".session-board");
		await board.getByText("Read the fixture workspace", { exact: true }).waitFor();
		await board.getByText("Markdown with one table", { exact: false }).waitFor();
		await board.getByText("You have not added a task.", { exact: true }).waitFor();
		await board.getByLabel("Add a task", { exact: true }).fill("Draft the summary");
		await board.getByRole("button", { name: "Add", exact: true }).click();
		await board.getByRole("button", { name: "Mark done: Draft the summary", exact: true }).click();
		await board.locator(".status-mark", { hasText: "Done" }).waitFor();
		await board.getByLabel("Add a task", { exact: true }).fill("Survey the project");
		await board.getByRole("button", { name: "Add", exact: true }).click();
		await board.getByRole("button", { name: "Hand to Clio Coder: Survey the project", exact: true }).click();
		await board.locator(".status-mark", { hasText: "Handed to Clio Coder" }).waitFor();
		await page.locator(".chat-request", { hasText: "/tasks hand u2" }).waitFor();
		await page.getByText("Working on the handed task", { exact: true }).waitFor();
		await page.waitForFunction(
			() => document.activeElement?.getAttribute("aria-label") === "Mark done: Survey the project",
		);
		await page.getByRole("button", { name: "Send", exact: true }).waitFor({ state: "visible" });
		// A decision is corrected in place: it is superseded and the new direction is sent as a request.
		await board.getByRole("button", { name: "Correct: Report format", exact: true }).click();
		await board.getByLabel("New direction", { exact: true }).fill("HTML with one table");
		await board.getByRole("button", { name: "Supersede and tell Clio Coder", exact: true }).click();
		await board
			.getByText("Superseded. The new direction was sent to Clio Coder as a request.", { exact: true })
			.waitFor();
		await page.locator(".chat-request", { hasText: "is superseded by the operator" }).waitFor();
		await board
			.getByRole("button", { name: "Propose for every project: Sample B reads 4.2 on the field instrument.", exact: true })
			.click();
		await board
			.getByText("Every project broadens where this lesson applies. Press again to propose it everywhere.", {
				exact: true,
			})
			.waitFor();
		await board
			.getByRole("button", { name: "Propose for every project: Sample B reads 4.2 on the field instrument.", exact: true })
			.click();
		await board.getByText(/^Proposed memory-k1-global\. Review it/).waitFor();
		await check("session-board-writes");
		if (width === 1600 || width === 390) {
			await board.locator("h3", { hasText: "What Clio Coder learned this session" }).scrollIntoViewIfNeeded();
			await page.screenshot({ path: join(output, `session-board-writes-${width}.png`) });
		}
		await check("session-board-hand");
		await check("session-board");
		if (width === 1600) await page.screenshot({ path: join(output, "session-board.png"), fullPage: true });
		await page.getByText("Tasks and decisions", { exact: true }).click();
		await page.locator(".conversation__tools > summary").click();
		// An image and a text file ride a request when the agent announces image prompts and embedded
		// context: attach both, see them listed, send, see each counted. A binary is refused by name.
		await page.getByRole("button", { name: "Attach files", exact: true }).waitFor();
		const picker = page.locator('.composer input[type="file"]');
		await picker.setInputFiles({
			name: "fixture.png",
			mimeType: "image/png",
			buffer: Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
				"base64",
			),
		});
		await picker.setInputFiles({
			name: "field-notes.md",
			mimeType: "text/markdown",
			buffer: Buffer.from("sample A: 4.2\n"),
		});
		const attachments = page.getByRole("list", { name: "Attachments to send with this request" });
		await attachments.locator(".composer__attachment-name", { hasText: "fixture.png" }).waitFor();
		await attachments.locator(".composer__attachment-name", { hasText: "field-notes.md" }).waitFor();
		await picker.setInputFiles({
			name: "archive.zip",
			mimeType: "application/zip",
			buffer: Buffer.from([0x50, 0x4b, 0x00, 0x03]),
		});
		await page.locator(".composer__notice", { hasText: "archive.zip is not a text file." }).waitFor();
		await check("composer-attachment");
		await page.getByLabel("Message Clio Coder", { exact: true }).fill("Describe the attached image and notes.");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await page.getByText("Received 1 image with the request.", { exact: true }).waitFor();
		await page.getByText("Received 1 file with the request.", { exact: true }).waitFor();
		await page.locator(".chat-request__images", { hasText: "1 image attached" }).waitFor();
		await page.locator(".chat-request__images", { hasText: "1 file attached" }).waitFor();
		assert.equal(await attachments.count(), 0);
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
		assert.match(await refused.innerText(), /not applied · not approved/i);
		assert.match(await refused.innerText(), /Nothing was written/);
		assert.match(await refused.innerText(), /approved/, "The refused content stays readable.");
		await check("permission-rejected");
		if (width === 1600) await page.screenshot({ path: join(output, "permission-rejected.png"), fullPage: true });
		// A plan-scale dispatch: the card names every run and the hash the runs will seal.
		await page.getByLabel("Message Clio Coder", { exact: true }).fill("[plan] Survey the samples and draft a report.");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		const planCard = page.locator(".approval-card", { hasText: "Dispatch plan · 2 runs · in parallel" }).first();
		await planCard.waitFor();
		assert.match(await planCard.innerText(), /Draft the comparison report/);
		assert.match(await planCard.innerText(), /kept for review/);
		assert.match(await planCard.innerText(), /3f2a9c1e04b7/);
		await check("permission-plan");
		if (width === 1600 || width === 390) {
			await planCard.scrollIntoViewIfNeeded();
			await page.screenshot({ path: join(output, `permission-plan-${width}.png`) });
		}
		await page.getByRole("button", { name: "Allow once", exact: true }).first().click();
		await page.getByText("The plan is running.", { exact: true }).waitFor();
		// Dispatch steering. The fixture holds one live worker until it is stopped, so both write
		// paths on a run are pressed for real: guidance is queued, then the run is stopped.
		await page.getByLabel("Message Clio Coder", { exact: true }).fill("[fleet] Survey the fixture.");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		// A running worker is steered from the strip at the transcript's live edge, not from a menu.
		const workers = page.getByRole("region", { name: "1 worker running", exact: true });
		await workers.getByRole("button", { name: "Guide scout", exact: true }).click();
		await page.getByLabel("Guidance for scout", { exact: true }).fill("Only read the README.");
		await page.getByRole("button", { name: "Send guidance", exact: true }).click();
		await page.getByText("Guidance queued. The worker reads it at its next step.", { exact: true }).waitFor();
		assert.equal(
			await workers
				.getByRole("button", { name: "Guide scout", exact: true })
				.evaluate((node) => node === document.activeElement),
			true,
			"sending guidance returns focus to Guide",
		);
		// The runtime keeps the delegation open for the worker's life, so its group stays open too. The
		// row names the agent once and keeps its state word whole, which clipped at 390px while the agent
		// was repeated beside it.
		const delegation = page.locator(".tool-card.is-dispatch").last();
		await delegation.getByText("Running", { exact: true }).waitFor();
		assert.equal(
			await delegation.locator(".tool-card__head").evaluate((head) => {
				const state = head.querySelector(".tool-card__state");
				const bounds = head.getBoundingClientRect();
				const box = state?.getBoundingClientRect();
				return !!state && !!box && box.right <= bounds.right + 1 && state.scrollWidth <= state.clientWidth + 1;
			}),
			true,
			`the delegation's state word is clipped at ${width}px`,
		);
		await check("fleet-steer");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `fleet-steer-${width}.png`), fullPage: true });
		// Session tools keep the whole fleet history, the running row included.
		await page.locator(".conversation__tools > summary").click();
		await page.locator(".conversation__tools .fleet-strip").getByText("Survey the fixture", { exact: true }).waitFor();
		await page.keyboard.press("Escape");
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
		// Stop takes two presses, and the question puts focus on the answer that keeps the work.
		await workers.getByRole("button", { name: "Stop scout", exact: true }).click();
		assert.equal(
			await page
				.getByRole("button", { name: "Keep running", exact: true })
				.evaluate((node) => node === document.activeElement),
			true,
		);
		await check("fleet-stop");
		await page.getByRole("button", { name: "Stop run", exact: true }).click();
		await page.getByText("The worker was stopped.", { exact: true }).waitFor();
		assert.equal(await page.getByRole("button", { name: "Guide scout", exact: true }).count(), 0);
		assert.equal(await page.locator(".live-workers").count(), 0, "a settled run leaves the live strip");
		// Streamed deltas never render the composer: its props are scalars and a route memoized on
		// settings and health. Count across the middle of the workload stream, well after the send's own
		// renders, through Markdown, code, tool bursts and a failed call.
		const composerRenders = () =>
			page.evaluate(
				() => (globalThis as unknown as { __clioRenderCounts: Record<string, number> }).__clioRenderCounts.composer ?? 0,
			);
		await page.getByLabel("Message Clio Coder", { exact: true }).fill("[workload] Audit the convergence notes.");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		const workload = page.locator(".chat-turn").last();
		await workload.getByRole("heading", { name: "Results", exact: true }).waitFor();
		const rendersBefore = await composerRenders();
		await workload.getByRole("heading", { name: "How the levels relate", exact: true }).waitFor();
		assert.equal(await composerRenders(), rendersBefore, "a streamed delta rendered the composer");
		await page.waitForFunction(() => document.querySelector(".session-status")?.textContent?.includes("Ready"));
		await page.getByLabel("Message Clio Coder", { exact: true }).fill("[stream] Show progress until cancelled.");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await page.getByRole("button", { name: "Stop turn", exact: true }).click();
		await page.waitForFunction(() => !document.querySelector(".session-status")?.textContent?.includes("working"));
		await check("cancelled");
		// A fleet contract: preview compiles and starts nothing; the run starts the plan shown.
		await page.locator(".conversation__tools > summary").click();
		await page.getByText("Run a fleet contract", { exact: true }).click();
		const fleetPanel = page.locator(".fleet-run-panel");
		await fleetPanel.getByLabel("Contract name", { exact: true }).fill("survey");
		await fleetPanel.getByLabel("Variables, one name=value per line", { exact: true }).fill("site=plot-7");
		await fleetPanel.getByRole("button", { name: "Preview the plan", exact: true }).click();
		await fleetPanel.getByRole("heading", { name: "Fleet survey: 2 steps in 2 waves", exact: true }).waitFor();
		assert.match(await fleetPanel.innerText(), /Writes reports\//);
		await check("fleet-run-preview");
		if (width === 1600 || width === 390) {
			await fleetPanel.scrollIntoViewIfNeeded();
			await page.screenshot({ path: join(output, `fleet-run-preview-${width}.png`) });
		}
		await fleetPanel.getByRole("button", { name: "Run this plan", exact: true }).click();
		await page.locator(".notice-region .notice", { hasText: "Fleet survey started" }).waitFor();
		// Dismissing the notice is a press outside Session tools, which closes the menu.
		await page.getByRole("button", { name: "Dismiss Fleet survey started", exact: true }).click();
		await page.waitForFunction(() => !(document.querySelector(".conversation__tools") as HTMLDetailsElement).open);
		// Extensions: what this conversation loaded, and a reload that says which generation is live.
		await page.locator(".conversation__tools > summary").click();
		await page.getByText("Extensions", { exact: true }).click();
		const extensionsPanel = page.locator(".extensions-panel");
		await extensionsPanel.getByText("survey-tools 1.2.0 · project scope", { exact: true }).waitFor();
		await extensionsPanel.getByRole("button", { name: "Reload extensions", exact: true }).click();
		await extensionsPanel.getByText(/^Generation \d+ is live \(no changes\); 2 hooks registered\.$/).waitFor();
		await check("extensions");
		await page.getByText("Extensions", { exact: true }).click();
		await page.keyboard.press("Escape");
		// Usage: the conversation's spend in the agent's own words, and each provider's windows.
		await page.locator(".conversation__tools > summary").click();
		await page.getByText("Usage and quota", { exact: true }).click();
		const usagePanel = page.locator(".usage-panel");
		await usagePanel.locator(".session-board__title", { hasText: "local · fixture-model" }).waitFor();
		await usagePanel.getByText("Beside the conversation: 1 side question", { exact: true }).waitFor();
		await usagePanel.getByRole("meter", { name: "5h used", exact: true }).waitFor();
		await check("usage");
		if (width === 1600 || width === 390) {
			await usagePanel.scrollIntoViewIfNeeded();
			await page.screenshot({ path: join(output, `usage-${width}.png`) });
		}
		await page.getByText("Usage and quota", { exact: true }).click();
		await page.keyboard.press("Escape");
		await page.waitForFunction(() => !(document.querySelector(".conversation__tools") as HTMLDetailsElement).open);
		// Beside the conversation: a side question and drafts answer in place and add no turn.
		await page.locator(".conversation__tools > summary").click();
		await page.getByText("Ask beside the conversation", { exact: true }).click();
		const aside = page.locator(".aside-panel");
		const turnsBefore = await page.locator(".chat-request").count();
		await aside.getByLabel("Side question", { exact: true }).fill("Which file holds the readings?");
		await aside.getByRole("button", { name: "Ask", exact: true }).click();
		await aside.getByText("The readings are in README.md.", { exact: true }).waitFor();
		await aside.getByLabel("Request to draft", { exact: true }).fill("How should the report show readings?");
		await aside.getByLabel("Drafts", { exact: true }).selectOption("2");
		await aside.getByRole("button", { name: "Draft", exact: true }).click();
		await aside.getByText("fixture/judge picked A in 12 ms.", { exact: true }).waitFor();
		await check("aside");
		if (width === 1600 || width === 390) {
			await aside.scrollIntoViewIfNeeded();
			await page.screenshot({ path: join(output, `aside-${width}.png`) });
		}
		assert.equal(await page.locator(".chat-request").count(), turnsBefore, "an aside added a turn");
		await aside.getByRole("button", { name: "Put in composer", exact: true }).first().click();
		assert.equal(
			await page.getByLabel("Message Clio Coder", { exact: true }).inputValue(),
			"Show the readings in one table with a unit column.",
		);
		await page.getByLabel("Message Clio Coder", { exact: true }).fill("");
		// Filling the composer moves focus out of Session tools; reopen it if that closed it, then fold the panel.
		if (!(await page.locator(".conversation__tools").evaluate((element) => (element as HTMLDetailsElement).open)))
			await page.locator(".conversation__tools > summary").click();
		await page.getByText("Ask beside the conversation", { exact: true }).click();
		await page.keyboard.press("Escape");
		await page.waitForFunction(() => !(document.querySelector(".conversation__tools") as HTMLDetailsElement).open);
		// The context window: Clio Coder's own accounting, worded and never recomputed.
		await page.locator(".conversation__tools > summary").click();
		await page.getByText("Context window", { exact: true }).click();
		const contextPanel = page.locator(".context-panel");
		await contextPanel.getByText("20,480 tokens in use (16%), measured by the provider.", { exact: true }).waitFor();
		await contextPanel.getByRole("rowheader", { name: "Conversation", exact: true }).waitFor();
		await check("context-window");
		if (width === 1600 || width === 390) {
			await contextPanel.scrollIntoViewIfNeeded();
			await page.screenshot({ path: join(output, `context-window-${width}.png`) });
		}
		await page.getByText("Context window", { exact: true }).click();
		await page.keyboard.press("Escape");
		// Branches: continuing from an earlier reply replays only that branch; forking moves the
		// conversation to a new session and says the project's files were left alone.
		await page.locator(".conversation__tools > summary").click();
		await page.getByText("Branches", { exact: true }).click();
		const branches = page.locator(".branch-panel");
		await branches.getByText("The next request continues here", { exact: false }).waitFor();
		await check("branches");
		if (width === 1600 || width === 390) {
			await branches.locator("ol").scrollIntoViewIfNeeded();
			await page.screenshot({ path: join(output, `branches-${width}.png`) });
		}
		await branches
			.getByRole("button", { name: "Continue from this reply: The second sample reads 4.2", exact: true })
			.click();
		await page.locator(".chat-request", { hasText: "Measure the second sample" }).waitFor();
		assert.equal(
			await page.locator(".chat-request", { hasText: "[stream] Show progress until cancelled." }).count(),
			0,
			"the branch left behind is not replayed",
		);
		await page.waitForFunction(() => document.activeElement?.textContent === "Branches", undefined, { timeout: 5000 });
		const parentUrl = page.url();
		await branches
			.locator("li", { hasText: "The second sample reads 4.2" })
			.getByText("The next request continues here", { exact: false })
			.waitFor();
		await branches
			.getByRole("button", { name: "Fork a new conversation from this reply: Earlier reply", exact: true })
			.click();
		await page.waitForURL((url) => url.href !== parentUrl && url.pathname.startsWith("/sessions/"));
		await page.locator(".notice-region .notice", { hasText: "Workspace files were not rewound" }).waitFor();
		await page.locator(".chat-request", { hasText: "Earlier prompt" }).waitFor();
		assert.equal(await page.locator(".chat-request", { hasText: "Measure the second sample" }).count(), 0);
		await check("session-forked");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `session-forked-${width}.png`), fullPage: true });
		for (const title of [/^Dismiss Continuing from/, /^Dismiss Conversation forked$/]) {
			const dismiss = page.getByRole("button", { name: title });
			if (await dismiss.count()) await dismiss.click();
		}
		// Handoff: a draft is reviewed and edited before anything is written; starting the new
		// conversation moves there.
		await page.locator(".conversation__tools > summary").click();
		await page.getByText("Hand off to a new conversation", { exact: true }).click();
		const handoff = page.locator(".handoff-panel");
		await handoff
			.getByLabel("What should the next conversation accomplish?", { exact: true })
			.fill("Finish the survey report");
		await handoff.getByRole("button", { name: "Draw up the handoff", exact: true }).click();
		const reviewField = handoff.getByLabel("Handoff document", { exact: true });
		await reviewField.waitFor();
		assert.match(await reviewField.inputValue(), /Goal: Finish the survey report/);
		await reviewField.fill(`${await reviewField.inputValue()}\nReviewed in the smoke.\n`);
		await check("handoff-review");
		if (width === 1600 || width === 390) {
			await handoff.scrollIntoViewIfNeeded();
			await page.screenshot({ path: join(output, `handoff-review-${width}.png`) });
		}
		const forkedUrl = page.url();
		await handoff.getByRole("button", { name: "Start the new conversation", exact: true }).click();
		await page.waitForURL((url) => url.href !== forkedUrl && url.pathname.startsWith("/sessions/"));
		await page.locator(".notice-region .notice", { hasText: "Handed off" }).waitFor();
		await check("handed-off");
		await page.getByRole("button", { name: "Dismiss Handed off", exact: true }).click();
		// Close lives at the foot of Session tools, away from the composer's Stop.
		await page.locator(".conversation__tools > summary").click();
		await page.getByRole("button", { name: "Close session", exact: true }).click();
		await page.waitForFunction(() => document.querySelector(".session-status")?.textContent?.includes("closed"));
		await page.getByText("This conversation is closed.", { exact: true }).waitFor();
		await check("closed");
		await navigate("Sessions");
		await page.getByLabel("Project folder", { exact: true }).fill(join(h.home.path, "does-not-exist"));
		await page.getByRole("button", { name: "Start conversation", exact: true }).click();
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
		await page.locator('.connection[data-state="Not connected"]').waitFor();
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
