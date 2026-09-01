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
import type { ClioFleetInspector } from "../clio-fleet-inspector.ts";
import type { ClioToolchainInspector } from "../clio-toolchain-inspector.ts";
import type { ClioDecisionsInspector } from "../clio-decisions-inspector.ts";
import type { ClioInteropInspector } from "../clio-interop-inspector.ts";
import type { ClioTraceInspector } from "../clio-trace-inspector.ts";
import type { ClioEvidenceInspector } from "../clio-evidence-inspector.ts";
import type { ClioRecoveryInspector } from "../clio-recovery-inspector.ts";
import type { ClioUsageInspector } from "../clio-usage-inspector.ts";
import type { ClioRoutingInspector } from "../clio-routing-inspector.ts";
import { startWorkbenchServer } from "../main.ts";
import {
	catalogInspectionFixture,
	configInspectionFixture,
	dispatchInspectionFixture,
	evidenceDetailFixture,
	evidenceInspectionFixture,
	fleetInspectionFixture,
	fleetVerificationFixture,
	gateDecisionsFixture,
	interopInspectionFixture,
	recoveryInspectionFixture,
	routingInspectionFixture,
	toolchainInspectionFixture,
	traceInspectionFixture,
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
	fleetInspector: {
		inspect: () => Promise.resolve(fleetInspectionFixture()),
		verify: (_cwd, runId) => Promise.resolve({ ...fleetVerificationFixture(), runId }),
	} satisfies ClioFleetInspector,
	traceInspector: {
		inspect: () => Promise.resolve(traceInspectionFixture()),
	} satisfies ClioTraceInspector,
	decisionsInspector: {
		inspect: () => Promise.resolve(gateDecisionsFixture()),
	} satisfies ClioDecisionsInspector,
	evidenceInspector: {
		inspect: () => Promise.resolve(evidenceInspectionFixture()),
		read: (_cwd, evidenceId) => Promise.resolve({ ...evidenceDetailFixture(), evidenceId }),
	} satisfies ClioEvidenceInspector,
	acpTiming: { permissionTimeoutMs: 120_000, cancelGraceMs: 2_000, closeTimeoutMs: 1_000, exitGraceMs: 1_000 },
});

const browser = await chromium.launch({ executablePath: options.chrome, headless: true });
const browserErrors: string[] = [];
const requestFailures: string[] = [];

