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
	{ scenario: "markdown", origin: () => origin, clientDir: fileURLToPath(new URL("../dist/client/", import.meta.url)) },
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
			failures.push(`${path}: ${request.failure()?.errorText}`);
		});
		page.on("response", (response) => {
			if (response.status() >= 400) statuses.push({ path: new URL(response.url()).pathname, status: response.status() });
		});
		async function check(name: string) {
			await page.evaluate(() => document.fonts.ready);
			const axe = await new AxeBuilder({ page }).analyze();
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
		await check("home");
		if (width === 1600) await page.screenshot({ path: join(output, "home.png"), fullPage: true });
		await page.getByRole("button", { name: "Dark theme", exact: true }).click();
		await check("home-dark");
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
		if (width === 1600) {
			const opened = context.waitForEvent("page");
			await page.locator('.docs-page a[href="/docs-html/trace_blueprint.html"]').click();
			const blueprint = await opened;
			blueprint.on("pageerror", (error) => errors.push(`Blueprint: ${error.message}`));
			await blueprint.getByRole("button", { name: "Copy code snippet" }).first().waitFor();
			assert.equal(
				await blueprint.evaluate(() => {
					try {
						sessionStorage.getItem("clio-coder-web-token");
						return false;
					} catch {
						return true;
					}
				}),
				true,
				"Blueprint must not inherit application storage",
			);
			await blueprint.close();
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
		statuses.filter((item) => !(item.path === "/api/workspaces" && item.status === 422)),
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
