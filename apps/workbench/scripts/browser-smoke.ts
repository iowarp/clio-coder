/**
 * Browser smoke for the Clio Coder GUI.
 *
 * The server runs in this process against the deterministic ACP child fixture,
 * so the browser drives a real conversation over the real client code path
 * without a provider, a network call, or a pre-started server.
 */

import { AxeBuilder } from "@axe-core/playwright";
import { deepEqual, equal, match, ok } from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import type { AcpLaunchSpec } from "../acp-client.ts";
import type { ClioLauncher } from "../clio-host.ts";
import type { ClioCatalogInspector } from "../clio-catalog-inspector.ts";
import type { ClioConfigInspector } from "../clio-config-inspector.ts";
import type { ClioDispatchInspector } from "../clio-dispatch-inspector.ts";
import type { ClioUsageInspector } from "../clio-usage-inspector.ts";
import type { ClioRoutingInspector } from "../clio-routing-inspector.ts";
import { startWorkbenchServer } from "../main.ts";
import {
	catalogInspectionFixture,
	configInspectionFixture,
	dispatchInspectionFixture,
	routingInspectionFixture,
	usageInspectionFixture,
} from "../tests/fixtures.ts";

interface SmokeOptions {
	readonly chrome: string;
}

function parseOptions(arguments_: readonly string[]): SmokeOptions {
	let chrome = "/usr/bin/google-chrome";
	for (const argument of arguments_) {
		if (argument.startsWith("--chrome=")) chrome = argument.slice("--chrome=".length);
		else throw new Error(`Unknown browser smoke argument: ${argument}`);
	}
	return { chrome };
}

const FIXTURE = fileURLToPath(new URL("../tests/acp-child-fixture.ts", import.meta.url));

function fixtureLauncher(scenario: string, permissionLogPath?: string): ClioLauncher {
	return {
		launch(trustedRoot: string): AcpLaunchSpec {
			return {
				command: Deno.execPath(),
				args: [
					"run",
					"--quiet",
					"--no-config",
					...(permissionLogPath === undefined ? [] : [`--allow-write=${permissionLogPath}`]),
					FIXTURE,
					`--scenario=${scenario}`,
					...(permissionLogPath === undefined ? [] : [`--permission-log=${permissionLogPath}`]),
				],
				cwd: trustedRoot,
				clearEnv: true,
				terminationScope: Deno.build.os === "windows" ? "direct-child" : "posix-process-group",
				redact: [trustedRoot],
			};
		},
	};
}

const options = parseOptions(Deno.args);
const artifactDirectory = new URL("../.artifacts/browser/", import.meta.url);
await Deno.mkdir(artifactDirectory, { recursive: true });

const scratchRoot = await Deno.makeTempDir({ prefix: "workbench-browser-smoke-" });
const homePath = join(scratchRoot, "home");
const projectRoot = join(homePath, "code", "atlas-field-study");
await Deno.mkdir(join(projectRoot, "analysis"), { recursive: true });
await Deno.writeTextFile(join(projectRoot, "README.md"), "# Atlas field study\n");
await Deno.writeTextFile(join(projectRoot, "analysis", "convergence-notes.md"), "mesh convergence\n");

const running = await startWorkbenchServer({
	port: 0,
	quiet: true,
	mode: "browser",
	stateDir: join(scratchRoot, "state"),
	homePath,
	clioLauncher: fixtureLauncher("permission"),
	configInspector: {
		inspect: () => Promise.resolve(configInspectionFixture()),
	} satisfies ClioConfigInspector,
	catalogInspector: {
		inspect: () => Promise.resolve(catalogInspectionFixture()),
	} satisfies ClioCatalogInspector,
	usageInspector: {
		inspect: () => Promise.resolve(usageInspectionFixture()),
	} satisfies ClioUsageInspector,
	routingInspector: {
		inspect: () => Promise.resolve(routingInspectionFixture()),
	} satisfies ClioRoutingInspector,
	dispatchInspector: {
		inspect: () => Promise.resolve(dispatchInspectionFixture()),
	} satisfies ClioDispatchInspector,
	acpTiming: { permissionTimeoutMs: 120_000, cancelGraceMs: 2_000, closeTimeoutMs: 1_000, exitGraceMs: 1_000 },
});

const browser = await chromium.launch({ executablePath: options.chrome, headless: true });
const browserErrors: string[] = [];