try {
	const context = await browser.newContext({
		viewport: { width: 1600, height: 1100 },
		colorScheme: "dark",
		reducedMotion: "reduce",
		deviceScaleFactor: 1,
	});
	// Request failures on any page are diagnostics, not verdicts: Chrome cancels
	// in-flight requests with net::ERR_NETWORK_CHANGED whenever a WSL2 or VPN
	// interface flaps, and the app is expected to recover from that (see below).
	context.on("requestfailed", (request) => {
		requestFailures.push(`${request.method()} ${request.url()} (${request.failure()?.errorText ?? "failed"})`);
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
	equal(await page.getByRole("textbox", { name: "Prompt for Clio Coder" }).count(), 1);
	equal(await page.getByText("No project open", { exact: true }).count(), 1);
	await page.screenshot({ path: new URL("initial.png", artifactDirectory).pathname });

	// A launch whose first stylesheet and bootstrap requests the browser cancels
	// (what net::ERR_NETWORK_CHANGED does on WSL2) must still come up styled and
	// connected: the app reloads the failed stylesheet and retries the bootstrap.
	const flappingPage = await context.newPage();
	flappingPage.on("pageerror", (error) => browserErrors.push(`page: ${error.message}`));
	let stylesheetCancelled = false;
	let bootstrapCancelled = false;
	await flappingPage.route("**/*.css", (route) => {
		stylesheetCancelled = true;
		return route.abort("failed");
	}, { times: 1 });
	await flappingPage.route("**/api/bootstrap", (route) => {
		bootstrapCancelled = true;
		return route.abort("failed");
	}, { times: 1 });
	await flappingPage.goto(running.url, { waitUntil: "networkidle" });
	await flappingPage.getByText("connected", { exact: true }).waitFor();
	ok(stylesheetCancelled && bootstrapCancelled);
	deepEqual(
		await flappingPage.evaluate(() => ({
			stylesheetRules: [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
				.map((link) => (link.sheet?.cssRules.length ?? 0) > 0),
			statusBarDisplay: getComputedStyle(document.querySelector(".status-bar")!).display,
		})),
		{ stylesheetRules: [true], statusBarDisplay: "flex" },
	);
	await flappingPage.close();

	// The directory browser lists folders only and refuses the guarded home root.
	await page.getByRole("button", { name: "Browse folders" }).click();
	const browseDialog = page.getByRole("dialog", { name: "Choose a project folder" });
	await browseDialog.waitFor();
	await browseDialog.getByText(/home directory cannot be opened/u).waitFor();
	equal(await browseDialog.getByRole("button", { name: "Open this folder" }).isDisabled(), true);
	await browseDialog.getByRole("button", { name: "code" }).click();
	await page.waitForFunction(() =>
		document.querySelector(".browse__path code")?.textContent?.endsWith("/code") === true
	);
	await browseDialog.getByRole("button", { name: "Up one folder" }).click();
	await browseDialog.getByText(/home directory cannot be opened/u).waitFor();
	await browseDialog.getByRole("button", { name: "code" }).click();
	await browseDialog.getByRole("button", { name: "atlas-field-study" }).click();
	await page.waitForFunction(() =>
		document.querySelector(".browse__actions button:last-child")?.hasAttribute("disabled") === false
	);
	await page.screenshot({ path: new URL("browse-folder.png", artifactDirectory).pathname });
	await browseDialog.getByRole("button", { name: "Open this folder" }).click();

	await page.getByRole("heading", { level: 1, name: "atlas-field-study" }).waitFor();
	await page.getByText("README.md", { exact: true }).waitFor();

	// A scoped file lifecycle keeps modal focus contained and restores it.
	const scratchName = `browser-smoke-${crypto.randomUUID().slice(0, 8)}.tmp`;
	const movedScratchName = scratchName.replace(".tmp", "-moved.tmp");
	const filesSection = page.locator(".rail-section--files");
	const fileToolbar = filesSection.locator(".file-toolbar");
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
	await page.screenshot({ path: new URL("file-create.png", artifactDirectory).pathname });
	await operationDialog.getByRole("button", { name: "Apply in project" }).click();
	let scratchNode = page.locator(".file-node").filter({ hasText: scratchName });
	await scratchNode.waitFor();
	await scratchNode.click();

	await fileToolbar.getByRole("button", { name: "Rename" }).click();
	operationDialog = page.getByRole("dialog", { name: "Rename or move" });
	await operationDialog.getByLabel("Destination name").fill(movedScratchName);
	await page.screenshot({ path: new URL("file-move.png", artifactDirectory).pathname });
	await operationDialog.getByRole("button", { name: "Apply in project" }).click();
	scratchNode = page.locator(".file-node").filter({ hasText: movedScratchName });
	await scratchNode.waitFor();
	await scratchNode.click();

	await fileToolbar.getByRole("button", { name: "Delete" }).click();
	operationDialog = page.getByRole("dialog", { name: "Prepare confirmed delete" });
	await operationDialog.getByRole("button", { name: "Inspect and prepare" }).click();
	const deleteDialog = page.getByRole("dialog", { name: "Delete file" });
	await deleteDialog.getByText(movedScratchName, { exact: true }).waitFor();
	await page.screenshot({ path: new URL("file-delete.png", artifactDirectory).pathname });
	await deleteDialog.getByRole("button", { name: "Delete exactly this item" }).click();
	await scratchNode.waitFor({ state: "detached" });

	const scratchFolderName = `browser-smoke-${crypto.randomUUID().slice(0, 8)}`;
	await fileToolbar.getByRole("button", { name: "New folder" }).click();
	operationDialog = page.getByRole("dialog", { name: "Create folder" });
	await operationDialog.getByLabel("Name", { exact: true }).fill(scratchFolderName);
	await page.screenshot({ path: new URL("folder-create.png", artifactDirectory).pathname });
	await operationDialog.getByRole("button", { name: "Apply in project" }).click();
	const scratchFolderNode = page.locator(".file-node").filter({ hasText: scratchFolderName });
	await scratchFolderNode.waitFor();
	await scratchFolderNode.click();
	await fileToolbar.getByRole("button", { name: "Delete" }).click();
	operationDialog = page.getByRole("dialog", { name: "Prepare confirmed delete" });
	await operationDialog.getByRole("button", { name: "Inspect and prepare" }).click();
	const deleteFolderDialog = page.getByRole("dialog", { name: "Delete empty folder" });
	equal(await deleteFolderDialog.locator(".delete-confirmation__target code").innerText(), scratchFolderName);
	await page.screenshot({ path: new URL("folder-delete.png", artifactDirectory).pathname });
	await deleteFolderDialog.getByRole("button", { name: "Delete exactly this item" }).click();
	await scratchFolderNode.waitFor({ state: "detached" });
	await filesSection.getByRole("button", { name: "Refresh project tree" }).click();

	const desktopRailGeometry = await page.locator("#project-rail").evaluate((rail) => ({
		clientWidth: rail.clientWidth,
		scrollWidth: rail.scrollWidth,
		scrollLeft: rail.scrollLeft,
	}));
	ok(desktopRailGeometry.scrollWidth <= desktopRailGeometry.clientWidth);
	equal(desktopRailGeometry.scrollLeft, 0);

	// The first broad read-only harness surface is a real, bounded Clio Coder graph,
	// not raw CLI JSON or a second configuration implementation in React.
	await page.getByRole("button", { name: "Effective Clio Coder", exact: true }).click();
	const effectiveMap = page.getByRole("region", { name: "Effective Clio Coder map" });
	await effectiveMap.getByRole("heading", { name: "Why Clio Coder behaves this way" }).waitFor();
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
	await page.screenshot({ path: new URL("effective-clio-coder.png", artifactDirectory).pathname, fullPage: true });
	await effectiveMap.getByRole("button", { name: "Back to conversation" }).click();
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
	await catalog.getByRole("button", { name: "Clear catalog filter" }).click();
	await catalog.getByRole("heading", { name: "Researcher" }).waitFor();
	await catalogSearch.fill("citation-ready");
	await catalog.getByRole("heading", { name: "Researcher" }).waitFor();
	await catalogSearch.fill("");
	await page.screenshot({ path: new URL("catalog.png", artifactDirectory).pathname, fullPage: true });
	const agentsTab = catalog.getByRole("tab", { name: /^Agents/u });
	await agentsTab.focus();
	await page.keyboard.press("ArrowRight");
	await catalog.getByRole("heading", { name: "frontend-design" }).waitFor();
	equal(await catalog.getByRole("tab", { name: /^Skills/u }).getAttribute("aria-selected"), "true");
	// The previous read was filtered to the skills the model may load, so every
	// card structurally said "trusted" and "allowed". A skill the operator kept
	// for themselves is now on screen and says so.
	await catalog.getByRole("heading", { name: "release-notes" }).waitFor();
	await catalog.getByText("Its frontmatter reserves it for you", { exact: true }).waitFor();
	await catalog.getByText("1 of 2 is yours alone; the model never sees them.", { exact: false }).waitFor();
	await catalog.getByText("installed by a dispatched worker", { exact: false }).waitFor();
	// The body, its location, and both hashes are what this read exists to drop.
	for (const forbidden of ["/home/", "SKILL.md", "sha256", "https://"]) {
		equal(
			await catalog.getByText(forbidden, { exact: false }).count(),
			0,
			`the skill panel leaked ${forbidden}`,
		);
	}
	await page.screenshot({ path: new URL("catalog-skills.png", artifactDirectory).pathname, fullPage: true });
	await page.keyboard.press("ArrowRight");
	await catalog.getByRole("heading", { name: "experiment-protocol" }).waitFor();
	equal(await catalog.getByRole("tab", { name: /^Library/u }).getAttribute("aria-selected"), "true");
	await page.screenshot({ path: new URL("catalog-library.png", artifactDirectory).pathname, fullPage: true });
	await page.keyboard.press("ArrowRight");
	await catalog.getByRole("heading", { name: "Clio Coder Lab Pack" }).waitFor();
	await catalog.getByText("Project-scoped package", { exact: true }).waitFor();
	await catalog.getByText("Native roots and lifecycle mutations remain host-side", { exact: true }).waitFor();
	equal(await catalog.getByRole("tab", { name: /^Extensions/u }).getAttribute("aria-selected"), "true");
	await page.screenshot({ path: new URL("catalog-extensions.png", artifactDirectory).pathname, fullPage: true });
	await page.keyboard.press("ArrowRight");
	await catalog.getByRole("heading", { name: "lint.rust" }).waitFor();
	// A package-script check and a catalog check are the same plane with
	// different execution authority, and the card says which is which.
	await catalog.getByText("Verify runs npm with this script name and may pass extra argv", { exact: true })
		.waitFor();
	await catalog.getByText("Verify pins argv, working directory, and timeout through safe-exec", { exact: true })
		.waitFor();
	await catalog.getByText("Runs in a subdirectory", { exact: true }).waitFor();
	// A toolchain declaration nothing has adopted is named as such rather than
	// listed beside the checks that actually run.
	await catalog.getByText("Authoring would offer this check; nothing runs it until you write the catalog", {
		exact: true,
	}).waitFor();
	// The argv cannot appear here because the wire type has no field for it; that
	// is proven in the protocol and adapter tests. What this asserts is the other
	// half, that the panel's own copy names no location either.
	for (const forbidden of ["/home/", ".clio-coder", "verifiers.yaml"]) {
		equal(
			await catalog.getByText(forbidden, { exact: false }).count(),
			0,
			`the verifier panel leaked ${forbidden}`,
		);
	}
	// A count crossing instead of the vector is the whole point, so it is asserted
	// rather than left to the forbidden list.
	await catalog.getByText("2 held host-side", { exact: true }).first().waitFor();
	// Nothing in this panel offers to author, edit, or run a check.
	equal(await catalog.getByRole("button", { name: /author|dry.run|edit|remove/iu }).count(), 0);
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
	await catalog.getByRole("button", { name: "Back to conversation" }).click();
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
	await usageRecord.getByRole("button", { name: "Back to conversation" }).click();
	await page.getByRole("region", { name: "Conversation history" }).waitFor();

	// Fleet status is deliberately a separate installation-wide snapshot. The
	// fixed adapter reduces durable rows to heartbeat counts and totals before
	// anything reaches the browser.
	await page.getByRole("button", { name: "Dispatch", exact: true }).click();
	const dispatchRecord = page.getByRole("region", { name: "Installation-wide dispatch snapshot" });
	await dispatchRecord.getByRole("heading", { name: "Dispatch across this Clio Coder installation" }).waitFor();
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
	await dispatchRecord.getByRole("button", { name: "Back to conversation" }).click();
	await page.getByRole("region", { name: "Conversation history" }).waitFor();

	// Durable run inspection is also installation-wide, but retains bounded run
	// identities, journal lines, and receipt trust selected by Clio Coder.
	await page.getByRole("button", { name: "Runs", exact: true }).click();
	const fleetJournal = page.getByRole("region", { name: "Recent run journal" });
	await fleetJournal.getByText("Inspect the durable event boundary", { exact: true }).waitFor();
	await fleetJournal.getByText("Receipt verified", { exact: true }).waitFor();
	await fleetJournal.getByText("tool completed", { exact: true }).waitFor();
	await fleetJournal.getByText("run-alpha", { exact: true }).first().waitFor();
	for (const forbidden of ["receiptPath", "events.ndjson", "/receipts/"]) {
		equal(await fleetJournal.getByText(forbidden, { exact: false }).count(), 0);
	}
	// The same refresh reads the trace database, so the selected run carries its
	// durable accounting beside its event spine.
	const traceAccounting = fleetJournal.getByRole("region", { name: "Durable accounting for run run-alpha" });
	await traceAccounting.getByText("28,665", { exact: true }).waitFor();
	await traceAccounting.getByText("$0.42", { exact: true }).waitFor();
	const tracePhases = traceAccounting.getByRole("list", { name: "Phases for run run-alpha" });
	await tracePhases.getByText("errored", { exact: true }).waitFor();
	for (const forbidden of ["the prompt text", "trace.sqlite", "phase_id"]) {
		equal(await traceAccounting.getByText(forbidden, { exact: false }).count(), 0);
	}

	// Events and processes cross as shapes. The tail and the command lines do not,
	// and the panel says so rather than leaving the absence to be inferred.
	const eventKinds = traceAccounting.getByRole("list", { name: "Event kinds for run run-alpha" });
	await eventKinds.getByText("message_update", { exact: true }).waitFor();
	await eventKinds.getByText("211", { exact: true }).waitFor();
	await traceAccounting.getByRole("list", { name: "Process kinds for run run-alpha" }).getByText("worker", {
		exact: true,
	}).waitFor();
	await traceAccounting.getByText(/stay on the host by design/u).waitFor();
	// Row-level artifacts, not the words: the panel's own disclosure names command
	// lines and payloads, so the check has to look for their shapes instead.
	for (const forbidden of ["payload_json", "birth_token", "command_digest", "/usr/bin"]) {
		equal(await traceAccounting.getByText(forbidden, { exact: false }).count(), 0);
	}

	// Verifying re-reads the sealed bytes, so its verdict is stated separately from
	// the trust state the snapshot recorded rather than replacing it.
	await fleetJournal.getByRole("button", { name: "Check this receipt now", exact: true }).click();
	const receiptCheck = fleetJournal.getByLabel("Receipt check for run run-alpha");
	await receiptCheck.getByText("Receipt did not authenticate", { exact: true }).waitFor();
	await receiptCheck.getByText(/no longer agrees with its ledger entry/u).waitFor();
	// The snapshot's own verdict is still on screen and still says what it said.
	await fleetJournal.getByText("Receipt verified", { exact: true }).waitFor();
	for (const forbidden of ["/home/", "receipts/", "sha256"]) {
		equal(await receiptCheck.getByText(forbidden, { exact: false }).count(), 0);
	}

	// The evidence inventory links a bundle back into the run window and says so
	// when a bundle predates the canonical trust projection.
	const evidenceInventory = fleetJournal.getByRole("region", { name: "Durable evidence built from these runs" });
	await evidenceInventory.getByText("run-alpha-bundle", { exact: true }).waitFor();
	await evidenceInventory.getByText("Compromised", { exact: true }).waitFor();
	await evidenceInventory.getByRole("list", { name: "Tags on run-alpha-bundle" }).getByText("blocked-tool", {
		exact: true,
	}).waitFor();
	await evidenceInventory.getByText(/no verdict of its own/u).waitFor();
	// run-alpha is in the window and run-beta is not, so exactly one of the two
	// run references is selectable. Scoped to the run list, because a historical
	// bundle also disables its own open control for an unrelated reason.
	const bundleRuns = evidenceInventory.locator(".evidence-list__runs");
	equal(await bundleRuns.getByRole("button", { disabled: false }).count(), 1);
	equal(await bundleRuns.getByRole("button", { disabled: true }).count(), 1);
	// The bundle that predates the canonical projection has no record to open.
	equal(
		await evidenceInventory.getByRole("button", { name: "Open trust record", exact: true, disabled: true }).count(),
		1,
	);
	for (const forbidden of ["tasks", "cwds", "transcript.md", "/home/"]) {
		equal(await evidenceInventory.getByText(forbidden, { exact: false }).count(), 0);
	}

	// A bundle is opened by an id the host served, and the record that comes back
	// names the axis behind the verdict rather than repeating the verdict.
	await evidenceInventory.getByRole("button", { name: "Open trust record", exact: true }).first().click();
	const trustRecord = evidenceInventory.getByLabel("Trust record for run-alpha-bundle");
	// The record has one row per covered run, so every axis label appears twice.
	// `count()` does not auto-wait, so the wait has to come first or the assertion
	// races the read that is still in flight.
	await trustRecord.getByText("Validation grounding", { exact: true }).first().waitFor();
	// The record has one row per covered run, so every axis label appears twice.
	equal(await trustRecord.getByText("Validation grounding", { exact: true }).count(), 2);
	await trustRecord.getByText("failed", { exact: true }).first().waitFor();
	await trustRecord.getByText("enforced", { exact: true }).first().waitFor();
	for (const forbidden of ["/home/", "sha256", "receipt-quality"]) {
		equal(await trustRecord.getByText(forbidden, { exact: false }).count(), 0);
	}

	// The fleet root index names the planned steps and only offers a selection
	// for a step whose run is actually in this bounded window.
	const fleetRoots = fleetJournal.getByRole("region", { name: "Fleets that dispatched these runs" });
	await fleetRoots.getByText("build-review", { exact: true }).waitFor();
	await fleetRoots.getByText("fleet-345ea2e6c1ad", { exact: true }).waitFor();
	await fleetRoots.getByText("2 of 3", { exact: true }).waitFor();
	const stepIndex = fleetRoots.getByRole("list", { name: "Planned steps for fleet build-review" });
	await stepIndex.getByText("builder · run-alpha", { exact: true }).waitFor();
	await stepIndex.getByText("debugger · outside this run window", { exact: true }).waitFor();
	await stepIndex.getByText("no run recorded", { exact: true }).waitFor();
	equal(await stepIndex.getByRole("button", { disabled: true }).count(), 2);
	equal(await fleetRoots.getByText("/fleet-runs/", { exact: false }).count(), 0);
	// Selecting the step whose run is in the window drives the run record beside it.
	await stepIndex.getByRole("button", { disabled: false }).first().click();
	await fleetJournal.getByRole("heading", { name: "builder · run-alpha" }).waitFor();

	// A sealed gate verdict says what the coordinator concluded about these runs
	// and how far its grader was from the route it was grading.
	const gates = fleetJournal.getByRole("region", { name: "Verdicts reached about these runs" });
	await gates.getByText("Review gate ran out of cycles", { exact: true }).waitFor();
	await gates.getByText("Compete gate picked a winner", { exact: true }).waitFor();
	await gates.getByText("not independent: the same model family", { exact: true }).waitFor();
	await gates.getByText("independent of the route it graded", { exact: true }).waitFor();
	await gates.getByText("candidate 2", { exact: true }).waitFor();
	// The reason is the host's classification, never the sealed text behind it.
	await gates.getByText(/the reviewer did not answer under its typed contract/u).waitFor();
	// An artifact that no longer authenticates is counted rather than hidden.
	await gates.getByText(/no longer authenticate against their own integrity digest/u).waitFor();
	// run-alpha is the one graded run inside this window; the reviewer, judge and
	// both candidates are not, so exactly one reference is selectable.
	const gateRuns = gates.getByRole("list", { name: "Runs graded by gate fleet-345ea2e6c1ad:review" });
	await gateRuns.getByRole("button", { disabled: false }).first().waitFor();
	equal(await gateRuns.getByRole("button", { disabled: false }).count(), 1);
	equal(await gateRuns.getByRole("button", { disabled: true }).count(), 1);
	for (const forbidden of ["failed check", "verifier report", "clio/compete/", "/gate-decisions/", "sha256"]) {
		equal(await gates.getByText(forbidden, { exact: false }).count(), 0);
	}
	await gateRuns.getByRole("button", { disabled: false }).first().click();
	await fleetJournal.getByRole("heading", { name: "builder · run-alpha" }).waitFor();

	// Council topology names who was seated and how many rounds each voice took,
	// and says nothing about what any of them argued.
	const councils = fleetJournal.getByRole("region", { name: "Councils that ran through this ledger" });
	await councils.getByText("council-mfa2x1-7b3d0e", { exact: true }).waitFor();
	await councils.getByText("2 seated voices", { exact: true }).waitFor();
	await councils.getByText("2 of 2", { exact: true }).waitFor();
	await councils.getByText("the operator asked for it", { exact: true }).waitFor();
	await councils.getByText("operator approved the plan", { exact: true }).waitFor();
	const councilGrid = councils.getByRole("list", { name: "Seated voices for council council-mfa2x1-7b3d0e" });
	await councilGrid.getByText("architect", { exact: true }).waitFor();
	await councilGrid.getByText("skeptic", { exact: true }).waitFor();
	// The closed outcome taxonomy is said, not the member's answer.
	await councilGrid.getByText("round 2 · timed out", { exact: true }).waitFor();
	await councils.getByText("a judge dispatched to synthesize the answers", { exact: true }).waitFor();
	await councils.getByText("verifier · local-lmstudio/qwen3-coder", { exact: true }).waitFor();
	// One voice's final round is inside the run window and three references are
	// not, so exactly one round chip is selectable. The wait precedes the count,
	// which does not auto-wait.
	await councilGrid.getByRole("button", { disabled: false }).first().waitFor();
	equal(await councilGrid.getByRole("button", { disabled: false }).count(), 1);
	equal(await councilGrid.getByRole("button", { disabled: true }).count(), 3);
	// The sealed report is a ledger row like any other and aged out of the window.
	await councils.getByText("run-council-sealed · outside this run window", { exact: true }).waitFor();
	// A council's deliberation is host-only, and the panel says so rather than
	// leaving the absence to be inferred.
	await councils.getByText(/Member answers, the judge's text, and the vote tally are model prose/u).waitFor();
	// The run window's own task text sits a few hundred pixels above this panel
	// and is exactly the class of prose a council row must never acquire.
	for (const forbidden of ["Inspect the durable event boundary", "briefing", "receipts/", "/home/"]) {
		equal(await councils.getByText(forbidden, { exact: false }).count(), 0);
	}
	// Selecting a round drives the same run record the step index drives.
	await councilGrid.getByRole("button", { disabled: false }).first().click();
	await fleetJournal.getByRole("heading", { name: "builder · run-alpha" }).waitFor();
	const fleetAccessibility = await new AxeBuilder({ page })
		.withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
		.analyze();
	const fleetBlockingViolations = fleetAccessibility.violations.filter((violation) =>
		violation.impact === "critical" || violation.impact === "serious"
	);
	deepEqual(
		fleetBlockingViolations.map((violation) => ({
			id: violation.id,
			impact: violation.impact,
			nodes: violation.nodes.map((node) => node.target),
		})),
		[],
	);
	await page.screenshot({ path: new URL("runs.png", artifactDirectory).pathname, fullPage: true });
	await page.setViewportSize({ width: 375, height: 820 });
	const compactFleetGeometry = await page.evaluate(() => ({
		documentWidth: document.documentElement.scrollWidth,
		viewportWidth: globalThis.innerWidth,
		regionScrollWidth: document.querySelector<HTMLElement>(".conversation__scroll")?.scrollWidth ?? 0,
		regionClientWidth: document.querySelector<HTMLElement>(".conversation__scroll")?.clientWidth ?? 0,
	}));
	ok(compactFleetGeometry.documentWidth <= compactFleetGeometry.viewportWidth);
	ok(compactFleetGeometry.regionScrollWidth <= compactFleetGeometry.regionClientWidth + 1);
	await page.screenshot({ path: new URL("runs-compact.png", artifactDirectory).pathname, fullPage: true });
	await page.setViewportSize({ width: 1600, height: 1100 });
	await fleetJournal.getByRole("button", { name: "Back to conversation" }).click();
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
	const composer = page.getByRole("textbox", { name: "Prompt for Clio Coder" });
	await composer.fill("Write the fixture note.");
	await page.getByRole("button", { name: "Send" }).click();
	await page.locator("#permission-title").waitFor();
	equal(await page.title(), "● Approval needed — Clio Coder");
	// The conversation folds the tool and its approval into one activity group
	// that opens on its own while something needs attention.
	await page.locator(".activity--warning[open] .activity-row--approval.is-waiting").waitFor();
	await page.locator(".live-chip--waiting").getByText("Waiting for your approval").waitFor();
	await page.screenshot({ path: new URL("permission.png", artifactDirectory).pathname });
	const inProgressDraft = Array.from({ length: 24 }, (_, index) => `Draft line ${index + 1}`).join("\n");
	await composer.fill(inProgressDraft);
	const draftScrollTop = await composer.evaluate((element) => {
		const textarea = element as HTMLTextAreaElement;
		textarea.scrollTop = textarea.scrollHeight;
		return textarea.scrollTop;
	});
	ok(draftScrollTop > 0);
	// Both the banner and the anchored activity row offer the answer, so name which one.
	equal(await page.getByRole("button", { name: "Allow once" }).count(), 2);
	await page.locator(".activity-row__approval").getByRole("button", { name: "Allow once" }).click();
	const completedOutcome = page.locator(".turn-outcome__label", { hasText: "Turn complete" });
	await completedOutcome.waitFor();
	equal(await page.title(), "Clio Coder");
	// The outcome line carries the exact reported token fields; the Observatory compares them.
	await page.locator(".turn-outcome__fact", { hasText: "tokens 5 in · 8 out" }).waitFor();
	await page.locator(".token-ledger__row--input").getByText("5", { exact: true }).waitFor();
	await page.getByText("the GUI does not infer a price.", { exact: false }).waitFor();
	await page.locator(".live-chip--done").waitFor();
	equal(await composer.inputValue(), inProgressDraft);
	ok(await composer.evaluate((element) => (element as HTMLTextAreaElement).scrollTop) > 0);
	// The narrative is Markdown, and the tools it used stay folded behind one summary.
	await page.locator(".markdown.is-complete").first().waitFor();
	equal(await page.locator(".activity").count(), 1);
	await page.screenshot({ path: new URL("complete.png", artifactDirectory).pathname });

	// The Session Timeline keeps the card-by-card record, and switching views
	// keeps the draft and the scroll positions of both surfaces.
	const conversationScrollTop = await page.locator(".conversation__scroll").evaluate((region) => {
		region.scrollTop = 0;
		return region.scrollTop;
	});
	await page.getByRole("button", { name: "Timeline", exact: true }).click();
	await page.locator(".evidence-timeline").waitFor();
	await page.getByText("Observed on ACP", { exact: true }).first().waitFor();
	await page.locator(".turn-usage").getByText("Input", { exact: true }).waitFor();
	await page.getByRole("heading", { name: "Turn complete", exact: true }).waitFor();
	equal(await page.locator(".timeline-card").count(), 6);
	equal(await composer.inputValue(), inProgressDraft);
	await page.screenshot({ path: new URL("timeline.png", artifactDirectory).pathname });
	await page.locator(".conversation__scroll").evaluate((region) => {
		region.scrollTop = 120;
	});
	await page.getByRole("button", { name: "Conversation", exact: true }).click();
	await page.locator(".chat").waitFor();
	equal(await page.locator(".conversation__scroll").evaluate((region) => region.scrollTop), conversationScrollTop);
	equal(await composer.inputValue(), inProgressDraft);
	await page.getByRole("button", { name: "Timeline", exact: true }).click();
	equal(await page.locator(".conversation__scroll").evaluate((region) => region.scrollTop), 120);
	await page.getByRole("button", { name: "Conversation", exact: true }).click();

	// A reload restores the conversation from host-held state.
	await page.reload({ waitUntil: "networkidle" });
	await page.getByText("connected", { exact: true }).waitFor();
	await page.getByRole("heading", { level: 1, name: "atlas-field-study" }).waitFor();
	await page.locator(".turn-outcome__label", { hasText: "Turn complete" }).waitFor();
	equal(await page.locator(".turn-outcome__fact", { hasText: "tokens 5 in · 8 out" }).count(), 1);
	equal(await page.locator("#permission-title").count(), 0);

	// Stopping a parked turn is an operator cancellation, not a denial.
	await composer.fill("Park this one and stop it.");
	await page.getByRole("button", { name: "Send" }).click();
	await page.locator("#permission-title").waitFor();
	await page.getByRole("button", { name: "Stop" }).click();
	await page.locator(".turn-outcome__label", { hasText: "Turn stopped" }).waitFor();
	await page.getByText(/Clio Coder was not told no/u).first().waitFor();

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
		await deleteSessionDialog.getByText(/Neither the desktop app nor Clio Coder can bring them back/u).waitFor();
		await resumePage.screenshot({ path: new URL("session-delete.png", artifactDirectory).pathname });
		await deleteSessionDialog.getByRole("button", { name: "Keep session" }).click();
		await renamedRow.waitFor();

		await renamedRow.getByRole("button", { name: "Resume" }).click();
		// The conversation shows the replayed turns as earlier records first.
		await resumePage.locator(".chat-turn.is-replay").first().waitFor();
		equal(await resumePage.locator(".chat-turn.is-replay").count(), 2);
		equal(await resumePage.locator(".chat-request__replay").count(), 2);
		equal(await resumePage.locator(".chat-turn time").count(), 0, "replay renders without an invented time");
		await resumePage.getByRole("button", { name: "Timeline", exact: true }).click();
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
			Array.from({ length: 6 }, () => "Replayed from Clio Coder"),
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
		await resumePage.getByRole("textbox", { name: "Prompt for Clio Coder" }).fill("Continue the branch.");
		await resumePage.getByRole("button", { name: "Send" }).click();
		// The live turn is identified by being the one card that is not marked as history.
		await resumePage.waitForFunction(() =>
			document.querySelectorAll(".timeline-card:not(.timeline-card--replay)").length >= 3
		);
		ok(await resumePage.locator(".timeline-card--replay").count() >= 6);
		await resumePage.getByRole("button", { name: "Conversation", exact: true }).click();
		await resumePage.locator(".chat-turn.is-live, .chat-turn.is-settled:not(.is-replay)").first().waitFor();
		equal(await resumePage.locator(".chat-turn.is-replay").count(), 2);
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
		recoveryInspector: {
			inspect: (_cwd, projectContext) => Promise.resolve({ ...recoveryInspectionFixture(), projectContext }),
		} satisfies ClioRecoveryInspector,
		toolchainInspector: {
			inspect: () => Promise.resolve(toolchainInspectionFixture()),
		} satisfies ClioToolchainInspector,
		interopInspector: {
			inspect: () => Promise.resolve(interopInspectionFixture()),
		} satisfies ClioInteropInspector,
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
		const settingsDialog = settingsPage.getByRole("dialog", { name: "Clio Coder settings" });
		await settingsDialog.waitFor();
		await settingsPage.screenshot({ path: new URL("settings-options.png", artifactDirectory).pathname });
		await settingsDialog.getByRole("button", { name: "Inspect toolchain", exact: true }).click();
		const toolchainInventory = settingsDialog.locator(".settings__toolchain");
		await toolchainInventory.getByText("Apache-2.0", { exact: true }).waitFor();
		await toolchainInventory.getByText("Using pinned copy", { exact: true }).waitFor();
		await toolchainInventory.getByText(/does not clear the 26\.8\.15 floor/u).waitFor();
		for (const forbidden of ["/home/", "/native/", "installDir", "binaryPath"]) {
			equal(await toolchainInventory.getByText(forbidden, { exact: false }).count(), 0);
		}
		await toolchainInventory.scrollIntoViewIfNeeded();
		await settingsPage.screenshot({ path: new URL("settings-toolchain.png", artifactDirectory).pathname });

		// External agent detection says how far each agent is wired, in words that
		// keep "wired", "offered again", and "cannot speak to it" distinct.
		await settingsDialog.getByRole("button", { name: "Detect agents", exact: true }).click();
		const interopInventory = settingsDialog.locator(".settings__interop");
		await interopInventory.getByText("3 of 8 known kinds", { exact: true }).waitFor();
		await interopInventory.getByText("wired as a delegation peer", { exact: true }).waitFor();
		await interopInventory.getByText("offered again; the facts moved since you last answered", { exact: true })
			.waitFor();
		await interopInventory.getByText("speaks no ACP; Clio Coder cannot delegate to it", { exact: true }).waitFor();
		await interopInventory.getByText("would be fetched on first use", { exact: true }).waitFor();
		// The panel states that wiring is a terminal review and offers no control
		// that would do it.
		await interopInventory.getByText(/Wiring an agent as a delegation peer is an explicit review/u).waitFor();
		equal(await interopInventory.getByRole("button", { name: /wire|connect|add/iu }).count(), 0);
		// The resolved binary, the agent's own directory, and the keying
		// fingerprint are all host-side facts.
		for (const forbidden of ["/home/", "/usr/", ".claude", "sha256", "installDir", "binary"]) {
			equal(await interopInventory.getByText(forbidden, { exact: false }).count(), 0);
		}
		await interopInventory.scrollIntoViewIfNeeded();
		await settingsPage.screenshot({ path: new URL("settings-interop.png", artifactDirectory).pathname });
		await settingsDialog.getByRole("button", { name: "Run diagnostics", exact: true }).click();
		const recoveryRecord = settingsDialog.getByLabel("Clio Coder diagnostic summary");
		await recoveryRecord.getByText("ATTENTION REQUIRED", { exact: true }).waitFor();
		await recoveryRecord.getByText("2 reported failures", { exact: true }).waitFor();
		await recoveryRecord.getByText("Targets & models", { exact: true }).waitFor();
		await recoveryRecord.getByText("0/2 passed · 1 warn · 1 fail", { exact: true }).waitFor();
		// A section carrying a warning or a failure opens itself, because that is
		// the row the operator came here to read; a clean one stays folded.
		const modelChecks = recoveryRecord.getByRole("list", { name: "Targets & models diagnostic checks" });
		await modelChecks.getByText("model private-lab", { exact: true }).waitFor();
		await modelChecks.getByText("target private-lab", { exact: true }).waitFor();
		await recoveryRecord.getByText("external tool yazi", { exact: true }).waitFor();
		// A clean section stays folded, so its checks are out of the accessibility
		// tree until the operator opens it.
		equal(await recoveryRecord.getByRole("list", { name: "Runtime diagnostic checks" }).count(), 0);
		equal(await recoveryRecord.getByText("Unnamed check", { exact: true }).isVisible(), false);
		await recoveryRecord.getByText("Other checks", { exact: true }).click();
		await recoveryRecord.getByText("Unnamed check", { exact: true }).waitFor();
		for (const forbidden of ["/home/", "http://", "model-secret", "herdr.sock", "below the floor", "10.0.0"]) {
			equal(await recoveryRecord.getByText(forbidden, { exact: false }).count(), 0);
		}
		await settingsPage.screenshot({ path: new URL("settings-recovery.png", artifactDirectory).pathname });
		await settingsDialog.locator(".recovery-boundary").scrollIntoViewIfNeeded();

		const targetSetting = settingsDialog.getByLabel("Set orchestrator.target");
		const modelSetting = settingsDialog.getByLabel("Set orchestrator.model");
		const thinkingSetting = settingsDialog.getByLabel("Set orchestrator.thinkingLevel");
		const autonomySetting = settingsDialog.getByLabel("Set autonomy");
		deepEqual(await targetSetting.locator("option").allTextContents(), ["unset", "lmstudio", "offline-lab"]);
		deepEqual(await modelSetting.locator("option").allTextContents(), [
			"unset",
			"qwen3.8-27b",
			"qwen3.8-4b",
		]);
		deepEqual(await thinkingSetting.locator("option").allTextContents(), [
			"off",
			"minimal",
			"low",
			"medium",
			"high",
			"xhigh",
			"max",
		]);
		deepEqual(await autonomySetting.locator("option").allTextContents(), [
			"read-only",
			"suggest",
			"auto-edit",
			"full-auto",
		]);
		await targetSetting.selectOption("offline-lab");
		await settingsPage.waitForFunction(() =>
			document.querySelector<HTMLSelectElement>('[aria-label="Set orchestrator.target"]')?.value === "offline-lab"
		);
		await settingsPage.waitForFunction(() =>
			[...document.querySelectorAll<HTMLOptionElement>('[aria-label="Set orchestrator.model"] option')].some(
				(option) => option.value === "stub-tiny",
			)
		);
		deepEqual(await modelSetting.locator("option").allTextContents(), ["unset", "stub-tiny"]);
		await targetSetting.selectOption("lmstudio");
		await settingsPage.waitForFunction(() =>
			document.querySelector<HTMLSelectElement>('[aria-label="Set orchestrator.target"]')?.value === "lmstudio"
		);
		await settingsPage.waitForFunction(() =>
			[...document.querySelectorAll<HTMLOptionElement>('[aria-label="Set orchestrator.model"] option')].some(
				(option) => option.value === "qwen3.8-27b",
			)
		);
		deepEqual(await modelSetting.locator("option").allTextContents(), ["unset", "qwen3.8-27b", "qwen3.8-4b"]);
		await thinkingSetting.selectOption("high");
		await settingsPage.waitForFunction(() =>
			document.querySelector<HTMLSelectElement>('[aria-label="Set orchestrator.thinkingLevel"]')?.value === "high"
		);
		await autonomySetting.selectOption("suggest");
		await settingsPage.waitForFunction(() =>
			document.querySelector<HTMLSelectElement>('[aria-label="Set autonomy"]')?.value === "suggest"
		);
		await autonomySetting.selectOption("auto-edit");
		await settingsPage.waitForFunction(() =>
			document.querySelector<HTMLSelectElement>('[aria-label="Set autonomy"]')?.value === "auto-edit"
		);

		const offlineRow = settingsDialog.locator(".target-row").filter({ hasText: "offline-lab" });
		await offlineRow.getByText("not probed").waitFor();
		await offlineRow.getByRole("button", { name: "Probe offline-lab" }).click();
		await offlineRow.getByText("unhealthy").waitFor();
		await offlineRow.getByText(/not-configured/u).waitFor();
		const onlineRow = settingsDialog.locator(".target-row").filter({ hasText: "lmstudio" });
		await onlineRow.getByText("not probed").waitFor();
		await onlineRow.getByRole("button", { name: "Probe lmstudio" }).click();
		await onlineRow.getByText("healthy").waitFor();
		await onlineRow.getByText(/12 ms/u).waitFor();

		// A settings patch round-trips through Clio Coder and never through a local file.
		await modelSetting.selectOption("qwen3.8-4b");
		await settingsPage.waitForFunction(() =>
			document.querySelector<HTMLSelectElement>('[aria-label="Set orchestrator.model"]')?.value === "qwen3.8-4b"
		);
		await offlineRow.scrollIntoViewIfNeeded();
		await settingsPage.screenshot({ path: new URL("settings-targets.png", artifactDirectory).pathname });

		// The deeper routing inventory uses Clio Coder's offline catalog and effective
		// worker-profile listings; opening it never probes an endpoint.
		await settingsDialog.getByRole("button", { name: "Inspect models and routes" }).click();
		const routingInventory = settingsDialog.locator(".settings__routing");
		await routingInventory.getByRole("heading", { name: "Offline model capabilities" }).waitFor();
		await routingInventory.getByText("262,144", { exact: true }).waitFor();
		await routingInventory.getByRole("region", { name: "Worker profiles" })
			.getByText("deep-research", { exact: true }).waitFor();
		await routingInventory.getByText("Missing profile", { exact: true }).waitFor();
		const routingModelList = routingInventory.locator(".routing-model-list");
		await routingInventory.getByRole("button", { name: "lmstudio", exact: true }).click();
		await routingModelList.getByText("qwen3.8-27b", { exact: true }).waitFor();
		const routingSearch = routingInventory.getByRole("searchbox", { name: "Filter models" });
		await routingSearch.fill("4b");
		await routingModelList.getByText("qwen3.8-4b", { exact: true }).waitFor();
		// The filter applies through a deferred value, so wait for the row to leave.
		await routingModelList.getByText("qwen3.8-27b", { exact: true }).waitFor({ state: "detached" });
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

		await settingsPage.getByRole("textbox", { name: "Prompt for Clio Coder" }).fill("What autonomy is in force?");
		await settingsPage.getByRole("button", { name: "Send" }).click();
		// The gate: Clio Coder ran the next turn under the level the GUI set.
		await settingsPage.getByText("This session has seen 1 prompts at autonomy read-only.").waitFor();
		await settingsPage.close();
	} finally {
		await settingsServer.close();
		await Deno.remove(settingsScratch, { recursive: true }).catch(() => undefined);
	}

	// A fifth host replays the recorded seventeen-bash run: the approval an
	// operator missed, the silence between tool calls, and the expiry that must
	// never reach Clio Coder as a rejection.
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

		await loopPage.getByRole("textbox", { name: "Prompt for Clio Coder" }).fill("Audit the convergence study.");
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
				(settled) => document.querySelectorAll(".activity-row--approval.is-complete").length >= settled,
				call + 1,
				{ timeout: 10_000 },
			);
		}
		// Every one of those was answered by the keyboard, never by a click.
		equal(await loopPage.locator(".activity-row--approval.is-complete").count(), 16);

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
			const inlineCard = document.querySelector(".activity-row__approval");
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
		equal(await loopPage.locator(".markdown").count(), 0, "the fixture speaks no prose");
		ok(await loopPage.locator(".activity-row--loop").count() > 0);
		await loopPage.locator(".activity-row--loop").first().getByText(/Reported by Clio Coder/u).waitFor();
		// The same finding is a full card in the Session Timeline.
		await loopPage.getByRole("button", { name: "Timeline", exact: true }).click();
		await loopPage.locator(".timeline-card--loop").first().getByText(/Reported by Clio Coder/u).waitFor();
		equal(await loopPage.locator(".timeline-card--approval.is-complete").count(), 16);
		await loopPage.getByRole("button", { name: "Conversation", exact: true }).click();
		await loopPage.locator(".activity-row--loop").first().waitFor();

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

		await expiryPage.getByRole("textbox", { name: "Prompt for Clio Coder" }).fill("Audit while nobody watches.");
		await expiryPage.getByRole("button", { name: "Send" }).click();
		await expiryPage.locator(".approval-banner").waitFor();
		// Nobody answers. The card must park the turn, not deny the tool.
		await expiryPage.locator(".turn-outcome__label", { hasText: "Turn stopped" }).waitFor({ timeout: 15_000 });
		const stoppedSentence =
			/An approval waited unanswered for the whole budget, so the GUI stopped the turn\. Clio Coder was not told no; send a new prompt to continue\./u;
		await expiryPage.locator(".turn-outcome__detail").getByText(stoppedSentence).waitFor();
		// The same sentence reaches a screen reader through the live region.
		equal(await expiryPage.locator('[aria-live="assertive"]').getByText(stoppedSentence).count(), 1);
		await expiryPage.locator(".activity-row--approval").getByText(
			/Nobody answered\. The turn was stopped; Clio Coder was not told no\./u,
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
			scopedFileAndFolderLifecycle: true,
			approvalTitleFlipped: true,
			conversationSurvivedReload: true,
			launchRecoveredFromCancelledStylesheetAndBootstrap: true,
			conversationRendersMarkdownWithFoldedActivity: true,
			sessionTimelineKeepsDraftAndScrollAcrossViews: true,
			reportedUsageVisibleAndSurvivedReload: true,
			stopNeverDeniedTheTool: true,
			sessionRenamedResumedAndReplayed: true,
			sessionDeleteRequiresGuiConfirmation: true,
			unavailableProjectExplainedAndRemovable: true,
			bothTargetsProbedBeforeAnyHealthClaim: true,
			recoveryUsesRedactedDoctorAndPathsAdapters: true,
			recoveryNamesEachCheckWithoutItsDetail: true,
			toolchainUsesPathFreeFixedAdapter: true,
			interopDetectionRunsNoForeignExecutableAndNamesNoPath: true,
			verifierCheckPlaneCrossesWithoutItsArgv: true,
			skillsTheModelCannotSeeAreOnScreenAndSaidSo: true,
			safeSettingsOptionFamiliesRoundTripped: true,
			autonomySetInTheGuiReachedTheNextTurn: true,
			nextTurnAndNextSessionLabelledDistinctly: true,
			desktopRailsCollapseAndRestoreFocus: true,
			streamUpdatesPreservedTheDraftAndItsScrollPosition: true,
			effectiveClioMapUsesTheBoundedReadOnlyAdapter: true,
			catalogUsesBoundedReadOnlyAdapters: true,
			routingInventoryUsesOfflineBoundedAdapters: true,
			dispatchUsesInstallationWideBoundedAdapter: true,
			fleetRunsUseDurableBoundedAdapter: true,
			fleetRootIndexLinksOnlyRunsInThisWindow: true,
			gateVerdictsCrossWithoutTheirReasoning: true,
			councilTopologyCrossesItsShapeAndNotItsDeliberation: true,
			traceAccountingCarriesNoRequestTextOrPath: true,
			traceTailsCrossAsShapesNotRows: true,
			evidenceInventoryCarriesShapeAndTrustOnly: true,
			artifactsAreReferencedOnlyByHostServedIds: true,
			receiptVerificationIsSeparateFromTheSnapshotVerdict: true,
			compactCatalogHasNoPageOverflow: true,
			usageUsesTheProjectFilteredBoundedAdapter: true,
			compactUsageHasNoPageOverflow: true,
			compactDispatchHasNoPageOverflow: true,
			compactFleetHasNoPageOverflow: true,
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
				fleetBlockingViolations.length +
				compactBlockingViolations.length +
				resumeBlockingViolations.length + recoveryBlockingViolations.length + settingsBlockingViolations.length +
				loopBlockingViolations.length,
			browserErrors: browserErrors.length,
			requestFailures,
			screenshots: [
				"initial.png",
				"browse-folder.png",
				"file-create.png",
				"file-move.png",
				"file-delete.png",
				"folder-create.png",
				"folder-delete.png",
				"effective-clio-coder.png",
				"catalog.png",
				"catalog-skills.png",
				"catalog-library.png",
				"catalog-extensions.png",
				"catalog-verifiers.png",
				"catalog-compact.png",
				"usage.png",
				"usage-compact.png",
				"dispatch.png",
				"dispatch-compact.png",
				"runs.png",
				"runs-compact.png",
				"permission.png",
				"complete.png",
				"timeline.png",
				"compact-project-drawer.png",
				"compact-evidence-drawer.png",
				"resumed-session.png",
				"recent-project-gone.png",
				"session-delete.png",
				"settings-options.png",
				"settings-toolchain.png",
				"settings-interop.png",
				"settings-targets.png",
				"settings-recovery.png",
				"settings-routing.png",
				"approval-banner.png",
				"approval-unanswered.png",
			],
		},
		null,
		2,
	));
} catch (error) {
	// The assertion that failed rarely names the cause; the requests the browser
	// dropped and the console errors it logged usually do.
	console.error(JSON.stringify({ browserErrors, requestFailures }, null, 2));
	throw error;
} finally {
	await browser.close();
	await running.close();
	await Deno.remove(scratchRoot, { recursive: true }).catch(() => undefined);
}
