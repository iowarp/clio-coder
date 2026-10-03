import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { chromium } from "playwright-core";

/**
 * One real browser on the same installed server the package smoke owns. The
 * `chrome` channel finds the installed browser on Linux, macOS and Windows.
 */
export async function checkInstalledBrowser(origin: string, token: string): Promise<void> {
	const browser = await chromium.launch({ channel: "chrome", headless: true });
	try {
		const page = await browser.newPage();
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		const meta = page.waitForResponse(
			(response) => new URL(response.url()).pathname === "/api/meta" && response.status() === 200,
		);
		await page.goto(`${origin}/#token=${token}`);
		await meta;
		await page.getByRole("heading", { level: 1 }).waitFor();
		strictEqual(new URL(page.url()).hash, "", "the credential must be removed from browser history");
		await page.reload();
		await page.getByRole("heading", { level: 1 }).waitFor();
		deepStrictEqual(errors, [], "installed client must boot and reconnect without script errors");
	} finally {
		await browser.close();
	}
}
