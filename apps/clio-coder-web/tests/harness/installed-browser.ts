import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { chromium } from "playwright-core";

/** One real browser on the same installed server the package smoke owns. */
export async function checkInstalledBrowser(origin: string, token: string): Promise<void> {
	const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
	try {
		const page = await browser.newPage();
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		const meta = page.waitForResponse(
			(response) => new URL(response.url()).pathname === "/api/meta" && response.status() === 200,
		);
		await page.goto(`${origin}/#token=${token}`);
		await meta;
		await page.getByRole("heading", { name: /From a question/u }).waitFor();
		strictEqual(new URL(page.url()).hash, "", "the credential must be removed from browser history");
		await page.reload();
		await page.getByRole("heading", { name: /From a question/u }).waitFor();
		deepStrictEqual(errors, [], "installed client must boot and reconnect without script errors");
	} finally {
		await browser.close();
	}
}
