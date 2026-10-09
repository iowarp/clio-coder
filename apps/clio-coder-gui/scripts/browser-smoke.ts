import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { AxeBuilder } from "@axe-core/playwright";
import { serve } from "@hono/node-server";
import { type BrowserContext, chromium, type Locator } from "playwright-core";
import type { SettingsControls } from "../contracts/settings-controls.js";
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
		// A comma list, for rerunning one breakpoint while fixing it. The final gate includes 320px.
		widths: { type: "string", default: "1600,1050,390,320" },
		"zoom-only": { type: "boolean", default: false },
		// A private build, so a concurrent `vite build` into dist/client cannot pull pages out from under a run.
		client: { type: "string", default: fileURLToPath(new URL("../dist/client/", import.meta.url)) },
	},
});
const widths = values.widths.split(",").map(Number);
assert.ok(
	widths.length > 0 && widths.every((width) => [1600, 1440, 1050, 400, 390, 320].includes(width)),
	"widths: 1600, 1440, 1050, 400, 390, 320",
);
const scratch = fileURLToPath(new URL("../../../tmp/gui-validation/", import.meta.url));
await mkdir(scratch, { recursive: true });
process.env.TMPDIR ??= scratch;
const output = await mkdtemp(join(scratch, "browser-"));
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
await seedSettings(h.home.path, h.home.env, "fixture");
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
	checks: {
		page: string;
		width: number;
		zoom: number;
		seriousOrCritical: number;
		minorOrModerate: string[];
		overflow: boolean;
	}[] = [];
// The last run uses Chrome's native 200% page zoom in a fresh profile. Its layout viewport
// is 800 CSS pixels inside a 1600px window; neither CSS zoom nor pinch scaling is applied.
const runs = [...(values["zoom-only"] ? [] : widths.map((width) => ({ width, zoom: 1 }))), { width: 800, zoom: 2 }];
const statuses: { path: string; status: number }[] = [];
const zoomMeasurements: { outerWidth: number; innerWidth: number; devicePixelRatio: number; visualScale: number }[] =
	[];
