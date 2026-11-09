import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { chromium } from "playwright-core";

/**
 * The client is ready once it has exchanged the launch token and read `/api/meta`. That takes about a second; the cap
 * only bounds a hung boot on a loaded host, the way the package smoke bounds the server's launch line.
 */
const BROWSER_READY_TIMEOUT_MS = 60_000;

/**
 * One real browser on the same installed server the package smoke owns. The
 * `chrome` channel finds the installed browser on Linux, macOS and Windows.
 */
export async function checkInstalledBrowser(origin: string, token: string): Promise<void> {
	const browser = await chromium.launch({ channel: "chrome", headless: true });
	try {
		const page = await browser.newPage();
		page.setDefaultTimeout(BROWSER_READY_TIMEOUT_MS);
		page.setDefaultNavigationTimeout(BROWSER_READY_TIMEOUT_MS);
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		// What the page asked the server and heard back, so a boot that never gets ready names the step it stopped at.
		const started = performance.now();
		const trail: string[] = [];
		const at = () => `${((performance.now() - started) / 1000).toFixed(1)}s`;
		page.on("load", () => trail.push(`${at()} load`));
		page.on("response", (response) => {
			const path = new URL(response.url()).pathname;
			if (path.startsWith("/api/")) trail.push(`${at()} ${response.status()} ${response.request().method()} ${path}`);
		});
		page.on("requestfailed", (request) =>
			trail.push(`${at()} failed ${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText}`),
		);
		const report = () => `page trail: ${trail.join(" | ") || "(nothing)"}; page errors: ${errors.join(" | ") || "none"}`;
		const meta = page.waitForResponse(
			(response) => new URL(response.url()).pathname === "/api/meta" && response.status() === 200,
		);
		meta.catch(() => {});
		try {
			await page.goto(`${origin}/#token=${token}`);
			await meta;
		} catch (error) {
			if (error instanceof Error && error.name === "TimeoutError")
				throw new Error(`installed client was not ready within ${BROWSER_READY_TIMEOUT_MS / 1000}s; ${report()}`, {
					cause: error,
				});
			throw error;
		}
		await page.getByRole("heading", { level: 1 }).waitFor();
		strictEqual(new URL(page.url()).hash, "", "the credential must be removed from browser history");
		await page.reload();
		await page.getByRole("heading", { level: 1 }).waitFor();
		deepStrictEqual(errors, [], "installed client must boot and reconnect without script errors");
	} finally {
		await browser.close();
	}
}
