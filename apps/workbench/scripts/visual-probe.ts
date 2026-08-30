/**
 * Visual polish probe for the Clio Coder GUI.
 *
 * Runs the real server against the ACP fixture (default scenario `stream-workload`),
 * drives headless Chrome through the empty state, collapsed rails, a streaming and a
 * settled Markdown conversation, both compact drawers, every alternate view, the
 * catalog search focus state, and the settings dialog, and writes one PNG per state
 * to `.artifacts/visual/` at 1600, 1260, 1050, 790, and 375 px. It prints any page
 * that overflows horizontally and any console error.
 *
 *   deno run -A scripts/visual-probe.ts [scenario]
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright-core";
import type { AcpLaunchSpec } from "../acp-client.ts";
import type { ClioLauncher } from "../clio-host.ts";
import { startWorkbenchServer } from "../main.ts";
import {
	catalogInspectionFixture,
	configInspectionFixture,
	dispatchInspectionFixture,
	routingInspectionFixture,
	usageInspectionFixture,
} from "../tests/fixtures.ts";

const FIXTURE = fileURLToPath(new URL("../tests/acp-child-fixture.ts", import.meta.url));
const OUT = fileURLToPath(new URL("../.artifacts/visual/", import.meta.url));
const scenario = Deno.args[0] ?? "stream-workload";
const launcher: ClioLauncher = {
	launch(trustedRoot: string): AcpLaunchSpec {
		return {
			command: Deno.execPath(),
			args: ["run", "--quiet", "--no-config", FIXTURE, `--scenario=${scenario}`, "--pace-ms=1"],
			cwd: trustedRoot,
			clearEnv: true,
			terminationScope: "posix-process-group",
			redact: [trustedRoot],
		};
	},
};
const scratch = await Deno.makeTempDir({ prefix: "visual-probe-" });
const home = join(scratch, "home");
const project = join(home, "code", "mesh-study");
await Deno.mkdir(join(project, "analysis"), { recursive: true });
await Deno.writeTextFile(join(project, "README.md"), "# mesh\n");
await Deno.writeTextFile(join(project, "analysis", "notes.md"), "notes\n");
const server = await startWorkbenchServer({
	port: 0,
	quiet: true,
	mode: "browser",
	stateDir: join(scratch, "state"),
	homePath: home,
	clioLauncher: launcher,
	configInspector: { inspect: () => Promise.resolve(configInspectionFixture()) },
	catalogInspector: { inspect: () => Promise.resolve(catalogInspectionFixture()) },
	usageInspector: { inspect: () => Promise.resolve(usageInspectionFixture()) },
	routingInspector: { inspect: () => Promise.resolve(routingInspectionFixture()) },
	dispatchInspector: { inspect: () => Promise.resolve(dispatchInspectionFixture()) },
	acpTiming: { permissionTimeoutMs: 120_000, cancelGraceMs: 2_000, closeTimeoutMs: 1_000, exitGraceMs: 1_000 },
});
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const context = await browser.newContext({
	viewport: { width: 1600, height: 1100 },
	colorScheme: "dark",
	reducedMotion: "reduce",
	deviceScaleFactor: 1,
});
const page = await context.newPage();
const errors: string[] = [];
page.on("console", (m) => {
	if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push(e.message));
async function shot(name: string, full = false) {
	await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: full });
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth - globalThis.innerWidth);
	console.log(`${name}: ${overflow > 0 ? `OVERFLOW ${overflow}px` : "ok"}`);
}
async function width(w: number, h = 1100) {
	await page.setViewportSize({ width: w, height: h });
	await page.waitForTimeout(150);
}
async function idle(p: Page) {
	await p.waitForFunction(
		() => document.querySelector(".status-bar__operation strong")?.textContent === "idle",
		undefined,
		{ timeout: 120_000 },
	);
}

await page.goto(server.url, { waitUntil: "networkidle" });
await page.getByText("connected", { exact: true }).waitFor();
await page.locator("input[name=projectPath]").fill(project);
await page.getByRole("button", { name: "Open", exact: true }).click();
await page.getByRole("heading", { level: 1, name: "mesh-study" }).waitFor();
await shot("01-empty-1600");
for (const w of [1260, 1050, 790, 375]) {
	await width(w);
	await shot(`01-empty-${w}`);
}
await width(1600);
// collapsed rails
await page.getByRole("button", { name: /Close projects and files|Collapse/i }).first().click().catch(() => undefined);
await shot("02-left-collapsed");
await page.getByRole("button", { name: /Close run and evidence overview|Collapse/i }).first().click().catch(() =>
	undefined
);
await shot("02-both-collapsed");
await page.reload({ waitUntil: "networkidle" });
await page.getByRole("heading", { level: 1, name: "mesh-study" }).waitFor();

const composer = page.getByRole("textbox", { name: "Prompt for Clio Coder" });
await composer.fill("Explain the convergence study and draw the pipeline.");
await page.getByRole("button", { name: "Send" }).click();
await page.waitForTimeout(700);
await shot("03-streaming");
await idle(page);
await page.waitForTimeout(2500); // diagrams + highlight
await shot("04-complete-top");
await page.locator(".conversation__scroll, .chat-scroll, [data-scroll-region]").first().evaluate((el) => {
	el.scrollTop = el.scrollHeight;
}).catch(() => undefined);
await shot("04-complete-bottom");
// full-page style capture of the transcript by resizing tall
await width(1600, 4200);
await page.waitForTimeout(2500);
await shot("04-complete-full");
await width(1600);
for (const w of [1260, 1050, 790, 375]) {
	await width(w);
	await page.waitForTimeout(300);
	await shot(`05-complete-${w}`);
}
await width(375);
await page.getByRole("button", { name: "Open projects and files" }).click();
await page.locator("#project-rail.is-open").waitFor();
await shot("06-drawer-project-375");
await page.keyboard.press("Escape");
await page.getByRole("button", { name: "Open run and evidence overview" }).click();
await page.locator("#evidence-rail.is-open").waitFor();
await shot("06-drawer-evidence-375");
await page.keyboard.press("Escape");
await width(1600);
for (const view of ["Timeline", "Effective Clio Coder", "Catalog", "Usage", "Dispatch"]) {
	await page.getByRole("button", { name: view, exact: true }).click();
	await page.waitForTimeout(400);
	await shot(`07-${view.toLowerCase().replace(/ /g, "-")}-1600`);
	await width(1050);
	await shot(`07-${view.toLowerCase().replace(/ /g, "-")}-1050`);
	await width(1600);
}
await page.getByRole("button", { name: "Catalog", exact: true }).click();
await page.getByRole("searchbox").first().click();
await shot("08-catalog-search-focus");
await page.getByRole("button", { name: "Settings", exact: true }).click();
await page.waitForTimeout(400);
await shot("09-settings");
console.log("errors", JSON.stringify(errors));
await browser.close();
await server.close();
await Deno.remove(scratch, { recursive: true }).catch(() => undefined);