let zoomContext: BrowserContext | null = null;
let zoomProfile: string | null = null;
let success = false;
let failedPage: { screenshot(options: { path: string; fullPage: boolean }): Promise<unknown> } | null = null;
try {
	for (const [runIndex, { width, zoom }] of runs.entries()) {
		let context: BrowserContext;
		if (zoom === 2) {
			zoomProfile = await mkdtemp(join(process.env.TMPDIR ?? scratch, "clio-zoom-"));
			await mkdir(join(zoomProfile, "Default"));
			// Chromium's persisted default zoom is log-base-1.2 of the zoom factor. The default
			// storage partition's relative path is empty, represented by the preference key x.
			await writeFile(
				join(zoomProfile, "Default", "Preferences"),
				JSON.stringify({ partition: { default_zoom_level: { x: Math.log(2) / Math.log(1.2) } } }),
			);
			zoomContext = await chromium.launchPersistentContext(zoomProfile, {
				executablePath: values.chrome,
				headless: true,
				viewport: null,
				colorScheme: "light",
				reducedMotion: "reduce",
				args: ["--disable-dev-shm-usage", "--window-size=1600,1050"],
			});
			context = zoomContext;
		} else {
			context = await browser.newContext({
				viewport: { width, height: 1050 },
				colorScheme: "light",
				reducedMotion: "reduce",
			});
		}
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
		let evidenceReads = 0;
		const apiWrites: string[] = [];
		page.on("request", (request) => {
			const path = new URL(request.url()).pathname;
			if (path === "/api/evidence" && request.method() === "GET") evidenceReads++;
			if (path.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(request.method()))
				apiWrites.push(`${request.method()} ${path}`);
		});
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
		async function check(name: string, checkedPage = page) {
			await checkedPage.evaluate(() => document.fonts.ready);
			// A theme change lands as an attribute first; let the cascade and a paint settle before axe reads colours.
			// Without an explicit choice no attribute is set and the system preference decides.
			await checkedPage.waitForFunction(
				() =>
					getComputedStyle(document.body).color ===
					((document.documentElement.dataset.theme ??
						(matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark"
						? "rgb(242, 243, 242)"
						: "rgb(26, 22, 18)"),
			);
			await checkedPage.evaluate(
				() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
			);
			const builder = new AxeBuilder({ page: checkedPage });
			const axe = await builder.analyze();
			assert.deepEqual(
				axe.violations.filter((item) => item.id === "aria-allowed-role"),
				[],
				`${name} has an invalid ARIA role at ${width}px`,
			);
			const serious = axe.violations.filter((item) => item.impact === "serious" || item.impact === "critical");
			const overflow = await checkedPage.evaluate(
				() => document.documentElement.scrollWidth > document.documentElement.clientWidth,
			);
			checks.push({
				page: name,
				width,
				zoom,
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
		// The rail is a drawer on a phone (`client/app.tsx` PHONE) and a column beside the card otherwise.
		const phone = (zoom === 2 ? 800 : width) <= 760;
		async function revealSidebar() {
			if (await page.locator('.wb[data-drawer="open"]').count()) return;
			if (!phone && (await page.locator('.wb[data-sidebar="expanded"]').count())) return;
			await page.getByRole("button", { name: "Show sidebar", exact: true }).filter({ visible: true }).first().click();
			await page.locator(".wb-sidebar .wb-side").filter({ visible: true }).waitFor();
		}
		// Settings mode swaps the task rail for its own list of places; the gear at the rail's foot enters it.
		async function navigate(label: string) {
			await revealSidebar();
			const places = page.getByRole("navigation", { name: "Settings", exact: true });
			if (!(await places.count())) {
				await page.locator(".wb-sidebar").getByRole("link", { name: "Settings", exact: true }).click();
				await places.waitFor();
				await revealSidebar();
			}
			await places.getByRole("link", { name: label, exact: true }).click();
			await places.locator('a[aria-current="page"]', { hasText: label }).waitFor({ state: "attached" });
		}
		async function leaveSettings() {
			await revealSidebar();
			await page.locator(".wb-sidebar").getByRole("link", { name: "Back to work", exact: true }).click();
			await page.getByRole("navigation", { name: "Settings", exact: true }).waitFor({ state: "detached" });
		}
		// Dark checks follow the device preference; the explicit choice is exercised on General below.
		async function dark(on: boolean) {
			await page.emulateMedia({ colorScheme: on ? "dark" : "light" });
		}
		await page.goto(`${origin}/#token=test-token`);
		await page.getByRole("heading", { level: 1 }).waitFor();
		if (zoom === 2) {
			const measurement = await page.evaluate(() => ({
				outerWidth,
				innerWidth,
				devicePixelRatio,
				visualScale: visualViewport?.scale ?? 0,
			}));
			zoomMeasurements.push(measurement);
			assert.deepEqual(measurement, { outerWidth: 1600, innerWidth: 800, devicePixelRatio: 2, visualScale: 1 });
			assert.equal(await page.locator("body").evaluate((body) => getComputedStyle(body).zoom), "1");
			await page.bringToFront();
		}
		// The new-task field takes focus on a fine pointer, so the skip link is the first stop on a page
		// that opens without a focused field.
		await page.goto(`${origin}/settings/general`);
		await page.locator("main").getByRole("heading", { name: "General", exact: true }).waitFor();
		await page.keyboard.press("Tab");
		assert.equal(await page.locator(".skip-link").evaluate((element) => document.activeElement === element), true);
		await page.keyboard.press("Enter");
		assert.equal(await page.locator("#main").evaluate((element) => document.activeElement === element), true);
		await page.goto(`${origin}/`);
		await page.getByRole("heading", { level: 1 }).waitFor();
		assert.equal(await page.locator("footer").count(), 0);
		const header = await page.locator(".wb-bar").boundingBox();
		assert.ok(header && header.height <= 60);
		// The brand is the drawn Clio mark, an inline SVG that animates while a task works.
		const brand = await page.locator(".wb-brand svg").first().boundingBox();
		assert.ok(brand !== null && brand.width > 0, "the brand mark is drawn");
		assert.equal(await page.evaluate(() => localStorage.getItem("clio-coder-gui-theme")), null);
		await page.emulateMedia({ colorScheme: "dark" });
		assert.equal(await page.locator("html").getAttribute("data-theme"), null);
		assert.equal(await page.evaluate(() => localStorage.getItem("clio-coder-gui-theme")), null);
		await check("home-system-dark");
		await page.emulateMedia({ colorScheme: "light", reducedMotion: "no-preference" });
		await page.waitForFunction(() => {
			const button = document.querySelector("button");
			return (
				button &&
				getComputedStyle(button)
					.transitionDuration.split(",")
					.some((value) => parseFloat(value) > 0.001)
			);
		});
		await page.emulateMedia({ reducedMotion: "reduce" });
		await page.waitForFunction(() => {
			const button = document.querySelector("button");
			return (
				button &&
				getComputedStyle(button)
					.transitionDuration.split(",")
					.every((value) => parseFloat(value) <= 0.000001)
			);
		});
		assert.equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), true);
		await check("home-live-preferences");
		await check("home");
		if (width === 1600) await page.screenshot({ path: join(output, "home.png"), fullPage: true });
		if (width === 320) await page.screenshot({ path: join(output, "320-home-light.png"), fullPage: true });
		if (phone) {
			const opener = page.locator(".wb-bar").getByRole("button", { name: "Show sidebar", exact: true });
			await opener.click();
			await page.locator('.wb[data-drawer="open"]').waitFor();
			await check("navigation");
			// Escape closes the drawer and hands focus back to the button that opened it.
			await page.keyboard.press("Escape");
			await page.locator('.wb[data-drawer="closed"]').waitFor({ state: "attached" });
			assert.equal(await opener.evaluate((node) => document.activeElement === node), true);
		}
		// Install, the browser's connection and the theme moved from the masthead to General settings.
		await navigate("General");
		await page.locator("main").getByRole("heading", { name: "General", exact: true }).waitFor();
		await page.getByRole("button", { name: "Forget this browser" }).waitFor();
		await check("app-preferences");
		// An explicit choice wins over the device and is remembered; System stores nothing.
		await page.getByRole("radio", { name: /^Dark/ }).check({ force: true });
		await page.locator(':root[data-theme="dark"]').waitFor();
		assert.equal(await page.evaluate(() => localStorage.getItem("clio-coder-gui-theme")), "dark");
		await check("app-preferences-dark");
		await leaveSettings();
		await check("home-dark");
		await page.screenshot({ path: join(output, `${width}-home-dark.png`), fullPage: true });
		await navigate("General");
		await page.getByRole("radio", { name: /^System/ }).check({ force: true });
		await page.locator(":root:not([data-theme])").waitFor();
		assert.equal(await page.evaluate(() => localStorage.getItem("clio-coder-gui-theme")), null);
		await navigate("Toolchain");
		await page.getByRole("article", { name: "herdr", exact: true }).waitFor();
		await check("toolchain");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `toolchain-${width}.png`), fullPage: true });
		await navigate("Traces");
		await page.locator('main a[href^="/traces/run-0000"]').waitFor();
		await check("traces");
		await page.locator('main a[href^="/traces/run-0000"]').click();
		await page.locator("main").getByRole("heading", { name: "Inspect fixture 0", exact: true }).waitFor();
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
		await page.locator("main").getByRole("heading", { name: "Fleet executions", exact: true }).waitFor();
		await page.getByText("not a live event stream", { exact: false }).waitFor();
		await check("fleet");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `fleet-${width}.png`), fullPage: true });
		await page.locator('main a[href^="/fleet/fleet-149"]').click();
		await page.getByText("Inspect worker output", { exact: true }).click();
		await page.getByText("Fixture step passed.", { exact: true }).waitFor();
		await page
			.locator("main")
			.getByRole("heading", { name: "review · pass", exact: true })
			.waitFor({ state: "attached" });
		await check("fleet-run");
		await dark(true);
		await check("fleet-run-dark");
		await page.goto(`${origin}/evidence`);
		await page.locator('main a[href^="/evidence/evidence-039"]').waitFor();
		await check("evidence");
		await page.locator('main a[href^="/evidence/evidence-039"]').click();
		await page.locator("main").getByRole("heading", { name: "Trust by run", exact: true }).waitFor();
		await check("evidence-detail-dark");
		await dark(false);
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
		await page.keyboard.press("Control+/");
		await page.getByRole("heading", { name: "Shortcuts & help", exact: true }).waitFor();
		await page.getByRole("searchbox", { name: "Search shortcuts and help", exact: true }).waitFor();
		assert.equal(await page.getByRole("link", { name: "Open public documentation ↗", exact: true }).count(), 0);
		await page.getByRole("button", { name: "Documentation", exact: true }).click();
		const publicHelp = page.getByRole("link", { name: "Open public documentation ↗", exact: true });
		assert.equal(await publicHelp.getAttribute("href"), "https://coder.iowarp.ai/docs.html");
		assert.equal(await publicHelp.getAttribute("referrerpolicy"), "no-referrer");
		await check("help");
		await page.keyboard.press("Escape");
		assert.equal(await page.getByRole("link", { name: "Docs", exact: true }).count(), 0);
		await page.goto(`${origin}/docs/architecture/trace-store.md`);
		await page
			.locator("main")
			.getByRole("heading", { name: "Documentation is on the public site.", exact: true })
			.waitFor();
		assert.equal(await page.locator(".docs-page, iframe").count(), 0);
		assert.equal(
			await page.getByRole("link", { name: "Open documentation ↗", exact: true }).getAttribute("href"),
			"https://coder.iowarp.ai/docs.html",
		);
		await check("legacy-help");
		if (!phone) {
			// The rail folds away entirely and one visible control brings it back.
			await page.keyboard.press("Control+\\");
			await page.locator('.wb[data-sidebar="collapsed"]').waitFor();
			await page.locator(".wb-sidebar .wb-side").waitFor({ state: "hidden" });
			await check("help-rail-collapsed");
			if (width === 1600) await page.screenshot({ path: join(output, "navigation-collapsed-1600.png"), fullPage: true });
			await page.getByRole("button", { name: "Show sidebar", exact: true }).filter({ visible: true }).first().click();
			await page.locator('.wb[data-sidebar="expanded"]').waitFor();
			await page.locator(".wb-sidebar").getByRole("button", { name: "Collapse sidebar", exact: true }).waitFor();
			assert.equal(
				await page.getByRole("navigation", { name: "Settings", exact: true }).getByRole("link").count(),
				12,
				"every settings place stays listed once the rail returns",
			);
		}
		// A project opens from the rail's Open workspace dialog, which starts a task in it; the project's
		// own page lists its tasks and offers New task.
		await leaveSettings();
		await revealSidebar();
		await page
			.locator(".wb-sidebar")
			.getByRole("button", { name: /^Open workspace/ })
			.click();
		const openDialog = page.getByRole("dialog", { name: "Open workspace", exact: true });
		await openDialog.getByLabel("Project folder", { exact: true }).fill(h.home.path);
		await openDialog.getByRole("button", { name: "Open", exact: true }).click();
		await page.waitForURL(/\/sessions\/[^/]+$/);
		await page.getByLabel("Message Clio Coder", { exact: true }).waitFor();
		const noticeSessionUrl = page.url();
		await page.locator(".conversation .wb-bar .wb-menu summary").click();
		await page.getByRole("menuitem", { name: /^All tasks in / }).click();
		await page.waitForURL(/\/workspaces\/[^/]+\/sessions$/);
		await page.locator("main button.primary", { hasText: "New task" }).waitFor();
		await page
			.locator("main")
			.getByRole("heading", { name: /^All tasks/ })
			.waitFor();
		await check("sessions");
		const workspaceUrl = page.url();
		await navigate("All settings");
		// The write surface: a select saves through the engine, a project-set value refuses, a destructive
		// change needs its named confirmation. All settings' search reaches every control by its path.
		const setting = (path: string) =>
			page.locator("main .setting-control", { has: page.locator("code", { hasText: path }) });
		const findSetting = page.locator("main").getByLabel("Find a setting", { exact: true });
		await findSetting.fill("chat.thinkingLevel");
		const thinking = setting("chat.thinkingLevel");
		const level = (await thinking.getByRole("combobox").inputValue()) === "low" ? "high" : "low";
		await thinking.getByRole("combobox").selectOption(level);
		const historyNotice = page
			.locator(".notice", {
				hasText: "This Clio build does not expose session history.",
			})
			.last();
		const saveThinking = thinking.getByRole("button", { name: "Save", exact: true });
		await saveThinking.scrollIntoViewIfNeeded();
		assert.equal(await historyNotice.isVisible(), true, "the notice is present while Save is used");
		const noticeBounds = await page.locator(".notice-region").boundingBox();
		const saveBounds = await saveThinking.boundingBox();
		assert.ok(noticeBounds && saveBounds);
		assert.ok(
			saveBounds.y + saveBounds.height <= noticeBounds.y ||
				noticeBounds.y + noticeBounds.height <= saveBounds.y ||
				saveBounds.x + saveBounds.width <= noticeBounds.x ||
				noticeBounds.x + noticeBounds.width <= saveBounds.x,
			`notifications must not cover Save at ${width}px`,
		);
		assert.equal(
			await saveThinking.evaluate((button) => {
				const rect = button.getBoundingClientRect();
				return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
			}),
			true,
			"Save receives pointer input while the notification is visible",
		);
		if (width === 390 || width === 400)
			await page.screenshot({ path: join(output, `notice-save-${width}.png`), fullPage: true });
		await saveThinking.click({ timeout: 1_000 });
		assert.equal(await historyNotice.isVisible(), true, "Save does not wait for notification dismissal");
		await thinking.getByRole("status").getByText("Used by the next relevant request").waitFor();
		await check("settings-saved");
		// A loaded approval can precede its tool-call history. Exercise the full banner beside a
		// growing draft and a full notice row, including the short viewport where the task must scroll.
		const noticeSessionId = new URL(noticeSessionUrl).pathname.split("/").at(-1);
		assert.ok(noticeSessionId);
		const noticePage = await context.newPage();
		noticePage.on("pageerror", (error) => errors.push(error.message));
		await noticePage.route(`**/api/sessions/${noticeSessionId}{,/**}`, async (route) => {
			const path = new URL(route.request().url()).pathname;
			if (path === `/api/sessions/${noticeSessionId}`) {
				await route.fulfill({
					json: {
						...h.supervisor.get(noticeSessionId),
						permissions: [
							{
								id: "notice-approval",
								turnId: "notice-turn",
								toolCallId: "notice-call",
								title: "Run a command",
								kind: "execute",
								requestedAt: new Date().toISOString(),
								escalateAt: "2099-01-01T00:00:00Z",
								expiresAt: "2099-01-02T00:00:00Z",
								status: "pending",
								canStopTurn: false,
							},
						],
					},
				});
			} else {
				await route.fulfill({
					status: 503,
					json: {
						type: "urn:clio-coder:problem:unavailable",
						title: "Notice layout check",
						status: 503,
						code: "unavailable",
						detail: "The request could not complete. ".repeat(8),
						instance: path,
					},
				});
			}
		});
		try {
			await noticePage.goto(`${noticeSessionUrl}#token=test-token`);
			const draft = noticePage.getByLabel("Message Clio Coder", { exact: true });
			await draft.fill("A draft line\n".repeat(12));
			await noticePage.locator(".approval-banner:not(.approval-banner--strip)").waitFor();
			await noticePage.getByRole("button", { name: "Dismiss all", exact: true }).waitFor();
			for (const height of zoom === 2 ? [await noticePage.evaluate(() => innerHeight)] : [900, 450]) {
				if (zoom !== 2) await noticePage.setViewportSize({ width, height });
				const receivesPointer = (control: Locator) =>
					control.evaluate((element) => {
						const rect = element.getBoundingClientRect();
						return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
					});
				for (const name of ["Reject", "Allow once"]) {
					const answer = noticePage.locator(".conversation__approval").getByRole("button", { name, exact: true });
					await answer.scrollIntoViewIfNeeded();
					assert.equal(await receivesPointer(answer), true, `${name} stays reachable with notices at ${width}×${height}`);
					await answer.click({ trial: true, timeout: 1_000 });
				}
				const transcript = noticePage.locator(".chat-transcript");
				await transcript.scrollIntoViewIfNeeded();
				const transcriptBounds = await transcript.boundingBox();
				assert.ok(transcriptBounds && transcriptBounds.height >= 64, "the transcript keeps a readable scrolling viewport");
				assert.equal(await receivesPointer(transcript), true, "the transcript stays reachable beside approval and draft");
				const submit = noticePage.locator(".composer__submit");
				await submit.scrollIntoViewIfNeeded();
				assert.equal(await receivesPointer(submit), true, "the composer controls stay reachable with notices");
				const noticeList = noticePage.locator(".notice-region__list");
				assert.equal(await noticeList.evaluate((list) => list.scrollHeight > list.clientHeight), true);
				await noticeList.evaluate((list) => {
					list.scrollTop = 100;
				});
				const dismiss = noticePage.locator(".notice__heading button").first();
				await dismiss.focus();
				assert.equal(await dismiss.evaluate((button) => button === document.activeElement), true);
				assert.equal(await receivesPointer(dismiss), true, "the focused individual Dismiss stays above the notice list");
				await dismiss.click({ trial: true, timeout: 1_000 });
				await check(`notice-approval-${height}`, noticePage);
				await noticePage.screenshot({ path: join(output, `notice-approval-${width}-${height}.png`) });
			}
		} finally {
			await noticePage.close();
		}
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `settings-controls-${width}.png`), fullPage: true });
		await findSetting.fill("fleet.concurrency");
		await setting("fleet.concurrency").getByText("Set by the project layer").waitFor();
		if (await setting("fleet.concurrency").getByRole("combobox").count())
			throw new Error("A project-set value still offers an editor.");
		await findSetting.fill("fleet.history.maxRuns");
		const history = setting("fleet.history.maxRuns");
		await history.getByRole("spinbutton").fill(String(900 - runIndex * 100));
		if (!(await history.getByRole("button", { name: "Save", exact: true }).isDisabled()))
			throw new Error("A destructive setting saved without its confirmation.");
		await history.getByRole("checkbox").check();
		await check("settings-confirm");
		if (width === 1600) await page.screenshot({ path: join(output, "settings-confirm.png"), fullPage: true });
		await history.getByRole("button", { name: "Save", exact: true }).click();
		await history.getByRole("status").waitFor();
		await findSetting.fill("no-such-setting-anywhere");
		await page.getByText("No settings match.", { exact: true }).waitFor();
		await dark(true);
		await findSetting.fill("retry");
		await check("settings-controls-dark");
		await dark(false);
		await page
			.locator("main")
			.getByRole("link", { name: /^Effective values/ })
			.click();
		await page.getByLabel("Filter settings", { exact: true }).fill("chat.model");
		await page.getByText("fixture-local-model", { exact: true }).waitFor();
		await check("settings-inspection");
		if (width === 1600 || width === 390) await page.screenshot({ path: join(output, `settings-${width}.png`) });
		await dark(true);
		await check("settings-inspection-dark");
		await dark(false);
		await page.getByRole("link", { name: "Advanced: configuration sources", exact: true }).click();
		await page.locator("main").getByRole("heading", { name: "fixture-hook", exact: true }).waitFor();
		await page.locator("main").getByRole("heading", { name: "From source to behavior", exact: true }).waitFor();
		await check("config-graph");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `config-graph-${width}.png`), fullPage: true });
		await dark(true);
		await check("config-graph-dark");
		await dark(false);
		// Adding a connection is the guided setup's job; it opens from Models and closes back there.
		await navigate("Models");
		const controlsPath = "**/api/workspaces/*/settings/controls";
		await page.route(controlsPath, async (route) => {
			const response = await route.fetch();
			const report = (await response.json()) as SettingsControls;
			await route.fulfill({
				json: {
					...report,
					controls: report.controls.map((control) =>
						control.path === "chat.target"
							? { ...control, value: "fixture" }
							: control.path === "chat.model"
								? { ...control, access: "writable" }
								: control,
					),
				},
			});
		});
		await page.reload();
		const catalogSelect = page.locator(".model-select select").first();
		await catalogSelect.waitFor();
		const modelId = await catalogSelect.getAttribute("id");
		const modelField = page.locator(".model-select").filter({ has: page.locator(`[id="${modelId}"]`) });
		await modelField.locator("select").selectOption({ label: "Advanced: unverified model id…" });
		await modelField.getByRole("button", { name: "Choose from the list", exact: true }).click();
		assert.equal(await modelField.locator("select").evaluate((element) => element === document.activeElement), true);
		await page.unroute(controlsPath);
		await page.reload();
		await page
			.locator("main")
			.getByRole("link", { name: /^Add a connection/ })
			.click();
		await page.getByRole("heading", { name: "Where does your model come from?", exact: true }).waitFor();
		await check("targets-onboarding");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `targets-onboarding-${width}.png`), fullPage: true });
		await page.getByRole("button", { name: "Close", exact: true }).click();
		await page.waitForURL((url) => url.pathname === "/settings/models");
		await page
			.locator("main")
			.getByRole("link", { name: /^Connections/ })
			.click();
		await page.getByRole("article", { name: "fixture", exact: true }).waitFor();
		await check("targets");
		await page
			.getByRole("article", { name: "fixture", exact: true })
			.getByRole("button", { name: "Use for chat & fleet", exact: true })
			.click();
		await page.locator("main").getByRole("heading", { name: "Connection use · succeeded", exact: true }).waitFor();
		await dark(true);
		await check("targets-dark");
		await dark(false);
		await page.getByRole("link", { name: "Fleet routes", exact: true }).click();
		await page
			.locator("main")
			.getByRole("heading", { name: /^Agent bindings ·/ })
			.waitFor();
		await check("routing");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `routing-${width}.png`), fullPage: true });
		await dark(true);
		await check("routing-dark");
		await page.goto(`${origin}/usage`);
		await page.locator("main").getByRole("heading", { name: "Token composition", exact: true }).waitFor();
		// The five bars compare fields with one another, which is the one thing a reader can get
		// wrong by looking; the caveat is part of the panel, not a footnote that can drift away.
		await page.getByText("they are not additive percentages", { exact: false }).waitFor();
		await check("usage-dark");
		await dark(false);
		await check("usage");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `usage-${width}.png`), fullPage: true });
		await navigate("Library");
		// The catalog is the landing collection: plan, review, apply, then remove, all against the bundled index.
		const offer = page.locator("main").getByRole("listitem", { name: "skill:map-codebase", exact: true });
		await offer.waitFor();
		await check("library-catalog");
		await offer.getByRole("button", { name: "Install skill:map-codebase for me", exact: true }).click();
		const review = page.getByRole("dialog", { name: "Install skill:map-codebase", exact: true });
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
		if (await offer.getByRole("button", { name: "Install skill:map-codebase for me", exact: true }).count())
			throw new Error("An installed user copy still offers a user install.");
		await offer.getByRole("button", { name: "Install skill:map-codebase in this project", exact: true }).waitFor();
		await page
			.locator("main")
			.getByRole("button", { name: /^Installed only · [1-9]/ })
			.click();
		await check("library-installed");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `library-installed-${width}.png`), fullPage: true });
		await dark(true);
		await check("library-installed-dark");
		if (width === 1600) await page.screenshot({ path: join(output, "library-installed-dark.png"), fullPage: true });
		await dark(false);
		await offer.getByRole("button", { name: "Remove the user copy of skill:map-codebase", exact: true }).click();
		const removal = page.getByRole("dialog", { name: "Remove skill:map-codebase", exact: true });
		await removal.getByRole("button", { name: "Apply this change", exact: true }).click();
		await removal.getByText("The files and the install record are gone.").waitFor();
		await removal.getByRole("button", { name: "Done", exact: true }).click();
		await offer.waitFor({ state: "detached" });
		await page.locator("main").getByRole("listitem", { name: "extension:fixture-extension", exact: true }).waitFor();
		assert.equal(await page.locator("main .library-packages > li").count(), 1);
		await page
			.locator("main")
			.getByRole("tablist", { name: "Library collections" })
			.getByRole("tab", { name: /^Skills · [1-9]/ })
			.click();
		await page.locator("main").getByRole("heading", { name: "fixture-skill", exact: true }).waitFor();
		await check("library-skills");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `library-skills-${width}.png`), fullPage: true });
		// The collections are one tab stop: an arrow key moves the selection and the focus together.
		await page
			.locator("main")
			.getByRole("tab", { name: /^Skills · / })
			.press("ArrowLeft");
		const agentsTab = page.locator("main").getByRole("tab", { name: /^Agents · / });
		await agentsTab.and(page.locator('[aria-selected="true"]')).waitFor();
		if ((await agentsTab.getAttribute("aria-selected")) !== "true")
			throw new Error("ArrowLeft from Skills did not select the Agents tab.");
		if (!(await agentsTab.evaluate((node) => node === document.activeElement)))
			throw new Error("ArrowLeft moved the selection without moving focus.");
		const agentDetails = page.locator("main .library-resource__details").first();
		await agentDetails.locator(":scope > summary").click();
		await agentDetails.getByText("Tool-call budget", { exact: true }).waitFor();
		await check("library-agent-details");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `library-agents-${width}.png`), fullPage: true });
		for (const collection of ["Agents", "Prompts", "Fleets", "Extensions", "Verifiers"]) {
			await page
				.locator("main")
				.getByRole("tab", { name: new RegExp(`^${collection} · [1-9]`) })
				.click();
			const resource = page.locator("main .library-resource").first();
			await resource.waitFor();
			const details = resource.locator(".library-resource__details");
			if (!(await details.evaluate((node) => (node as HTMLDetailsElement).open)))
				await details.locator(":scope > summary").click();
			await check(`library-${collection.toLowerCase()}`);
		}
		await dark(true);
		await check("library-dark");
		await navigate("System");
		await page.locator("main").getByRole("heading", { name: "Clio folders", exact: true }).waitFor();
		await check("system-dark");
		await page.locator("main").getByRole("link", { name: "Other coding agents", exact: true }).click();
		await page.locator("main").getByRole("heading", { name: "Codex", exact: true }).waitFor();
		await check("interop-dark");
		await dark(false);
		await page.getByText("Would be offered", { exact: true }).waitFor();
		// Opening the page ran nothing. The probe is an explicit act, and the page survives it.
		await page.getByRole("button", { name: "Detect again and probe versions", exact: true }).click();
		await page.getByRole("button", { name: "Detect again and probe versions", exact: true }).waitFor();
		await check("interop");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `interop-${width}.png`), fullPage: true });
		// The project page's New task opens the project's blank task. The new-task screen would refuse here:
		// "Use for chat & fleet" above cleared the saved chat model, which only the project layer still sets.
		await page.goto(workspaceUrl);
		await page.locator("main button.primary", { hasText: "New task" }).click();
		await page.waitForURL(/\/sessions\/[^/]+$/);
		await page
			.getByLabel("Message Clio Coder", { exact: true })
			.fill("Show the fixture findings with code and a diagram.");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		// The fixture first streams and then settles. Inspect its final Markdown subtree,
		// which replaces the streaming subtree before deferred diagrams are rendered.
		await page.locator(".chat-turn.is-settled .diagram").waitFor();
		// Diagrams, like highlighted code, render when they approach the transcript viewport.
		await page.locator(".chat-turn.is-settled .diagram").scrollIntoViewIfNeeded();
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
			const header = document.querySelector(".conversation .wb-bar");
			const main = document.querySelector("main");
			return {
				pageScrolls: (document.scrollingElement?.scrollHeight ?? 0) > innerHeight + 2,
				mainScrolls: !!main && (main.scrollTop !== 0 || main.scrollLeft !== 0),
				// The transcript owns scrolling whether or not this fixture's content happens to overflow it.
				transcriptScrolls: !!transcript && ["auto", "scroll"].includes(getComputedStyle(transcript).overflowY),
				headerVisible: !!header && header.getBoundingClientRect().top >= 0 && header.getBoundingClientRect().height > 0,
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
		await dark(true);
		await check("conversation-dark");
		if (width === 1600) await page.screenshot({ path: join(output, "conversation-dark.png"), fullPage: true });
		if (width === 320) await page.screenshot({ path: join(output, "conversation-320-dark.png"), fullPage: true });
		await dark(false);
		// The task pane beside a conversation is read-only inspection. Opening it and each drill-in must
		// preserve the route, unsent text and actual textarea node: a remount can silently lose selection,
		// attachments or editor state.
		const writesBeforeInspection = apiWrites.length;
		const readsBeforeInspection = evidenceReads;
		const contextPath = new URL(page.url()).pathname;
		const contextSessionId = contextPath.split("/").at(-1);
		assert.ok(contextSessionId);
		const draft = "Keep this unsent draft while inspecting the workspace.";
		await composerField.fill(draft);
		const originalField = await composerField.elementHandle();
		assert.ok(originalField);
		async function assertConversationPreserved() {
			assert.equal(new URL(page.url()).pathname, contextPath);
			assert.equal(new URL(page.url()).pathname.split("/").at(-1), contextSessionId);
			assert.equal(await composerField.inputValue(), draft);
			assert.equal(
				await originalField.evaluate((node) => node === document.querySelector(".composer__field")),
				true,
				"Pane inspection remounted the conversation composer",
			);
		}
		const pane = page.locator(".pane:not([hidden])");
		// The pane docks open from 1100px; narrower it is a modal slide-over behind the top bar's toggle.
		async function openPane() {
			if (!(await pane.count())) await page.getByRole("button", { name: "Show task sidebar", exact: true }).click();
			await pane.locator(".pane__body").waitFor();
			const back = pane.getByRole("button", { name: "Back to Session", exact: true });
			if (await back.count()) await back.click();
			await pane.locator(".pane__title", { hasText: "Session" }).waitFor();
		}
		async function openDrill(name: string) {
			await openPane();
			await pane.locator(".pane-card__open", { hasText: name }).click();
			await pane.getByRole("button", { name: "Back to Session", exact: true }).waitFor();
		}
		async function closePane() {
			if (!(await pane.count())) return;
			// Docked, the sidebar hides itself like the rail; as a slide-over it closes.
			await pane.getByRole("button", { name: /^(Hide right sidebar|Close pane)$/ }).click();
			await pane.waitFor({ state: "detached" });
		}
		await openPane();
		await assertConversationPreserved();
		await pane.locator(".pane-steps li").first().waitFor();
		const planTree = await pane.locator(".pane-steps").ariaSnapshot();
		assert.match(planTree, /Completed:.*Read the fixture workspace/);
		assert.match(planTree, /In progress:.*Summarize the findings/);
		await check("pane-session");
		// The column lists evidence from this session's own fleet records only, never the installation's inventory.
		assert.equal(
			await pane.locator(".pane-evidence a").count(),
			0,
			"Unrelated installation bundles were presented as this task's evidence",
		);
		for (const name of ["Context", "Usage", "Plan"]) {
			await openDrill(name);
			await pane.locator(".pane__title", { hasText: name === "Plan" ? /./ : name }).waitFor();
			await assertConversationPreserved();
			await check(`pane-${name.toLowerCase()}`);
			if (width === 1600 || width === 390)
				await page.screenshot({ path: join(output, `pane-${name.toLowerCase()}-${width}.png`), fullPage: true });
			// The drill moves focus to its title. Docked, Escape steps back to the Session column without
			// closing the pane. The slide-over below 1100px closes on Escape from any view, so there the
			// header's Back to Session is the way back.
			assert.equal(
				await pane.locator(".pane__title").evaluate((node) => node === document.activeElement),
				true,
				"a drill-in did not move focus to its title",
			);
			if ((zoom === 2 ? 800 : width) >= 1100) {
				await page.keyboard.press("Escape");
				await pane.locator(".pane__title", { hasText: "Session" }).waitFor();
				assert.equal(await pane.count(), 1, "Escape in a drill-in closed the pane");
			} else {
				await pane.getByRole("button", { name: "Back to Session", exact: true }).click();
				await pane.locator(".pane__title", { hasText: "Session" }).waitFor();
			}
		}
		// Changes has no drill-in before a file changes; the top bar's Changes control opens the view itself.
		await closePane();
		const changesToggle = page.locator(".conversation .wb-bar").getByRole("button", { name: /^Changes/ });
		await changesToggle.click();
		await pane.locator(".pane-blank").getByText("No files changed yet.", { exact: true }).waitFor();
		await assertConversationPreserved();
		await check("pane-changes");
		assert.equal(evidenceReads, readsBeforeInspection, "The task pane triggered an evidence inventory read");
		await closePane();
		assert.equal(
			await changesToggle.evaluate((node) => document.activeElement === node),
			true,
			"Closing the pane did not return focus to the control that opened it",
		);
		await assertConversationPreserved();
		assert.deepEqual(apiWrites.slice(writesBeforeInspection), [], "Read-only pane inspection performed a write");
		await composerField.fill("");
		await originalField.dispose();
		// Conversation controls use ACP config options, and saved scope alone can switch targets.
		const route = page.locator(".route-picker");
		await route.locator("summary").click();
		await route.getByText("This conversation.", { exact: true }).waitFor();
		assert.equal(await route.getByLabel("Connection", { exact: true }).isDisabled(), true);
		await route.getByLabel("Model", { exact: true }).selectOption("fixture-small");
		await route.getByLabel("Thinking", { exact: true }).selectOption("high");
		await check("route-picker-conversation");
		await route.getByRole("button", { name: "Apply to this conversation", exact: true }).click();
		await route.locator("summary .route-chip__text").getByText("fixture-small", { exact: true }).waitFor();
		assert.match(
			(await route.locator("summary").getAttribute("title")) ?? "",
			/Target: fixture\. Model: fixture-small\./,
		);
		await page.waitForFunction(() => !(document.querySelector(".route-picker") as HTMLDetailsElement).open);
		assert.match((await route.locator("summary").getAttribute("title")) ?? "", /Thinking: high/);
		assert.equal(await route.locator("summary").evaluate((element) => document.activeElement === element), true);
		await route.locator("summary").click();
		await route.getByText("This conversation.", { exact: true }).waitFor();
		assert.equal(await route.getByLabel("Apply to", { exact: true }).count(), 0);
		await check("route-picker");
		if (width === 1600 || width === 390) await page.screenshot({ path: join(output, `route-picker-${width}.png`) });
		await page.keyboard.press("Escape");
		await page.waitForFunction(() => !(document.querySelector(".route-picker") as HTMLDetailsElement).open);
		assert.equal(await route.evaluate((element) => (element as HTMLDetailsElement).open), false);
		assert.equal(await route.locator("summary").evaluate((element) => document.activeElement === element), true);
		// Escape closes it without saving and hands focus back to the chip.
		await route.locator("summary").click();
		await route.getByLabel("Thinking", { exact: true }).selectOption("low");
		await page.keyboard.press("Escape");
		assert.equal(await route.evaluate((element) => (element as HTMLDetailsElement).open), false);
		assert.equal(await route.locator("summary").evaluate((element) => document.activeElement === element), true);
		// The task's own actions sit in one Task actions menu in the top bar; working freedom is the
		// composer's pill. The menu closes on Escape and hands focus back to its button.
		const taskMenu = page.locator(".conversation .wb-bar .wb-menu");
		await taskMenu.locator("summary").click();
		await taskMenu.getByRole("menuitem", { name: "Rename task", exact: true }).waitFor();
		await taskMenu.getByRole("menuitem", { name: "Close task", exact: true }).waitFor();
		await page
			.locator(".composer")
			.getByText("Working freedom for this task", { exact: true })
			.waitFor({ state: "attached" });
		await check("session-controls");
		const menuBounds = await taskMenu.locator(".wb-menu__panel").boundingBox();
		assert.ok(
			menuBounds && menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= (zoom === 2 ? 800 : width),
			`Task actions are outside the viewport at ${width}px: ${JSON.stringify(menuBounds)}`,
		);
		await page.keyboard.press("Escape");
		assert.equal(await taskMenu.evaluate((element) => (element as HTMLDetailsElement).open), false);
		assert.equal(await taskMenu.locator("summary").evaluate((element) => document.activeElement === element), true);
		// Session commands run from the composer's slash palette. `/` lists what this session serves.
		await composerField.fill("/");
		const slashList = page.getByRole("listbox", { name: "Slash commands", exact: true });
		await slashList
			.getByRole("option", { name: /^\/doctor/ })
			.first()
			.waitFor();
		await slashList.getByRole("option", { name: /^\/tree/ }).waitFor();
		await slashList
			.getByRole("option", { name: /^\/context/ })
			.first()
			.waitFor();
		const firstSuggestion = await composerField.getAttribute("aria-activedescendant");
		assert.ok(firstSuggestion);
		await composerField.press("ArrowDown");
		const nextSuggestion = await composerField.getAttribute("aria-activedescendant");
		assert.ok(nextSuggestion);
		assert.notEqual(nextSuggestion, firstSuggestion, "plain arrows did not move the active suggestion");
		assert.equal(await composerField.evaluate((element) => document.activeElement === element), true);
		await check("slash-palette");
		await composerField.press("Shift+ArrowUp");
		assert.deepEqual(
			await composerField.evaluate((element) => {
				const field = element as HTMLTextAreaElement;
				return [field.selectionStart, field.selectionEnd];
			}),
			[0, 1],
			"Shift+ArrowUp did not select text while the slash palette was open",
		);
		await page.keyboard.press("Escape");
		await slashList.waitFor({ state: "detached" });
		// A typed command line is parsed against the catalog and previewed; nothing runs until Enter.
		await composerField.fill("/doctor deep");
		await page.locator(".slash-palette--line code", { hasText: "/doctor deep" }).first().waitFor();
		assert.equal(await page.locator(".slash-result").count(), 0, "a previewed command ran before Enter");
		await composerField.press("Enter");
		const slashResult = page.locator(".slash-result");
		await slashResult.locator("pre", { hasText: "Deep checks completed." }).waitFor();
		assert.equal(await composerField.inputValue(), "", "a command line that ran stayed in the composer");
		await composerField.fill("/context compact Summarize the project");
		await page
			.locator(".slash-palette--line code", { hasText: "/context compact Summarize the project" })
			.first()
			.waitFor();
		await composerField.press("Enter");
		await slashResult.locator("pre", { hasText: "Context action: compact Summarize the project" }).waitFor();
		await check("session-commands");
		if (width === 1600) await page.screenshot({ path: join(output, "session-commands.png"), fullPage: true });
		await slashResult.getByRole("button", { name: "Dismiss", exact: true }).click();
		// The session board: the operator's tasks change through the tasks command, the plan and decisions only read.
		// `/tasks` opens it beside the conversation.
		async function slashPane(name: string) {
			await composerField.fill(`/${name}`);
			// With the palette dismissed, Enter on a line that names a pane view opens it rather than sending.
			await page.keyboard.press("Escape");
			await composerField.press("Enter");
			await pane.getByRole("button", { name: "Back to Session", exact: true }).waitFor();
		}
		// The top bar's live chips open their drill-ins; where a phone's bar has no room for them, the same
		// views are one slash command away.
		async function chipOrSlash(chip: RegExp, view: "usage" | "context") {
			const button = page.locator(".conversation .wb-bar").getByRole("button", { name: chip });
			if (await button.isVisible()) {
				await button.click();
				await pane.getByRole("button", { name: "Back to Session", exact: true }).waitFor();
			} else await slashPane(view);
		}
		await slashPane("tasks");
		const board = page.locator(".pane:not([hidden]) .board-panel");
		await board.getByText("Read the fixture workspace", { exact: true }).waitFor();
		assert.equal(await composerField.inputValue(), "", "a pane jump stayed in the composer");
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
		await page.getByRole("button", { name: "Send", exact: true }).waitFor({ state: "attached" });
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
		await closePane();
		// An image and a text file ride a request when the agent announces image prompts and embedded
		// context: attach both, see them listed, send, see each counted. A binary is refused by name.
		// Attaching is the first row of the composer's + menu.
		await page.locator(".composer__options > summary").click();
		await page.getByRole("button", { name: "Attach files", exact: true }).waitFor();
		await page.keyboard.press("Escape");
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
		await dark(true);
		await check("permission-dark");
		await dark(false);
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
		// Changes lists what the task's recorded edit calls changed. The approved write is counted with its
		// diff; the refused one changed nothing the transcript can vouch for, so it is not listed.
		await openDrill("Changes");
		const recordedFile = pane.locator(".change-file", { has: page.locator("strong", { hasText: "fixture.txt" }) });
		await recordedFile.getByRole("button", { expanded: false }).click();
		const recordedDiffs = recordedFile.locator(".change-file__diffs");
		await recordedDiffs.locator(".diff.is-applied").waitFor();
		assert.match(await recordedDiffs.locator(".diff.is-applied").innerText(), /applied/i);
		assert.equal(await recordedDiffs.locator(".diff").count(), 1, "a refused write was listed as a change");
		assert.equal(await pane.locator(".diff.is-rejected").count(), 0, "a refused write was listed as a change");
		await check("artifacts-recorded-file");
		if (width === 320 || width === 1600)
			await page.screenshot({ path: join(output, `artifacts-recorded-file-${width}.png`), fullPage: true });
		await closePane();
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
		// The pane's Agents drill keeps the whole fleet history, the running row included.
		await openDrill("Agents");
		await pane.locator(".worker-graph").getByText("Survey the fixture", { exact: true }).first().waitFor();
		await closePane();
		// Mid-turn steering from the composer: queue a message for after the turn, see it listed,
		// take it back into the field, then hear the engine's refusal to interrupt as a sentence.
		await page.getByLabel("Message Clio Coder", { exact: true }).fill("Then summarise it.");
		// The delivery switch sits beside Send once there is a message to deliver.
		await page.locator(".composer__delivery").getByRole("button", { name: "After this turn", exact: true }).click();
		await page.locator(".composer__submit").click();
		await page.locator(".composer__queue-row").getByText("Then summarise it.", { exact: true }).waitFor();
		await check("composer-queue");
		if (width === 1600) await page.screenshot({ path: join(output, "composer-queue.png"), fullPage: true });
		await page.getByRole("button", { name: "Take them back", exact: true }).click();
		await page.waitForFunction(
			() => (document.querySelector(".composer__field") as HTMLTextAreaElement | null)?.value === "Then summarise it.",
		);
		await page.getByLabel("Message Clio Coder", { exact: true }).fill("");
		await page.locator(".composer__options > summary").click();
		await page.getByRole("button", { name: "Interrupt", exact: true }).click();
		await page.keyboard.press("Escape");
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
		// A settled turn leaves no working chip in the top bar and no Stop in the composer.
		const settled = async () => {
			await page.locator('.wb-chip--status[data-tone="working"]').waitFor({ state: "detached" });
			await page.getByRole("button", { name: "Stop turn", exact: true }).waitFor({ state: "detached" });
		};
		await settled();
		await page.getByLabel("Message Clio Coder", { exact: true }).fill("[stream] Show progress until cancelled.");
		await page.getByRole("button", { name: "Send", exact: true }).click();
		await page.locator('.wb-chip--status[data-tone="working"]').waitFor();
		await page.getByRole("button", { name: "Stop turn", exact: true }).click();
		await settled();
		await check("cancelled");
		// Session actions open from the slash palette as a dialog over the conversation.
		async function slashAction(name: string, title: string) {
			await composerField.fill(`/${name}`);
			await slashList
				.getByRole("option")
				.filter({ hasText: `${title}.` })
				.click();
			const dialog = page.getByRole("dialog", { name: title, exact: true });
			await dialog.waitFor();
			assert.equal(await composerField.inputValue(), "", "picking a session action left its line in the composer");
			return dialog;
		}
		async function closeDialog(dialog: Locator) {
			await page.keyboard.press("Escape");
			await dialog.waitFor({ state: "detached" });
			assert.equal(
				await composerField.evaluate((node) => node === document.activeElement),
				true,
				"closing a slash dialog did not return focus to the composer",
			);
		}
		// A playbook: preview compiles and starts nothing; the run starts the plan shown.
		const fleetDialog = await slashAction("fleet run", "Run a playbook");
		const fleetPanel = fleetDialog;
		await fleetPanel.getByLabel("Playbook name", { exact: true }).fill("survey");
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
		if (await fleetDialog.count()) await closeDialog(fleetDialog);
		await page.getByRole("button", { name: "Dismiss Fleet survey started", exact: true }).click();
		// Extensions: what this conversation loaded, and a reload that says which generation is live.
		const extensionsDialog = await slashAction("extensions", "Extensions");
		const extensionsPanel = extensionsDialog.locator(".extensions-panel");
		await extensionsPanel.getByText("survey-tools 1.2.0 · project scope", { exact: true }).waitFor();
		await extensionsPanel.getByRole("button", { name: "Reload extensions", exact: true }).click();
		await extensionsPanel.getByText(/^Generation \d+ is live \(no changes\); 2 hooks registered\.$/).waitFor();
		await check("extensions");
		await closeDialog(extensionsDialog);
		// Usage: the conversation's spend in the agent's own words, and each provider's windows. The top
		// bar's spend chip opens it.
		await chipOrSlash(/^Spent .*\. Open usage\.$/, "usage");
		const usagePanel = pane.locator(".usage-panel");
		await usagePanel.locator(".usage-panel__route", { hasText: "local · fixture-model" }).waitFor();
		await usagePanel.getByText("Beside the conversation: 1 side question", { exact: true }).waitFor();
		await usagePanel.getByRole("meter", { name: "5h used", exact: true }).waitFor();
		await check("usage");
		if (width === 1600 || width === 390) {
			await usagePanel.scrollIntoViewIfNeeded();
			await page.screenshot({ path: join(output, `usage-${width}.png`) });
		}
		await closePane();
		// Beside the conversation: a side question and drafts answer in place and add no turn.
		const turnsBefore = await page.locator(".chat-request").count();
		const questionDialog = await slashAction("btw", "Side question");
		const aside = questionDialog.locator(".aside-panel");
		await aside.getByLabel("Side question", { exact: true }).fill("Which file holds the readings?");
		await aside.getByRole("button", { name: "Ask", exact: true }).click();
		await aside.getByText("The readings are in README.md.", { exact: true }).waitFor();
		await check("aside-question");
		await closeDialog(questionDialog);
		const draftsDialog = await slashAction("draft", "Drafts");
		const drafts = draftsDialog.locator(".aside-panel");
		await drafts.getByLabel("Request to draft", { exact: true }).fill("How should the report show readings?");
		await drafts.getByLabel("Drafts", { exact: true }).selectOption("2");
		await drafts.getByRole("button", { name: "Draft", exact: true }).click();
		await drafts.getByText("fixture/judge picked A in 12 ms.", { exact: true }).waitFor();
		await check("aside");
		if (width === 1600 || width === 390) {
			await drafts.scrollIntoViewIfNeeded();
			await page.screenshot({ path: join(output, `aside-${width}.png`) });
		}
		assert.equal(await page.locator(".chat-request").count(), turnsBefore, "an aside added a turn");
		await drafts.getByRole("button", { name: "Put in composer", exact: true }).first().click();
		assert.equal(
			await page.getByLabel("Message Clio Coder", { exact: true }).inputValue(),
			"Show the readings in one table with a unit column.",
		);
		await closeDialog(draftsDialog);
		await page.getByLabel("Message Clio Coder", { exact: true }).fill("");
		// The context window: Clio Coder's own accounting, worded and never recomputed. The top bar's
		// context ring opens it.
		await chipOrSlash(/Open the context window\.$/, "context");
		const contextPanel = pane.locator(".context-panel");
		await contextPanel.locator(".context-panel__figure strong", { hasText: "16%" }).waitFor();
		assert.equal((await contextPanel.locator(".context-panel__of").innerText()).trim(), "20,480 of 131,072 tokens");
		await contextPanel.getByText("Measured by the provider.", { exact: true }).waitFor();
		await contextPanel.getByRole("rowheader", { name: "Conversation", exact: true }).waitFor();
		await check("context-window");
		if (width === 1600 || width === 390) {
			await contextPanel.scrollIntoViewIfNeeded();
			await page.screenshot({ path: join(output, `context-window-${width}.png`) });
		}
		await closePane();
		// Branches: continuing from an earlier reply replays only that branch; forking moves the
		// conversation to a new session and says the project's files were left alone.
		const branchesDialog = await slashAction("tree", "Branches");
		const branches = branchesDialog.locator(".branch-panel");
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
		// The pressed row becomes the disabled tip, so focus lands on the panel's heading, not the page.
		await page.waitForFunction(
			() => document.activeElement?.tagName === "H3" && !!document.activeElement.closest(".branch-panel"),
			undefined,
			{ timeout: 5000 },
		);
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
		if (await branchesDialog.count()) await closeDialog(branchesDialog);
		await check("session-forked");
		if (width === 1600 || width === 390)
			await page.screenshot({ path: join(output, `session-forked-${width}.png`), fullPage: true });
		for (const title of [/^Dismiss Continuing from/, /^Dismiss Conversation forked$/]) {
			const dismiss = page.getByRole("button", { name: title });
			if (await dismiss.count()) await dismiss.click();
		}
		// Handoff: a draft is reviewed and edited before anything is written; starting the new
		// conversation moves there.
		const handoffDialog = await slashAction("handoff", "Hand off to a new conversation");
		const handoff = handoffDialog.locator(".handoff-panel");
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
		await handoffDialog.waitFor({ state: "detached" });
		await check("handed-off");
		await page.getByRole("button", { name: "Dismiss Handed off", exact: true }).click();
		// Close lives in the top bar's Task actions menu, away from the composer's Stop.
		await settled();
		await taskMenu.locator("summary").click();
		await taskMenu.getByRole("menuitem", { name: "Close task", exact: true }).click();
		await page.locator('.wb-chip--status[data-tone="quiet"]', { hasText: "Closed" }).waitFor();
		await page.getByText("This task is closed.", { exact: true }).waitFor();
		await check("closed");
		// A folder that does not exist is refused with the problem's reference.
		await revealSidebar();
		await page
			.locator(".wb-sidebar")
			.getByRole("button", { name: /^Open workspace/ })
			.click();
		await openDialog.getByLabel("Project folder", { exact: true }).fill(join(h.home.path, "does-not-exist"));
		await openDialog.getByRole("button", { name: "Open", exact: true }).click();
		const toast = page.locator(".notice-region .notice");
		await toast.waitFor();
		assert.match(await toast.innerText(), /validation/);
		assert.match(await toast.innerText(), /Reference: [0-9a-f-]+/);
		await check("problem-toast");
		await page.keyboard.press("Escape");
		await openDialog.waitFor({ state: "detached" });
		// A stale token must not brick the app: the shell says what happened, stops reconnecting, and a
		// pasted launch link brings the same tab back.
		await page.goto(`${origin}/#token=${"stale".repeat(8)}`);
		await page.reload();
		await page.getByRole("heading", { name: "This browser is no longer connected", exact: true }).waitFor();
		// The refused shell shows no task rail, so nothing behind the panel keeps reading.
		assert.equal(await page.locator(".wb-sidebar .wb-side").count(), 0, "a refused token still renders the task rail");
		if ((await page.locator(".notice-region .notice").count()) > 0)
			throw new Error("A refused token raised toasts on top of the reconnect panel.");
		await page.getByLabel("Launch link or token", { exact: true }).fill("not a link");
		await page.getByText("That text holds no launch token.", { exact: true }).waitFor();
		await check("reconnect");
		if (width === 1600 || width === 390) await page.screenshot({ path: join(output, `reconnect-${width}.png`) });
		// test-token is shorter than a bare token may be, so it is pasted as the link the server prints.
		await page.getByLabel("Launch link or token", { exact: true }).fill(`[clio-coder:gui] ${origin}/#token=test-token`);
		await page.getByRole("button", { name: "Connect this browser", exact: true }).click();
		await page.locator('.wb-sidebar .wb-status[data-tone="ok"]', { hasText: "Connected" }).waitFor({ state: "attached" });
		await page
			.getByRole("heading", { name: "This browser is no longer connected", exact: true })
			.waitFor({ state: "detached" });
		await context.close();
		if (zoom === 2) zoomContext = null;
	}
	assert.deepEqual(errors, []);
	assert.deepEqual(failures, []);
	// The stale-token step: the shell's first reads (meta, the rail's workspaces and sessions, setup status)
	// start together, so each is refused once per width. A refused stream must stop, not reconnect
	// forever: EventSource retries on its own otherwise. Nothing is read again after the refusal.
	const firstReads = ["/api/meta", "/api/events", "/api/workspaces", "/api/sessions", "/api/setup"];
	for (const path of firstReads)
		assert.ok(
			statuses.filter((item) => item.path === path && item.status === 401).length <= runs.length,
			`${path} was refused more than once per width`,
		);
	assert.deepEqual(
		statuses.filter(
			(item) =>
				!(item.path === "/api/workspaces" && item.status === 422) &&
				!(item.status === 409 && /^\/api\/workspaces\/[^/]+\/sessions$/.test(item.path)) &&
				!(item.status === 401 && firstReads.includes(item.path)),
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
		zoomMeasurements,
		checks,
		requestFailures: failures,
		scriptErrors: errors,
		errorResponses: statuses,
	};
	await writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
	console.log(JSON.stringify(report, null, 2));
	await browser.close();
	await zoomContext?.close();
	if (zoomProfile) await rm(zoomProfile, { recursive: true, force: true });
	if ("closeAllConnections" in server) server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	fixture.close();
	await h.close();
}