try {
	const context = await browser.newContext({
		viewport: { width: 1600, height: 1100 },
		colorScheme: "dark",
		reducedMotion: "reduce",
		deviceScaleFactor: 1,
	});
	const page = await context.newPage();
	page.on("console", (message) => {
		if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
	});
	page.on("pageerror", (error) => browserErrors.push(`page: ${error.message}`));
	page.on("requestfailed", (request) => {
		browserErrors.push(`request: ${request.method()} ${request.url()} (${request.failure()?.errorText ?? "failed"})`);
	});

	const response = await page.goto(running.url, { waitUntil: "networkidle" });
	equal(response?.status(), 200);
	equal(await page.title(), "Clio Coder");
	await page.getByText("connected", { exact: true }).waitFor();
	equal(await page.getByRole("main").count(), 1);
	equal(await page.getByRole("complementary").count(), 2);
	equal(await page.getByRole("complementary", { name: "Run and evidence overview" }).count(), 1);
	equal(await page.getByRole("textbox", { name: "Prompt for Clio" }).count(), 1);
	equal(await page.getByText("No project open", { exact: true }).count(), 1);
	await page.screenshot({ path: new URL("initial.png", artifactDirectory).pathname });

	// The directory browser lists folders only and refuses the guarded home root.
	await page.getByRole("button", { name: "Browse folders" }).click();
	const browseDialog = page.getByRole("dialog", { name: "Choose a project folder" });
	await browseDialog.waitFor();
	await browseDialog.getByText(/home directory cannot be opened/u).waitFor();
	equal(await browseDialog.getByRole("button", { name: "Open this folder" }).isDisabled(), true);
	await browseDialog.getByRole("button", { name: "code" }).click();
	await browseDialog.getByRole("button", { name: "atlas-field-study" }).click();
	await page.waitForFunction(() =>
		document.querySelector(".browse__actions button:last-child")?.hasAttribute("disabled") === false
	);
	await browseDialog.getByRole("button", { name: "Open this folder" }).click();

	await page.getByRole("heading", { level: 1, name: "atlas-field-study" }).waitFor();
	await page.getByText("README.md", { exact: true }).waitFor();

	// A scoped file lifecycle keeps modal focus contained and restores it.
	const scratchName = `browser-smoke-${crypto.randomUUID().slice(0, 8)}.tmp`;
	const movedScratchName = scratchName.replace(".tmp", "-moved.tmp");
	const fileToolbar = page.locator(".file-toolbar");
	const createFileButton = fileToolbar.getByRole("button", { name: "New file" });
	await createFileButton.click();
	let operationDialog = page.getByRole("dialog", { name: "Create empty file" });
	await page.waitForFunction(() => document.activeElement?.textContent?.includes("Close") === true);
	equal(await page.locator(".conversation").evaluate((element) => element.hasAttribute("inert")), true);
	equal(await page.locator("#project-rail").evaluate((element) => element.hasAttribute("inert")), true);
	equal(await page.locator(".status-bar").evaluate((element) => element.hasAttribute("inert")), true);
	const createFileName = operationDialog.getByLabel("Name", { exact: true });
	await createFileName.fill("   ");
	equal(await createFileName.evaluate((input) => (input as HTMLInputElement).checkValidity()), false);
	await createFileName.fill(scratchName);
	await operationDialog.getByRole("button", { name: "Apply in project" }).click();
	let scratchNode = page.locator(".file-node").filter({ hasText: scratchName });
	await scratchNode.waitFor();
	await scratchNode.click();

	await fileToolbar.getByRole("button", { name: "Rename" }).click();
	operationDialog = page.getByRole("dialog", { name: "Rename or move" });
	await operationDialog.getByLabel("Destination name").fill(movedScratchName);
	await operationDialog.getByRole("button", { name: "Apply in project" }).click();
	scratchNode = page.locator(".file-node").filter({ hasText: movedScratchName });
	await scratchNode.waitFor();
	await scratchNode.click();

	await fileToolbar.getByRole("button", { name: "Delete" }).click();
	operationDialog = page.getByRole("dialog", { name: "Prepare confirmed delete" });
	await operationDialog.getByRole("button", { name: "Inspect and prepare" }).click();
	const deleteDialog = page.getByRole("dialog", { name: "Delete file" });
	await deleteDialog.getByText(movedScratchName, { exact: true }).waitFor();
	await deleteDialog.getByRole("button", { name: "Delete exactly this item" }).click();
	await scratchNode.waitFor({ state: "detached" });

	const desktopRailGeometry = await page.locator("#project-rail").evaluate((rail) => ({
		clientWidth: rail.clientWidth,
		scrollWidth: rail.scrollWidth,
		scrollLeft: rail.scrollLeft,
	}));
	ok(desktopRailGeometry.scrollWidth <= desktopRailGeometry.clientWidth);
	equal(desktopRailGeometry.scrollLeft, 0);

	// The first broad read-only harness surface is a real, bounded Clio graph,
	// not raw CLI JSON or a second configuration implementation in React.
	await page.getByRole("button", { name: "Effective Clio", exact: true }).click();
	const effectiveMap = page.getByRole("region", { name: "Effective Clio map" });
	await effectiveMap.getByRole("heading", { name: "Why Clio behaves this way" }).waitFor();
	await effectiveMap.getByText("From source to behavior", { exact: true }).waitFor();
	await effectiveMap.getByText("CLIO-CODER.md", { exact: true }).first().waitFor();
	await effectiveMap.getByText("qwen3.8-27b", { exact: true }).waitFor();
	await effectiveMap.getByText("Project sources use project-relative paths", { exact: false }).waitFor();
	equal(await effectiveMap.getByText("/home/", { exact: false }).count(), 0);
	const configMapAccessibility = await new AxeBuilder({ page })
		.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
		.analyze();
	const configMapBlockingViolations = configMapAccessibility.violations.filter((violation) =>
		violation.impact === "critical" || violation.impact === "serious"
	);
	deepEqual(
		configMapBlockingViolations.map((violation) => ({
			id: violation.id,
			impact: violation.impact,
			nodes: violation.nodes.map((node) => node.target),
		})),
		[],
	);
	await page.screenshot({ path: new URL("effective-clio.png", artifactDirectory).pathname, fullPage: true });
	await effectiveMap.getByRole("button", { name: "Back to notebook" }).click();
	await page.getByRole("region", { name: "Conversation history" }).waitFor();

	// The capability atlas is projected from four bounded JSON interfaces. Its
	// fifth tab names the missing typed interface instead of scraping CLI text.
	await page.getByRole("button", { name: "Catalog", exact: true }).click();
	const catalog = page.locator(".catalog");
	await catalog.getByRole("heading", { name: "Agents, skills, extensions & resource library" }).waitFor();
	await catalog.getByRole("heading", { name: "Researcher" }).waitFor();
	await catalog.getByText("24–64", { exact: true }).waitFor();
	const catalogSearch = catalog.getByRole("searchbox", { name: "Filter this collection" });
	await catalogSearch.fill("no-such-capability");
	await catalog.getByRole("heading", { name: "No matching resources" }).waitFor();
	await catalogSearch.fill("citation-ready");
	await catalog.getByRole("heading", { name: "Researcher" }).waitFor();
	await catalogSearch.fill("");
	await page.screenshot({ path: new URL("catalog.png", artifactDirectory).pathname, fullPage: true });
	const agentsTab = catalog.getByRole("tab", { name: /^Agents/u });
	await agentsTab.focus();
	await page.keyboard.press("ArrowRight");
	await catalog.getByRole("heading", { name: "frontend-design" }).waitFor();
	equal(await catalog.getByRole("tab", { name: /^Skills/u }).getAttribute("aria-selected"), "true");
	await page.keyboard.press("ArrowRight");
	await catalog.getByRole("heading", { name: "experiment-protocol" }).waitFor();
	await page.keyboard.press("ArrowRight");
	await catalog.getByRole("heading", { name: "Clio Lab Pack" }).waitFor();
	await catalog.getByText("Project-scoped package", { exact: true }).waitFor();
	await catalog.getByText("Native roots and lifecycle mutations remain host-side", { exact: true }).waitFor();
	equal(await catalog.getByRole("tab", { name: /^Extensions/u }).getAttribute("aria-selected"), "true");
	await page.screenshot({ path: new URL("catalog-extensions.png", artifactDirectory).pathname, fullPage: true });
	await page.keyboard.press("ArrowRight");
	await catalog.getByRole("heading", {
		name: "Verifier discovery is real, but it is not machine-readable yet",
	}).waitFor();
	await catalog.getByText("clio-coder verifiers discover", { exact: false }).waitFor();
	equal(await catalog.getByText("/home/", { exact: false }).count(), 0);
	const catalogAccessibility = await new AxeBuilder({ page })
		.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
		.analyze();
	const catalogBlockingViolations = catalogAccessibility.violations.filter((violation) =>
		violation.impact === "critical" || violation.impact === "serious"
	);
	deepEqual(
		catalogBlockingViolations.map((violation) => ({
			id: violation.id,
			impact: violation.impact,
			nodes: violation.nodes.map((node) => node.target),
		})),
		[],
	);
	await page.screenshot({ path: new URL("catalog-verifiers.png", artifactDirectory).pathname, fullPage: true });
	await page.setViewportSize({ width: 375, height: 820 });
	const compactCatalogGeometry = await page.evaluate(() => ({
		documentWidth: document.documentElement.scrollWidth,
		viewportWidth: globalThis.innerWidth,
	}));
	ok(compactCatalogGeometry.documentWidth <= compactCatalogGeometry.viewportWidth);
	const compactCatalogTabs = await catalog.locator(".catalog__tabs").evaluate((tabs) => ({
		overflowX: getComputedStyle(tabs).overflowX,
		scrollWidth: tabs.scrollWidth,
		clientWidth: tabs.clientWidth,
	}));
	ok(["auto", "scroll"].includes(compactCatalogTabs.overflowX));
	ok(compactCatalogTabs.scrollWidth >= compactCatalogTabs.clientWidth);
	await page.screenshot({ path: new URL("catalog-compact.png", artifactDirectory).pathname, fullPage: true });
	await page.setViewportSize({ width: 1600, height: 1100 });
	await catalog.getByRole("button", { name: "Back to notebook" }).click();
	await page.getByRole("region", { name: "Conversation history" }).waitFor();

	// Historical usage is a project-filtered, bounded snapshot. Global audit,
	// evidence, memory, raw prompts, ids, paths, and opportunity bodies never
	// enter the browser frame.
	await page.getByRole("button", { name: "Usage", exact: true }).click();
	const usageRecord = page.getByRole("region", { name: "Thirty-day project usage record" });
	await usageRecord.getByRole("heading", { name: "Thirty days of work in this project" }).waitFor();
	await usageRecord.getByText("13,922,000", { exact: true }).first().waitFor();
	await usageRecord.getByText("$4.125", { exact: true }).first().waitFor();
	await usageRecord.getByText("qwen3.8-27b", { exact: true }).waitFor();
	await usageRecord.getByText("frontend-design", { exact: true }).waitFor();
	await usageRecord.getByText("researcher", { exact: true }).waitFor();
	await usageRecord.getByText("Typed outcomes, not command shapes", { exact: true }).waitFor();
	equal(await usageRecord.getByText("/home/", { exact: false }).count(), 0);
	equal(await usageRecord.getByText("session-alpha", { exact: false }).count(), 0);
	equal(await usageRecord.getByText("rawSuggestions", { exact: false }).count(), 0);
	const usageAccessibility = await new AxeBuilder({ page })
		.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
		.analyze();
	const usageBlockingViolations = usageAccessibility.violations.filter((violation) =>
		violation.impact === "critical" || violation.impact === "serious"
	);
	deepEqual(
		usageBlockingViolations.map((violation) => ({
			id: violation.id,
			impact: violation.impact,
			nodes: violation.nodes.map((node) => node.target),
		})),
		[],
	);
	await page.screenshot({ path: new URL("usage.png", artifactDirectory).pathname, fullPage: true });
	await page.setViewportSize({ width: 375, height: 820 });
	const compactUsageGeometry = await page.evaluate(() => ({
		documentWidth: document.documentElement.scrollWidth,
		viewportWidth: globalThis.innerWidth,
		regionScrollWidth: document.querySelector<HTMLElement>(".conversation__scroll")?.scrollWidth ?? 0,
		regionClientWidth: document.querySelector<HTMLElement>(".conversation__scroll")?.clientWidth ?? 0,
	}));
	ok(compactUsageGeometry.documentWidth <= compactUsageGeometry.viewportWidth);
	ok(compactUsageGeometry.regionScrollWidth <= compactUsageGeometry.regionClientWidth + 1);
	await page.screenshot({ path: new URL("usage-compact.png", artifactDirectory).pathname, fullPage: true });
	await page.setViewportSize({ width: 1600, height: 1100 });
	await usageRecord.getByRole("button", { name: "Back to notebook" }).click();
	await page.getByRole("region", { name: "Conversation history" }).waitFor();

	// Fleet status is deliberately a separate installation-wide snapshot. The
	// fixed adapter reduces durable rows to heartbeat counts and totals before
	// anything reaches the browser.
	await page.getByRole("button", { name: "Dispatch", exact: true }).click();
	const dispatchRecord = page.getByRole("region", { name: "Installation-wide dispatch snapshot" });
	await dispatchRecord.getByRole("heading", { name: "Dispatch across this Clio installation" }).waitFor();
	await dispatchRecord.getByText("15,918,587", { exact: true }).waitFor();
	await dispatchRecord.getByText("Alive", { exact: true }).waitFor();
	await dispatchRecord.getByText("5", { exact: true }).first().waitFor();
	await dispatchRecord.getByText("Never a GUI estimate", { exact: true }).waitFor();
	for (const forbidden of ["run-secret", "agentId", "requestedByPid", "ssh-private-node"]) {
		equal(await dispatchRecord.getByText(forbidden, { exact: false }).count(), 0);
	}
	const dispatchAccessibility = await new AxeBuilder({ page })
		.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
		.analyze();
	const dispatchBlockingViolations = dispatchAccessibility.violations.filter((violation) =>
		violation.impact === "critical" || violation.impact === "serious"
	);
	deepEqual(
		dispatchBlockingViolations.map((violation) => ({
			id: violation.id,
			impact: violation.impact,
			nodes: violation.nodes.map((node) => node.target),
		})),
		[],
	);
	await page.screenshot({ path: new URL("dispatch.png", artifactDirectory).pathname, fullPage: true });
	await page.setViewportSize({ width: 375, height: 820 });
	const compactDispatchGeometry = await page.evaluate(() => ({
		documentWidth: document.documentElement.scrollWidth,
		viewportWidth: globalThis.innerWidth,
		regionScrollWidth: document.querySelector<HTMLElement>(".conversation__scroll")?.scrollWidth ?? 0,
		regionClientWidth: document.querySelector<HTMLElement>(".conversation__scroll")?.clientWidth ?? 0,
	}));
	ok(compactDispatchGeometry.documentWidth <= compactDispatchGeometry.viewportWidth);
	ok(compactDispatchGeometry.regionScrollWidth <= compactDispatchGeometry.regionClientWidth + 1);
	await page.screenshot({ path: new URL("dispatch-compact.png", artifactDirectory).pathname, fullPage: true });
	await page.setViewportSize({ width: 1600, height: 1100 });
	await dispatchRecord.getByRole("button", { name: "Back to notebook" }).click();
	await page.getByRole("region", { name: "Conversation history" }).waitFor();

	// Desktop rails collapse independently, reclaim their full grid tracks, and
	// return focus to the control that can reverse the operation.
	const conversationWidth = () => page.locator(".conversation").evaluate((element) => element.clientWidth);
	const initialConversationWidth = await conversationWidth();
	await page.getByRole("button", { name: "Collapse projects, files, and sessions" }).click();
	await page.locator("#project-rail").waitFor({ state: "hidden" });
	const showProjects = page.getByRole("button", { name: "Show projects, files, and sessions" });
	await showProjects.waitFor();
	equal(await showProjects.evaluate((element) => element === document.activeElement), true);
	ok(await conversationWidth() > initialConversationWidth + 200);
	await showProjects.click();
	await page.locator("#project-rail").waitFor({ state: "visible" });
	equal(
		await page.getByRole("button", { name: "Collapse projects, files, and sessions" }).evaluate((element) =>
			element === document.activeElement
		),
		true,
	);

	await page.getByRole("button", { name: "Collapse run and evidence overview" }).click();
	await page.locator("#evidence-rail").waitFor({ state: "hidden" });
	const showEvidence = page.getByRole("button", { name: "Show run and evidence overview" });
	await showEvidence.waitFor();
	equal(await showEvidence.evaluate((element) => element === document.activeElement), true);
	ok(await conversationWidth() > initialConversationWidth + 240);
	await showEvidence.click();
	await page.locator("#evidence-rail").waitFor({ state: "visible" });
	equal(
		await page.getByRole("button", { name: "Collapse run and evidence overview" }).evaluate((element) =>
			element === document.activeElement
		),
		true,
	);
	equal(await conversationWidth(), initialConversationWidth);

	// One real conversation: prompt, mediated approval, completed turn.
	const composer = page.getByRole("textbox", { name: "Prompt for Clio" });
	await composer.fill("Write the fixture note.");
	await page.getByRole("button", { name: "Send" }).click();
	await page.locator("#permission-title").waitFor();
	equal(await page.title(), "● Approval needed — Clio Coder");
	await page.getByText("Observed on ACP", { exact: true }).first().waitFor();
	await page.screenshot({ path: new URL("permission.png", artifactDirectory).pathname });
	const inProgressDraft = Array.from({ length: 24 }, (_, index) => `Draft line ${index + 1}`).join("\n");
	await composer.fill(inProgressDraft);
	const draftScrollTop = await composer.evaluate((element) => {
		const textarea = element as HTMLTextAreaElement;
		textarea.scrollTop = textarea.scrollHeight;
		return textarea.scrollTop;
	});
	ok(draftScrollTop > 0);
	// Both the banner and the anchored card offer the answer, so name which one.
	equal(await page.getByRole("button", { name: "Allow once" }).count(), 2);
	await page.locator(".approval-card").getByRole("button", { name: "Allow once" }).click();
	const completedOutcome = page.getByRole("heading", { name: "Turn complete", exact: true });
	await completedOutcome.waitFor();
	equal(await page.title(), "Clio Coder");
	await page.locator(".turn-usage").getByText("Input", { exact: true }).waitFor();
	await page.locator(".token-ledger__row--input").getByText("5", { exact: true }).waitFor();
	await page.getByText("the GUI does not infer a price.", { exact: false }).waitFor();
	equal(await composer.inputValue(), inProgressDraft);
	ok(await composer.evaluate((element) => (element as HTMLTextAreaElement).scrollTop) > 0);
	await completedOutcome.scrollIntoViewIfNeeded();
	await page.screenshot({ path: new URL("complete.png", artifactDirectory).pathname });

	// A reload restores the conversation from host-held state.
	await page.reload({ waitUntil: "networkidle" });
	await page.getByText("connected", { exact: true }).waitFor();
	await page.getByRole("heading", { level: 1, name: "atlas-field-study" }).waitFor();
	await page.getByRole("heading", { name: "Turn complete", exact: true }).waitFor();
	equal(await page.locator(".turn-usage").count(), 1);
	equal(await page.locator("#permission-title").count(), 0);

	// Stopping a parked turn is an operator cancellation, not a denial.
	await composer.fill("Park this one and stop it.");
	await page.getByRole("button", { name: "Send" }).click();
	await page.locator("#permission-title").waitFor();
	await page.getByRole("button", { name: "Stop" }).click();
	await page.getByRole("heading", { name: "Turn stopped", exact: true }).waitFor();
	await page.getByText(/Clio was not told no/u).first().waitFor();

	const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
	const blockingViolations = accessibility.violations.filter((violation) =>
		violation.impact === "critical" || violation.impact === "serious"
	);
	deepEqual(
		blockingViolations.map((violation) => ({
			id: violation.id,
			impact: violation.impact,
			nodes: violation.nodes.map((node) => node.target),
		})),
		[],
	);

	const status = await page.locator(".status-bar").innerText();
	match(status, /connected/iu);
	match(status, /Session bound to/u);
	match(status, /Autonomy/u);
	match(status, /Operation/u);

	// Compact layout: the rail becomes a drawer that contains focus.
	await page.setViewportSize({ width: 375, height: 820 });
	equal(await page.locator(".composer__privacy").isVisible(), true);
	await page.waitForFunction(() => document.querySelector("#project-rail")?.hasAttribute("inert") === true);
	const compactGeometry = await page.evaluate(() => {
		const rail = document.querySelector<HTMLElement>("#project-rail");
		if (!rail) throw new Error("The project rail is missing.");
		return {
			viewportWidth: globalThis.innerWidth,
			documentWidth: document.documentElement.scrollWidth,
			railRightEdge: rail.getBoundingClientRect().right,
		};
	});
	ok(compactGeometry.railRightEdge <= 1, `closed project rail leaked to x=${compactGeometry.railRightEdge}`);
	// A bare width comparison names nothing when it fails, so collect the elements
	// that actually cross the viewport edge before asserting.
	const compactOverflow = compactGeometry.documentWidth > compactGeometry.viewportWidth
		? await page.evaluate(() =>
			[...document.querySelectorAll<HTMLElement>("*")]
				.filter((element) => element.getBoundingClientRect().right > globalThis.innerWidth + 0.5)
				.slice(0, 20)
				.map((element) =>
					`${element.tagName.toLowerCase()}.${element.className} right=${
						Math.round(element.getBoundingClientRect().right)
					}`
				)
		)
		: [];
	ok(
		compactGeometry.documentWidth <= compactGeometry.viewportWidth,
		`compact layout overflowed to ${compactGeometry.documentWidth}px: ${compactOverflow.join(", ")}`,
	);

	const openProjects = page.getByRole("button", { name: "Open projects and files" });
	await openProjects.click();
	await page.locator("#project-rail.is-open").waitFor();
	await page.waitForFunction(() => document.activeElement?.textContent?.includes("Close projects and files") === true);
	equal(await page.locator(".conversation").evaluate((element) => element.hasAttribute("inert")), true);
	equal(await page.locator(".status-bar").evaluate((element) => element.hasAttribute("inert")), true);
	for (let index = 0; index < 24; index += 1) {
		await page.keyboard.press("Tab");
		equal(await page.locator("#project-rail").evaluate((rail) => rail.contains(document.activeElement)), true);
	}
	await page.screenshot({ path: new URL("compact-project-drawer.png", artifactDirectory).pathname });
	await page.keyboard.press("Escape");
	await page.waitForFunction(() => document.querySelector("#project-rail")?.hasAttribute("inert") === true);
	equal(await openProjects.evaluate((element) => element === document.activeElement), true);
	equal(await page.locator(".conversation").evaluate((element) => element.hasAttribute("inert")), false);

	// The evidence overview uses the same contained, reversible drawer behavior.
	const openEvidence = page.getByRole("button", { name: "Open run and evidence overview" });
	await openEvidence.click();
	await page.locator("#evidence-rail.is-open").waitFor();
	await page.waitForFunction(() =>
		document.activeElement?.textContent?.includes("Close run and evidence overview") === true
	);
	equal(await page.locator(".conversation").evaluate((element) => element.hasAttribute("inert")), true);
	equal(await page.locator("#project-rail").evaluate((element) => element.hasAttribute("inert")), true);
	equal(await page.locator(".status-bar").evaluate((element) => element.hasAttribute("inert")), true);
	for (let index = 0; index < 8; index += 1) {
		await page.keyboard.press("Tab");
		equal(await page.locator("#evidence-rail").evaluate((rail) => rail.contains(document.activeElement)), true);
	}
	await page.screenshot({ path: new URL("compact-evidence-drawer.png", artifactDirectory).pathname });
	await page.keyboard.press("Escape");
	await page.waitForFunction(() => document.querySelector("#evidence-rail")?.hasAttribute("inert") === true);
	equal(await openEvidence.evaluate((element) => element === document.activeElement), true);
	equal(await page.locator(".conversation").evaluate((element) => element.hasAttribute("inert")), false);

	await page.emulateMedia({ forcedColors: "active" });
	await openProjects.focus();
	const forcedColorsFocus = await openProjects.evaluate((element) => {
		const style = getComputedStyle(element);
		return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
	});
	ok(forcedColorsFocus.style !== "none" && forcedColorsFocus.width >= 2);
	await page.emulateMedia({ forcedColors: "none" });

	await page.setViewportSize({ width: 375, height: 320 });
	await openProjects.click();
	await page.locator("#project-rail.is-open").waitFor();
	const shortHeightRail = await page.locator("#project-rail").evaluate((rail) => {
		rail.scrollTop = rail.scrollHeight;
		return {
			overflowY: getComputedStyle(rail).overflowY,
			scrollTop: rail.scrollTop,
			scrollHeight: rail.scrollHeight,
			clientHeight: rail.clientHeight,
		};
	});
	ok(["auto", "scroll"].includes(shortHeightRail.overflowY));
	ok(shortHeightRail.scrollHeight > shortHeightRail.clientHeight);
	ok(shortHeightRail.scrollTop > 0);
	await page.keyboard.press("Escape");
	await page.setViewportSize({ width: 1600, height: 1100 });

	// A second host on the resume scenario drives the session rail end to end.
	const resumeScratch = await Deno.makeTempDir({ prefix: "workbench-browser-smoke-resume-" });
	const resumeHome = join(resumeScratch, "home");
	const resumeProject = join(resumeHome, "code", "resumable");
	await Deno.mkdir(resumeProject, { recursive: true });
	await Deno.writeTextFile(join(resumeProject, "notes.md"), "resumable project\n");
	const resumeServer = await startWorkbenchServer({
		port: 0,
		quiet: true,
		mode: "browser",
		stateDir: join(resumeScratch, "state"),
		homePath: resumeHome,
		clioLauncher: fixtureLauncher("resume"),
		acpTiming: { permissionTimeoutMs: 120_000, cancelGraceMs: 2_000, closeTimeoutMs: 1_000, exitGraceMs: 1_000 },
	});
	let resumeBlockingViolations: Array<{ id: string; impact: string | null | undefined; nodes: unknown[] }> = [];
	try {
		const resumePage = await context.newPage();
		resumePage.on("console", (message) => {
			if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
		});
		resumePage.on("pageerror", (error) => browserErrors.push(`page: ${error.message}`));
		await resumePage.goto(resumeServer.url, { waitUntil: "networkidle" });
		await resumePage.getByText("connected", { exact: true }).waitFor();
		await resumePage.locator("input[name=projectPath]").fill(resumeProject);
		await resumePage.getByRole("button", { name: "Open", exact: true }).click();
		await resumePage.getByRole("heading", { level: 1, name: "resumable" }).waitFor();

		const sessionRow = resumePage.locator(".session-row").filter({ hasText: "Earlier audit" });
		await sessionRow.waitFor();
		await sessionRow.getByRole("button", { name: "Rename" }).click();
		await sessionRow.getByRole("textbox").fill("Renamed in the browser");
		await sessionRow.getByRole("button", { name: "Save" }).click();
		const renamedRow = resumePage.locator(".session-row").filter({ hasText: "Renamed in the browser" });
		await renamedRow.waitFor();

		// The delete confirmation is the GUI's own, and cancelling it sends nothing.
		await renamedRow.getByRole("button", { name: "Delete" }).click();
		const deleteSessionDialog = resumePage.getByRole("dialog", { name: "Delete this session" });
		await deleteSessionDialog.getByText(/Neither the GUI nor Clio can bring them back/u).waitFor();
		await deleteSessionDialog.getByRole("button", { name: "Keep session" }).click();
		await renamedRow.waitFor();

		await renamedRow.getByRole("button", { name: "Resume" }).click();
		await resumePage.getByRole("heading", { name: "Earlier request", exact: true }).first().waitFor();
		const replayCards = resumePage.locator(".timeline-card--replay");
		equal(await replayCards.count(), 6);
		equal(await replayCards.locator("time").count(), 0);
		equal(await resumePage.locator(".timeline-card--replay.timeline-card--outcome").count(), 0);
		equal(await resumePage.locator(".timeline-card--replay.timeline-card--failure").count(), 0);
		equal(await resumePage.locator(".timeline-card--replay.is-replayed").count(), 5);
		equal(await resumePage.locator(".timeline-card--replay.is-complete").count(), 1);
		deepEqual(
			await replayCards.locator(".timeline-card__source").allInnerTexts(),
			Array.from({ length: 6 }, () => "Replayed from Clio"),
		);

		await resumePage.emulateMedia({ forcedColors: "active" });
		const replayStyle = await resumePage.locator(".timeline-card--replay.is-replayed").first()
			.evaluate((card) => {
				const cardStyle = getComputedStyle(card);
				const dot = card.querySelector<HTMLElement>(".status-mark__dot");
				if (dot === null) throw new Error("The replay status dot is missing.");
				return {
					opacity: cardStyle.opacity,
					borderStyle: cardStyle.borderLeftStyle,
					dotBorderStyle: getComputedStyle(dot).borderTopStyle,
				};
			});
		deepEqual(replayStyle, { opacity: "1", borderStyle: "dashed", dotBorderStyle: "solid" });
		const resumeAccessibility = await new AxeBuilder({ page: resumePage })
			.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
			.analyze();
		resumeBlockingViolations = resumeAccessibility.violations
			.filter((violation) => violation.impact === "critical" || violation.impact === "serious")
			.map((violation) => ({
				id: violation.id,
				impact: violation.impact,
				nodes: violation.nodes.map((node) => node.target),
			}));
		deepEqual(resumeBlockingViolations, []);
		await resumePage.emulateMedia({ forcedColors: "none" });

		// A live prompt continues the replayed branch rather than restarting it.
		await resumePage.screenshot({ path: new URL("resumed-session.png", artifactDirectory).pathname });
		await resumePage.getByRole("textbox", { name: "Prompt for Clio" }).fill("Continue the branch.");
		await resumePage.getByRole("button", { name: "Send" }).click();
		// The live turn is identified by being the one card that is not marked as history.
		await resumePage.waitForFunction(() =>
			document.querySelectorAll(".timeline-card:not(.timeline-card--replay)").length >= 3
		);
		ok(await resumePage.locator(".timeline-card--replay").count() >= 6);
		await resumePage.close();
	} finally {
		await resumeServer.close();
		await Deno.remove(resumeScratch, { recursive: true }).catch(() => undefined);
	}

	// A third host proves the recovery path for a remembered folder that is gone.
	const recoveryScratch = await Deno.makeTempDir({ prefix: "workbench-browser-smoke-recovery-" });
	const recoveryHome = join(recoveryScratch, "home");
	const goneProject = join(recoveryHome, "code", "vanishing");
	const keptProject = join(recoveryHome, "code", "kept");
	await Deno.mkdir(goneProject, { recursive: true });
	await Deno.mkdir(keptProject, { recursive: true });
	await Deno.writeTextFile(join(goneProject, "notes.md"), "about to disappear\n");
	await Deno.writeTextFile(join(keptProject, "notes.md"), "still here\n");
	const recoveryServer = await startWorkbenchServer({
		port: 0,
		quiet: true,
		mode: "browser",
		stateDir: join(recoveryScratch, "state"),
		homePath: recoveryHome,
		clioLauncher: fixtureLauncher("happy"),
		acpTiming: { permissionTimeoutMs: 120_000, cancelGraceMs: 2_000, closeTimeoutMs: 1_000, exitGraceMs: 1_000 },
	});
	let recoveryBlockingViolations: Array<{ id: string; impact: string | null | undefined; nodes: unknown[] }> = [];
	try {
		const recoveryPage = await context.newPage();
		recoveryPage.on("console", (message) => {
			if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
		});
		recoveryPage.on("pageerror", (error) => browserErrors.push(`page: ${error.message}`));
		await recoveryPage.goto(recoveryServer.url, { waitUntil: "networkidle" });
		await recoveryPage.getByText("connected", { exact: true }).waitFor();

		// Opening the second folder closes the first without forgetting it.
		await recoveryPage.locator("input[name=projectPath]").fill(goneProject);
		await recoveryPage.getByRole("button", { name: "Open", exact: true }).click();
		await recoveryPage.getByRole("heading", { level: 1, name: "vanishing" }).waitFor();
		await recoveryPage.locator("input[name=projectPath]").fill(keptProject);
		await recoveryPage.getByRole("button", { name: "Open", exact: true }).click();
		await recoveryPage.getByRole("heading", { level: 1, name: "kept" }).waitFor();

		await Deno.remove(goneProject, { recursive: true });
		await recoveryPage.reload({ waitUntil: "networkidle" });
		await recoveryPage.getByText("connected", { exact: true }).waitFor();

		const missingRow = recoveryPage.locator(".project-card-row.is-missing");
		await missingRow.waitFor();
		await missingRow.getByText(/The GUI can no longer open this folder\./u).waitFor();
		await missingRow.getByText(/Removing it from this list changes nothing on disk\./u).waitFor();
		equal(await missingRow.locator(".project-card").isDisabled(), true);
		equal(await recoveryPage.locator(".project-card-row.is-missing").count(), 1);

		// The recovery block spans the row, so the rail must still not scroll sideways.
		const recoveryRailOverflow = await recoveryPage.locator("#project-rail").evaluate((rail) => ({
			scrollWidth: rail.scrollWidth,
			clientWidth: rail.clientWidth,
		}));
		ok(recoveryRailOverflow.scrollWidth <= recoveryRailOverflow.clientWidth + 1);

		const removeButton = missingRow.getByRole("button", { name: "Remove vanishing from this list" });
		equal(await removeButton.isDisabled(), false);
		await recoveryPage.screenshot({ path: new URL("recent-project-gone.png", artifactDirectory).pathname });

		const recoveryAccessibility = await new AxeBuilder({ page: recoveryPage })
			.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
			.analyze();
		recoveryBlockingViolations = recoveryAccessibility.violations
			.filter((violation) => violation.impact === "critical" || violation.impact === "serious")
			.map((violation) => ({
				id: violation.id,
				impact: violation.impact,
				nodes: violation.nodes.map((node) => node.target),
			}));
		deepEqual(recoveryBlockingViolations, []);

		await removeButton.click();
		await recoveryPage.locator(".project-card-row.is-missing").waitFor({ state: "detached" });
		equal(await recoveryPage.locator(".project-card-row").count(), 1);
		await recoveryPage.close();
	} finally {
		await recoveryServer.close();
		await Deno.remove(recoveryScratch, { recursive: true }).catch(() => undefined);
	}

	// A fourth host proves the settings, targets, and autonomy surfaces in the GUI.
	const settingsScratch = await Deno.makeTempDir({ prefix: "workbench-browser-smoke-settings-" });
	const settingsHome = join(settingsScratch, "home");
	const settingsProject = join(settingsHome, "code", "configured");
	await Deno.mkdir(settingsProject, { recursive: true });
	await Deno.writeTextFile(join(settingsProject, "notes.md"), "configured project\n");
	const settingsServer = await startWorkbenchServer({
		port: 0,
		quiet: true,
		mode: "browser",
		stateDir: join(settingsScratch, "state"),
		homePath: settingsHome,
		clioLauncher: fixtureLauncher("settings"),
		routingInspector: {
			inspect: () => Promise.resolve(routingInspectionFixture()),
		} satisfies ClioRoutingInspector,
		acpTiming: { permissionTimeoutMs: 120_000, cancelGraceMs: 2_000, closeTimeoutMs: 1_000, exitGraceMs: 1_000 },
	});
	let settingsBlockingViolations: Array<{ id: string; impact: string | null | undefined; nodes: unknown[] }> = [];
	try {
		const settingsPage = await context.newPage();
		settingsPage.on("console", (message) => {
			if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
		});
		settingsPage.on("pageerror", (error) => browserErrors.push(`page: ${error.message}`));
		await settingsPage.goto(settingsServer.url, { waitUntil: "networkidle" });
		await settingsPage.getByText("connected", { exact: true }).waitFor();
		await settingsPage.locator("input[name=projectPath]").fill(settingsProject);
		await settingsPage.getByRole("button", { name: "Open", exact: true }).click();
		await settingsPage.getByRole("heading", { level: 1, name: "configured" }).waitFor();

		// A probe is the only thing that may put a health verdict on screen.
		await settingsPage.getByRole("button", { name: "Settings", exact: true }).click();
		const settingsDialog = settingsPage.getByRole("dialog", { name: "Clio settings" });
		await settingsDialog.waitFor();
		const offlineRow = settingsDialog.locator(".target-row").filter({ hasText: "offline-lab" });
		await offlineRow.getByText("not probed").waitFor();
		await offlineRow.getByRole("button", { name: "Probe offline-lab" }).click();
		await offlineRow.getByText("unhealthy").waitFor();
		await offlineRow.getByText(/not-configured/u).waitFor();
		// The target nobody probed keeps saying so.
		await settingsDialog.locator(".target-row").filter({ hasText: "lmstudio" }).getByText("not probed").waitFor();

		// A settings patch round-trips through Clio and never through a local file.
		await settingsDialog.getByLabel("Set orchestrator.model").selectOption("qwen3.8-4b");
		await settingsPage.waitForFunction(() =>
			document.querySelector<HTMLSelectElement>('[aria-label="Set orchestrator.model"]')?.value === "qwen3.8-4b"
		);

		// The deeper routing inventory uses Clio's offline catalog and effective
		// worker-profile listings; opening it never probes an endpoint.
		await settingsDialog.getByRole("button", { name: "Inspect models and routes" }).click();
		const routingInventory = settingsDialog.locator(".settings__routing");
		await routingInventory.getByRole("heading", { name: "Offline model capabilities" }).waitFor();
		await routingInventory.getByText("262,144", { exact: true }).waitFor();
		await routingInventory.getByRole("region", { name: "Worker profiles" })
			.getByText("deep-research", { exact: true }).waitFor();
		await routingInventory.getByText("Missing profile", { exact: true }).waitFor();
		const routingModelList = routingInventory.locator(".routing-model-list");
		const routingSearch = routingInventory.getByRole("searchbox", { name: "Filter models" });
		await routingSearch.fill("4b");
		await routingModelList.getByText("qwen3.8-4b", { exact: true }).waitFor();
		equal(await routingModelList.getByText("qwen3.8-27b", { exact: true }).count(), 0);
		await routingSearch.fill("");
		await routingModelList.getByText("qwen3.8-27b", { exact: true }).waitFor();
		equal(await routingInventory.getByText("/home/", { exact: false }).count(), 0);
		equal(await routingInventory.getByText("https://", { exact: false }).count(), 0);
		await settingsPage.screenshot({ path: new URL("settings-routing.png", artifactDirectory).pathname });

		const settingsAccessibility = await new AxeBuilder({ page: settingsPage })
			.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
			.analyze();
		settingsBlockingViolations = settingsAccessibility.violations
			.filter((violation) => violation.impact === "critical" || violation.impact === "serious")
			.map((violation) => ({
				id: violation.id,
				impact: violation.impact,
				nodes: violation.nodes.map((node) => node.target),
			}));
		deepEqual(settingsBlockingViolations, []);
		await settingsPage.screenshot({ path: new URL("settings-targets.png", artifactDirectory).pathname });
		await settingsDialog.getByRole("button", { name: "Close" }).click();

		// Binding a session first, because autonomy is a per-session override.
		await settingsPage.locator(".rail-section--sessions").getByRole("button", { name: "New", exact: true }).click();
		await settingsPage.waitForFunction(() =>
			document.querySelector(".status-bar__autonomy select") !== null &&
			!document.querySelector<HTMLSelectElement>(".status-bar__autonomy select")!.disabled
		);
		// Session and settings disagree on the model now, so the status bar says so.
		await settingsPage.getByText("Next turn", { exact: true }).waitFor();

		await settingsPage.getByLabel("Session autonomy").selectOption("read-only");
		await settingsPage.locator(".status-bar__autonomy").getByText("set for this session").waitFor();

		// The two pending facts carry different labels because they land at
		// different times: routing on this session's next prompt, a global autonomy
		// only on the session bound after this one.
		await settingsPage.getByText("Next session", { exact: true }).waitFor();
		await settingsPage.locator(".status-bar__next-session").getByText("auto edit autonomy").waitFor();
		equal(await settingsPage.locator(".status-bar__next-turn").count(), 1);
		// Both conditional regions are on screen at once, so the fixed-height status
		// bar must still be one row.
		const statusRows = await settingsPage.locator(".status-bar").evaluate((bar) => {
			const tops = new Set<number>();
			for (const region of bar.children) tops.add(Math.round(region.getBoundingClientRect().top));
			return { rows: tops.size, scrollWidth: bar.scrollWidth, clientWidth: bar.clientWidth };
		});
		equal(statusRows.rows, 1);
		ok(statusRows.scrollWidth <= statusRows.clientWidth + 1);

		// The same two regions at the width where the compact rules hide most of
		// the bar, which is where a positional hide list mis-selected them.
		await settingsPage.setViewportSize({ width: 375, height: 820 });
		const compactStatus = await settingsPage.locator(".status-bar").evaluate((bar) => {
			const tops = new Set<number>();
			for (const region of bar.children) {
				if (getComputedStyle(region).display === "none") continue;
				tops.add(Math.round(region.getBoundingClientRect().top));
			}
			return { rows: tops.size, documentWidth: document.documentElement.scrollWidth, viewport: globalThis.innerWidth };
		});
		equal(compactStatus.rows, 1);
		ok(compactStatus.documentWidth <= compactStatus.viewport);
		await settingsPage.setViewportSize({ width: 1600, height: 1100 });

		await settingsPage.getByRole("textbox", { name: "Prompt for Clio" }).fill("What autonomy is in force?");
		await settingsPage.getByRole("button", { name: "Send" }).click();
		// The gate: Clio ran the next turn under the level the GUI set.
		await settingsPage.getByText("This session has seen 1 prompts at autonomy read-only.").waitFor();
		await settingsPage.close();
	} finally {
		await settingsServer.close();
		await Deno.remove(settingsScratch, { recursive: true }).catch(() => undefined);
	}

	// A fifth host replays the recorded seventeen-bash run: the approval an
	// operator missed, the silence between tool calls, and the expiry that must
	// never reach Clio as a rejection.
	const loopScratch = await Deno.makeTempDir({ prefix: "workbench-browser-smoke-loop-" });
	const loopHome = join(loopScratch, "home");
	const loopProject = join(loopHome, "code", "atlas-audit");
	await Deno.mkdir(loopProject, { recursive: true });
	await Deno.writeTextFile(join(loopProject, "notes.md"), "convergence study\n");
	const loopServer = await startWorkbenchServer({
		port: 0,
		quiet: true,
		mode: "browser",
		stateDir: join(loopScratch, "state"),
		homePath: loopHome,
		clioLauncher: fixtureLauncher("seventeen-bash"),
		permissionEscalateMs: 1_500,
		permissionBudgetMs: 300_000,
		acpTiming: { permissionTimeoutMs: 600_000, cancelGraceMs: 2_000, closeTimeoutMs: 1_000, exitGraceMs: 1_000 },
	});
	let loopBlockingViolations: Array<{ id: string; impact: string | null | undefined; nodes: unknown[] }> = [];
	try {
		const loopPage = await context.newPage();
		loopPage.on("console", (message) => {
			if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
		});
		loopPage.on("pageerror", (error) => browserErrors.push(`page: ${error.message}`));
		await loopPage.goto(loopServer.url, { waitUntil: "networkidle" });
		await loopPage.getByText("connected", { exact: true }).waitFor();
		await loopPage.locator("input[name=projectPath]").fill(loopProject);
		await loopPage.getByRole("button", { name: "Open", exact: true }).click();
		await loopPage.getByRole("heading", { level: 1, name: "atlas-audit" }).waitFor();

		await loopPage.getByRole("textbox", { name: "Prompt for Clio" }).fill("Audit the convergence study.");
		await loopPage.getByRole("button", { name: "Send" }).click();

		const banner = loopPage.locator(".approval-banner");
		await banner.waitFor();
		equal(await loopPage.title(), "● Approval needed — Clio Coder");

		// Sixteen answered with the keyboard alone, which is the documented chord.
		// Progress is counted from settled approval cards rather than from the
		// banner's text, because the banner unmounts between cards.
		for (let call = 0; call < 16; call += 1) {
			await loopPage.locator("#approval-banner-title").waitFor();
			const title = await loopPage.locator("#approval-banner-title").innerText();
			ok(title.startsWith("bash: "), `approval ${call + 1} was titled ${title}`);
			await loopPage.keyboard.press("Alt+a");
			await loopPage.waitForFunction(
				(settled) => document.querySelectorAll(".timeline-card--approval.is-complete").length >= settled,
				call + 1,
				{ timeout: 10_000 },
			);
		}
		// Every one of those was answered by the keyboard, never by a click.
		equal(await loopPage.locator(".timeline-card--approval.is-complete").count(), 16);

		// Gate: the card is impossible to miss in the state the operator was in.
		// Scrolled back to the top of a long timeline and with the window blurred.
		await loopPage.locator(".conversation__scroll").evaluate((region) => {
			region.scrollTop = 0;
		});
		await loopPage.evaluate(() => {
			globalThis.scrollTo(0, 0);
			(document.activeElement as HTMLElement | null)?.blur();
		});
		await loopPage.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
		const discoverability = await loopPage.evaluate(() => {
			const bannerElement = document.querySelector(".approval-banner");
			const inlineCard = document.querySelector(".approval-card");
			const viewportHeight = globalThis.innerHeight;
			const bannerRect = bannerElement?.getBoundingClientRect();
			const inlineRect = inlineCard?.getBoundingClientRect();
			return {
				bannerVisible: bannerRect !== undefined && bannerRect.top >= 0 && bannerRect.bottom <= viewportHeight,
				inlineVisible: inlineRect !== undefined && inlineRect.top >= 0 && inlineRect.bottom <= viewportHeight,
				scrolledToTop: document.querySelector(".conversation__scroll")?.scrollTop === 0,
				focusedInsideBanner: bannerElement?.contains(document.activeElement) === true,
			};
		});
		equal(discoverability.scrolledToTop, true);
		equal(discoverability.bannerVisible, true);
		equal(discoverability.inlineVisible, false, "the anchored card must be scrolled away for this to prove anything");
		// Prominent, never focus-trapping: the operator may keep working.
		equal(discoverability.focusedInsideBanner, false);
		equal(await loopPage.title(), "● Approval needed — Clio Coder");
		await loopPage.screenshot({ path: new URL("approval-banner.png", artifactDirectory).pathname });

		// Gate: with no model prose at all, the operator can still tell what is
		// happening, how long it has run, and that a shape is repeating.
		const composerStatus = await loopPage.locator(".composer__status").innerText();
		match(composerStatus, /^\d+s · 17 tool calls · bash: /u);
		const repeated = /· (\d+) repeated/u.exec(composerStatus);
		ok(repeated, `the composer status must report repeated shapes, got: ${composerStatus}`);
		ok(Number(repeated[1]) > 0);
		// The elapsed reading is a live clock, not a value frozen at the last event.
		const firstElapsed = Number(/^(\d+)s/u.exec(composerStatus)?.[1] ?? "-1");
		ok(firstElapsed >= 0);
		await loopPage.waitForFunction(
			(previous) => {
				const text = document.querySelector(".composer__status")?.textContent ?? "";
				return Number(/^(\d+)s/u.exec(text)?.[1] ?? "-1") > previous;
			},
			firstElapsed,
			{ timeout: 5_000 },
		);
		equal(await loopPage.locator(".timeline-card--narrative").count(), 0, "the fixture speaks no prose");
		ok(await loopPage.locator(".timeline-card--loop").count() > 0);
		await loopPage.locator(".timeline-card--loop").first().getByText(/Reported by Clio/u).waitFor();

		// The escalated treatment arrives on its own, without another wire event.
		await loopPage.locator(".approval-banner--escalated").waitFor({ timeout: 5_000 });
		await loopPage.locator(".status-bar__operation.is-escalated").waitFor();
		await loopPage.getByText(/An approval has been waiting for 1 seconds\./u).waitFor();

		const loopAccessibility = await new AxeBuilder({ page: loopPage })
			.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
			.analyze();
		loopBlockingViolations = loopAccessibility.violations
			.filter((violation) => violation.impact === "critical" || violation.impact === "serious")
			.map((violation) => ({
				id: violation.id,
				impact: violation.impact,
				nodes: violation.nodes.map((node) => node.target),
			}));
		deepEqual(loopBlockingViolations, []);
		await loopPage.close();
	} finally {
		await loopServer.close();
		await Deno.remove(loopScratch, { recursive: true }).catch(() => undefined);
	}

	// A sixth host lets one card expire, on a budget shortened to three seconds.
	const expiryScratch = await Deno.makeTempDir({ prefix: "workbench-browser-smoke-expiry-" });
	const expiryHome = join(expiryScratch, "home");
	const expiryProject = join(expiryHome, "code", "unattended");
	const permissionLogPath = join(expiryScratch, "acp-permissions.json");
	await Deno.mkdir(expiryProject, { recursive: true });
	await Deno.writeTextFile(join(expiryProject, "notes.md"), "nobody is watching\n");
	const expiryServer = await startWorkbenchServer({
		port: 0,
		quiet: true,
		mode: "browser",
		stateDir: join(expiryScratch, "state"),
		homePath: expiryHome,
		clioLauncher: fixtureLauncher("seventeen-bash", permissionLogPath),
		permissionEscalateMs: 1_000,
		permissionBudgetMs: 3_000,
		acpTiming: { permissionTimeoutMs: 600_000, cancelGraceMs: 2_000, closeTimeoutMs: 1_000, exitGraceMs: 1_000 },
	});
	try {
		const expiryPage = await context.newPage();
		expiryPage.on("console", (message) => {
			if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
		});
		expiryPage.on("pageerror", (error) => browserErrors.push(`page: ${error.message}`));
		await expiryPage.goto(expiryServer.url, { waitUntil: "networkidle" });
		await expiryPage.getByText("connected", { exact: true }).waitFor();
		await expiryPage.locator("input[name=projectPath]").fill(expiryProject);
		await expiryPage.getByRole("button", { name: "Open", exact: true }).click();
		await expiryPage.getByRole("heading", { level: 1, name: "unattended" }).waitFor();

		await expiryPage.getByRole("textbox", { name: "Prompt for Clio" }).fill("Audit while nobody watches.");
		await expiryPage.getByRole("button", { name: "Send" }).click();
		await expiryPage.locator(".approval-banner").waitFor();
		// Nobody answers. The card must park the turn, not deny the tool.
		await expiryPage.getByRole("heading", { name: "Turn stopped", exact: true }).waitFor({ timeout: 15_000 });
		const stoppedSentence =
			/An approval waited unanswered for the whole budget, so the GUI stopped the turn\. Clio was not told no; send a new prompt to continue\./u;
		await expiryPage.locator(".evidence-timeline").getByText(stoppedSentence).waitFor();
		// The same sentence reaches a screen reader through the live region.
		equal(await expiryPage.locator('[aria-live="assertive"]').getByText(stoppedSentence).count(), 1);
		await expiryPage.locator(".evidence-timeline").getByText(
			/Nobody answered\. The turn was stopped; Clio was not told no\./u,
		).waitFor();
		equal(await expiryPage.locator(".approval-banner").count(), 0);
		equal(await expiryPage.title(), "Clio Coder");
		await expiryPage.screenshot({ path: new URL("approval-unanswered.png", artifactDirectory).pathname });
		await expiryPage.close();
	} finally {
		await expiryServer.close();
	}

	// The child wrote what it was told, and it was never told no.
	const permissionAnswers = JSON.parse(await Deno.readTextFile(permissionLogPath)) as Array<{ result?: unknown }>;
	ok(permissionAnswers.length > 0, "the fixture must have recorded the answer it received");
	deepEqual(
		permissionAnswers.filter((answer) =>
			(answer.result as { outcome?: { outcome?: string } } | undefined)?.outcome?.outcome === "selected"
		),
		[],
	);
	ok(permissionAnswers.every((answer) => !JSON.stringify(answer).includes("reject-once")));
	await Deno.remove(expiryScratch, { recursive: true }).catch(() => undefined);

	const compactAccessibility = await new AxeBuilder({ page })
		.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
		.analyze();
	const compactBlockingViolations = compactAccessibility.violations.filter((violation) =>
		violation.impact === "critical" || violation.impact === "serious"
	);
	deepEqual(
		compactBlockingViolations.map((violation) => ({
			id: violation.id,
			impact: violation.impact,
			nodes: violation.nodes.map((node) => node.target),
		})),
		[],
	);
	deepEqual(browserErrors, []);

	console.log(JSON.stringify(
		{
			url: running.url,
			serverStartedInProcess: true,
			clioChild: "tests/acp-child-fixture.ts --scenario=permission",
			directoryBrowserRefusedHome: true,
			realProjectOpenedByPath: true,
			scopedFileCreateMoveAndConfirmedDelete: true,
			approvalTitleFlipped: true,
			conversationSurvivedReload: true,
			reportedUsageVisibleAndSurvivedReload: true,
			stopNeverDeniedTheTool: true,
			sessionRenamedResumedAndReplayed: true,
			sessionDeleteConfirmedByGui: true,
			unavailableProjectExplainedAndRemovable: true,
			targetProbedBeforeAnyHealthClaim: true,
			autonomySetInTheGuiReachedTheNextTurn: true,
			nextTurnAndNextSessionLabelledDistinctly: true,
			desktopRailsCollapseAndRestoreFocus: true,
			streamUpdatesPreservedTheDraftAndItsScrollPosition: true,
			effectiveClioMapUsesTheBoundedReadOnlyAdapter: true,
			catalogUsesBoundedReadOnlyAdapters: true,
			routingInventoryUsesOfflineBoundedAdapters: true,
			dispatchUsesInstallationWideBoundedAdapter: true,
			compactCatalogHasNoPageOverflow: true,
			usageUsesTheProjectFilteredBoundedAdapter: true,
			compactUsageHasNoPageOverflow: true,
			compactDispatchHasNoPageOverflow: true,
			approvalBannerVisibleWhenScrolledAwayAndBlurred: true,
			approvalAnsweredByKeyboardChord: true,
			escalatedWithoutAnotherWireEvent: true,
			silentToolRunStillLegible: true,
			expiryStoppedTheTurnWithoutDenyingTheTool: true,
			responsiveDrawerGeometryAndFocus: true,
			modalAndDrawerFocusContainedAndRestored: true,
			forcedColorsFocusVisible: true,
			shortHeightRailScrollable: true,
			desktopRailHasNoHorizontalOverflow: true,
			seriousOrCriticalAccessibilityViolations: configMapBlockingViolations.length + blockingViolations.length +
				catalogBlockingViolations.length +
				usageBlockingViolations.length +
				dispatchBlockingViolations.length +
				compactBlockingViolations.length +
				resumeBlockingViolations.length + recoveryBlockingViolations.length + settingsBlockingViolations.length +
				loopBlockingViolations.length,
			browserErrors: browserErrors.length,
			screenshots: [
				"initial.png",
				"effective-clio.png",
				"catalog.png",
				"catalog-extensions.png",
				"catalog-verifiers.png",
				"catalog-compact.png",
				"usage.png",
				"usage-compact.png",
				"dispatch.png",
				"dispatch-compact.png",
				"permission.png",
				"complete.png",
				"compact-project-drawer.png",
				"compact-evidence-drawer.png",
				"recent-project-gone.png",
				"settings-targets.png",
				"settings-routing.png",
				"approval-banner.png",
				"approval-unanswered.png",
			],
		},
		null,
		2,
	));
} finally {
	await browser.close();
	await running.close();
	await Deno.remove(scratchRoot, { recursive: true }).catch(() => undefined);
}
