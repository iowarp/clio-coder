import { AxeBuilder } from "@axe-core/playwright";
import { deepEqual, equal, match, ok } from "node:assert/strict";
import { chromium } from "playwright-core";

interface SmokeOptions {
	readonly url: string;
	readonly chrome: string;
}

function parseOptions(arguments_: readonly string[]): SmokeOptions {
	let url = "http://127.0.0.1:4173";
	let chrome = "/usr/bin/google-chrome";
	for (const argument of arguments_) {
		if (argument.startsWith("--url=")) url = argument.slice("--url=".length);
		else if (argument.startsWith("--chrome=")) chrome = argument.slice("--chrome=".length);
		else throw new Error(`Unknown browser smoke argument: ${argument}`);
	}
	const parsed = new URL(url);
	if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
		throw new Error("Browser smoke accepts only an http://127.0.0.1 localhost URL.");
	}
	return { url: parsed.origin, chrome };
}

const options = parseOptions(Deno.args);
const artifactDirectory = new URL("../.artifacts/browser/", import.meta.url);
await Deno.mkdir(artifactDirectory, { recursive: true });

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

	const response = await page.goto(options.url, { waitUntil: "networkidle" });
	equal(response?.status(), 200);
	equal(await page.title(), "Clio Workbench");
	await page.getByText("connected", { exact: true }).waitFor();
	equal(await page.getByRole("main").count(), 1);
	equal(await page.getByRole("complementary").count(), 2);
	equal(await page.getByRole("textbox", { name: "Research request" }).count(), 1);
	await page.screenshot({ path: new URL("initial.png", artifactDirectory).pathname });

	const engineSelector = page.getByLabel("Project engine");
	await engineSelector.selectOption("clio-acp");
	await page.getByRole("button", { name: "Check Clio readiness" }).waitFor();
	await page.getByRole("list", { name: "Clio readiness facts" }).waitFor();
	await page.getByText(/That target may be remote/u).first().waitFor();
	equal(await page.getByLabel("Fake outcome").count(), 0);
	equal(await page.getByRole("button", { name: "Run with Clio" }).isDisabled(), true);
	await engineSelector.selectOption("fake");
	await page.getByRole("button", { name: "Run fake session" }).waitFor();
	await page.getByLabel("Fake outcome").waitFor();

	await page.getByRole("button", { name: /Spectra Lab/u }).click();
	await page.getByRole("heading", { level: 1, name: "Spectra Lab" }).waitFor();
	await page.getByText("No activity recorded for this project", { exact: true }).waitFor();
	await page.getByRole("button", { name: /Atlas Field Study/u }).click();
	await page.getByRole("heading", { level: 1, name: "Atlas Field Study" }).waitFor();

	const scratchName = `browser-smoke-${crypto.randomUUID().slice(0, 8)}.tmp`;
	const movedScratchName = scratchName.replace(".tmp", "-moved.tmp");
	const fileToolbar = page.locator(".file-toolbar");
	const createFileButton = fileToolbar.getByRole("button", { name: /File$/u });
	await createFileButton.click();
	let operationDialog = page.getByRole("dialog", { name: "Create empty file" });
	const closeOperationDialog = operationDialog.getByRole("button", { name: "Close" });
	await page.waitForFunction(() => document.activeElement?.textContent?.includes("Close") === true);
	equal(await page.locator(".conversation").evaluate((element) => element.hasAttribute("inert")), true);
	equal(await page.locator("#project-rail").evaluate((element) => element.hasAttribute("inert")), true);
	equal(await page.locator("#activity-rail").evaluate((element) => element.hasAttribute("inert")), true);
	await page.keyboard.press("Shift+Tab");
	equal(
		await operationDialog.getByRole("button", { name: "Apply in sandbox" }).evaluate((element) =>
			element === document.activeElement
		),
		true,
	);
	await page.keyboard.press("Tab");
	equal(await closeOperationDialog.evaluate((element) => element === document.activeElement), true);
	const createFileName = operationDialog.getByLabel("Name", { exact: true });
	await createFileName.fill("   ");
	equal(await createFileName.evaluate((input) => (input as HTMLInputElement).checkValidity()), false);
	await operationDialog.getByRole("button", { name: "Apply in sandbox" }).click();
	equal(await operationDialog.isVisible(), true);
	await createFileName.fill(scratchName);
	await operationDialog.getByRole("button", { name: "Apply in sandbox" }).click();
	await page.waitForFunction(() => document.activeElement?.textContent?.includes("File") === true);
	equal(await createFileButton.evaluate((element) => element === document.activeElement), true);
	let scratchNode = page.locator(".file-node").filter({ hasText: scratchName });
	await scratchNode.waitFor();
	await scratchNode.click();

	await fileToolbar.getByRole("button", { name: /Move$/u }).click();
	operationDialog = page.getByRole("dialog", { name: "Rename or move" });
	await operationDialog.getByLabel("Destination name").fill(movedScratchName);
	await operationDialog.getByRole("button", { name: "Apply in sandbox" }).click();
	scratchNode = page.locator(".file-node").filter({ hasText: movedScratchName });
	await scratchNode.waitFor();
	await scratchNode.click();

	await fileToolbar.getByRole("button", { name: /Delete$/u }).click();
	operationDialog = page.getByRole("dialog", { name: "Prepare confirmed delete" });
	await operationDialog.getByRole("button", { name: "Inspect and prepare" }).click();
	const deleteDialog = page.getByRole("dialog", { name: "Delete file" });
	await deleteDialog.getByText(movedScratchName, { exact: true }).waitFor();
	await deleteDialog.getByRole("button", { name: "Delete exactly this item" }).click();
	await scratchNode.waitFor({ state: "detached" });
	const desktopLeftRailGeometry = await page.locator("#project-rail").evaluate((rail) => ({
		clientWidth: rail.clientWidth,
		scrollWidth: rail.scrollWidth,
		scrollLeft: rail.scrollLeft,
	}));
	ok(desktopLeftRailGeometry.scrollWidth <= desktopLeftRailGeometry.clientWidth);
	equal(desktopLeftRailGeometry.scrollLeft, 0);

	await page.getByRole("button", { name: "Run fake session" }).click();
	await page.locator("#permission-title").waitFor();
	await page.getByText("Inspect convergence inputs", { exact: true }).last().waitFor();
	equal(await engineSelector.isDisabled(), true);
	equal(await page.getByRole("button", { name: /Spectra Lab/u }).isDisabled(), true);
	await page.getByText("Simulated by Workbench", { exact: true }).first().waitFor();
	equal(await page.getByText(/Clio requested permission/u).count(), 0);
	await page.screenshot({ path: new URL("permission.png", artifactDirectory).pathname });
	await page.getByRole("button", { name: "Allow once" }).click();
	const completedOutcome = page.getByRole("heading", { name: "Outcome", exact: true });
	await completedOutcome.waitFor();
	await completedOutcome.scrollIntoViewIfNeeded();
	await page.screenshot({ path: new URL("complete.png", artifactDirectory).pathname });

	await page.getByRole("button", { name: /Spectra Lab/u }).click();
	await page.getByRole("heading", { level: 1, name: "Spectra Lab" }).waitFor();
	equal(await page.getByRole("heading", { name: "Outcome", exact: true }).count(), 0);
	await page.getByRole("button", { name: /Atlas Field Study/u }).click();
	await page.getByRole("heading", { name: "Outcome", exact: true }).waitFor();

	await page.getByRole("button", { name: "Run fake session" }).click();
	await page.locator("#permission-title").waitFor();
	await page.reload({ waitUntil: "networkidle" });
	await page.getByText("connected", { exact: true }).waitFor();
	await page.getByRole("button", { name: "Run fake session" }).waitFor();
	equal(await page.locator("#permission-title").count(), 0);
	equal(await page.getByLabel("Project engine").isDisabled(), false);

	await page.getByRole("button", { name: "Run fake session" }).click();
	await page.getByRole("button", { name: "Cancel" }).click();
	await page.getByRole("heading", { name: "Turn canceled", exact: true }).waitFor();

	await page.getByLabel("Fake outcome").selectOption("failure");
	await page.getByRole("button", { name: "Run fake session" }).click();
	await page.locator("#permission-title").waitFor();
	await page.getByRole("button", { name: "Allow once" }).click();
	await page.getByRole("heading", { name: "Turn failed", exact: true }).waitFor();

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
	match(status, /CONNECTED/u);
	match(status, /Target\s+unavailable/u);
	match(status, /Authentication\s+unavailable/u);
	match(status, /Context\s+unavailable/u);
	match(status, /Operation\s+idle/u);

	await page.setViewportSize({ width: 375, height: 820 });
	equal(await page.locator(".composer__privacy").isVisible(), true);
	equal(await page.locator(".composer__shortcut").isVisible(), false);
	await page.waitForFunction(() =>
		document.querySelector("#project-rail")?.hasAttribute("inert") === true &&
		document.querySelector("#activity-rail")?.hasAttribute("inert") === true
	);
	const compactGeometry = await page.evaluate(() => {
		const leftRail = document.querySelector<HTMLElement>("#project-rail");
		const rightRail = document.querySelector<HTMLElement>("#activity-rail");
		if (!leftRail || !rightRail) throw new Error("Responsive rails are missing.");
		return {
			viewportWidth: globalThis.innerWidth,
			documentWidth: document.documentElement.scrollWidth,
			leftRightEdge: leftRail.getBoundingClientRect().right,
			rightLeftEdge: rightRail.getBoundingClientRect().left,
		};
	});
	ok(compactGeometry.leftRightEdge <= 1, `closed project rail leaked to x=${compactGeometry.leftRightEdge}`);
	ok(
		compactGeometry.rightLeftEdge >= compactGeometry.viewportWidth - 1,
		`closed activity rail leaked to x=${compactGeometry.rightLeftEdge}`,
	);
	ok(compactGeometry.documentWidth <= compactGeometry.viewportWidth);

	const openProjects = page.getByRole("button", { name: "Open projects and files" });
	await openProjects.click();
	await page.locator("#project-rail.is-open").waitFor();
	await page.waitForFunction(() => document.activeElement?.textContent?.includes("Close projects and files") === true);
	equal(await page.locator(".conversation").evaluate((element) => element.hasAttribute("inert")), true);
	equal(await page.locator("#activity-rail").evaluate((element) => element.hasAttribute("inert")), true);
	equal(await page.locator(".status-bar").evaluate((element) => element.hasAttribute("inert")), true);
	for (let index = 0; index < 24; index += 1) {
		await page.keyboard.press("Tab");
		equal(
			await page.locator("#project-rail").evaluate((rail) => rail.contains(document.activeElement)),
			true,
		);
	}
	await page.screenshot({ path: new URL("compact-project-drawer.png", artifactDirectory).pathname });
	await page.keyboard.press("Escape");
	await page.waitForFunction(() => document.querySelector("#project-rail")?.hasAttribute("inert") === true);
	equal(await openProjects.evaluate((element) => element === document.activeElement), true);
	equal(await page.locator(".conversation").evaluate((element) => element.hasAttribute("inert")), false);

	const openActivity = page.getByRole("button", { name: "Open activity and evidence" });
	await openActivity.click();
	await page.locator("#activity-rail.is-open").waitFor();
	await page.waitForFunction(() =>
		document.activeElement?.textContent?.includes("Close activity and evidence") === true
	);
	for (let index = 0; index < 12; index += 1) {
		await page.keyboard.press("Tab");
		equal(
			await page.locator("#activity-rail").evaluate((rail) => rail.contains(document.activeElement)),
			true,
		);
	}
	await page.keyboard.press("Escape");
	await page.waitForFunction(() => document.querySelector("#activity-rail")?.hasAttribute("inert") === true);
	equal(await openActivity.evaluate((element) => element === document.activeElement), true);

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
		const sessionsHeading = Array.from(rail.querySelectorAll("h2")).find((heading) =>
			heading.textContent?.includes("Sessions")
		);
		return {
			overflowY: getComputedStyle(rail).overflowY,
			scrollTop: rail.scrollTop,
			scrollHeight: rail.scrollHeight,
			clientHeight: rail.clientHeight,
			headingBottom: sessionsHeading?.getBoundingClientRect().bottom ?? Number.POSITIVE_INFINITY,
			railBottom: rail.getBoundingClientRect().bottom,
		};
	});
	ok(["auto", "scroll"].includes(shortHeightRail.overflowY));
	ok(shortHeightRail.scrollHeight > shortHeightRail.clientHeight);
	ok(shortHeightRail.scrollTop > 0);
	ok(shortHeightRail.headingBottom <= shortHeightRail.railBottom + 1);
	await page.keyboard.press("Escape");
	await page.setViewportSize({ width: 375, height: 820 });

	await openProjects.click();
	await page.locator("#project-rail.is-open").waitFor();
	await page.setViewportSize({ width: 900, height: 820 });
	await page.waitForFunction(() => !document.querySelector(".drawer-scrim")?.classList.contains("is-visible"));
	equal(await page.locator(".drawer-scrim").evaluate((element) => getComputedStyle(element).pointerEvents), "none");
	await openActivity.click();
	await page.locator("#activity-rail.is-open").waitFor();
	equal(await page.locator("#project-rail").evaluate((rail) => rail.classList.contains("is-open")), false);
	await page.setViewportSize({ width: 375, height: 820 });
	await page.waitForFunction(() => {
		const left = document.querySelector("#project-rail");
		const right = document.querySelector("#activity-rail");
		return left?.hasAttribute("inert") === true &&
			right?.classList.contains("is-open") === true &&
			right.hasAttribute("inert") === false;
	});
	equal(await page.locator("#project-rail").evaluate((rail) => rail.classList.contains("is-open")), false);
	equal(await page.locator(".conversation").evaluate((main) => main.hasAttribute("inert")), true);
	for (let index = 0; index < 12; index += 1) {
		await page.keyboard.press("Tab");
		equal(
			await page.locator("#activity-rail").evaluate((rail) => rail.contains(document.activeElement)),
			true,
		);
	}
	await page.keyboard.press("Escape");
	await page.waitForFunction(() => {
		const left = document.querySelector("#project-rail");
		const right = document.querySelector("#activity-rail");
		return left?.hasAttribute("inert") === true && right?.hasAttribute("inert") === true;
	});
	equal(await page.locator(".conversation").evaluate((main) => main.hasAttribute("inert")), false);
	equal(await openActivity.evaluate((element) => element === document.activeElement), true);

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
			url: options.url,
			projectsSwitchedWithoutLeakage: true,
			scopedFileCreateMoveAndConfirmedDelete: true,
			clioUnprobedTruthObserved: true,
			activeTurnRetargetingLocked: true,
			refreshDuringPermissionReconciled: true,
			deterministicStatesObserved: ["permission", "complete", "canceled", "failure"],
			responsiveDrawerGeometryAndFocus: true,
			modalAndDrawerFocusContainedAndRestored: true,
			forcedColorsFocusVisible: true,
			shortHeightRailScrollable: true,
			responsiveScrimStateCorrect: true,
			desktopRailHasNoHorizontalOverflow: true,
			mobilePrivacyBoundaryVisible: true,
			drawersMutuallyExclusiveAcrossBreakpoints: true,
			seriousOrCriticalAccessibilityViolations: blockingViolations.length + compactBlockingViolations.length,
			browserErrors: browserErrors.length,
			screenshots: ["initial.png", "permission.png", "complete.png", "compact-project-drawer.png"],
		},
		null,
		2,
	));
} finally {
	await browser.close();
}
