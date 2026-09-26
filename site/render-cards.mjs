#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const site = dirname(fileURLToPath(import.meta.url));
const root = resolve(site, "..");
const { values } = parseArgs({ options: { chrome: { type: "string" } } });
const chrome = resolve(values.chrome ?? process.env.CLIO_CODER_CHROME ?? "/usr/bin/google-chrome");
if (!existsSync(chrome)) throw new Error(`Chrome was not found at ${chrome}; pass --chrome <path>.`);
const requireFromGui = createRequire(join(root, "apps/clio-coder-gui/package.json"));
const { chromium } = requireFromGui("playwright-core");
const manifest = JSON.parse(readFileSync(join(root, "assets/media-manifest.json"), "utf8"));
const browser = await chromium.launch({
	executablePath: chrome,
	headless: true,
	args: ["--font-render-hinting=none"],
});
try {
	for (const card of manifest.socialExports) {
		const viewport = card.dimensions;
		const context = await browser.newContext({
			viewport,
			deviceScaleFactor: 1,
			locale: "en-US",
			timezoneId: "UTC",
		});
		try {
			const page = await context.newPage();
			await page.goto(pathToFileURL(join(root, card.template)).href, { waitUntil: "load" });
			await page.evaluate(async () => {
				await document.fonts.ready;
				await new Promise((resolveFrame) => requestAnimationFrame(() => requestAnimationFrame(resolveFrame)));
			});
			const clipped = await page.evaluate(() =>
				[...document.querySelectorAll("body > main, body > aside, footer")].some((element) => {
					const bounds = element.getBoundingClientRect();
					return bounds.bottom > innerHeight + 1 || bounds.right > innerWidth + 1;
				}),
			);
			if (clipped) throw new Error(`Social card ${card.id} clips content outside its export dimensions.`);
			await page.screenshot({
				path: join(root, card.output),
				animations: "disabled",
				caret: "hide",
				fullPage: false,
				scale: "css",
			});
			console.log(`rendered ${card.id} at ${viewport.width}x${viewport.height}`);
		} finally {
			await context.close();
		}
	}
} finally {
	await browser.close();
}
const recorded = spawnSync("python3", [join(root, "scripts/media-assets.py"), "--record-hashes"], {
	cwd: root,
	stdio: "inherit",
});
if (recorded.error) throw recorded.error;
if (recorded.status !== 0) process.exit(recorded.status ?? 1);
