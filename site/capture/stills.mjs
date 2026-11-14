import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const site = dirname(here);
const repo = dirname(site);
const spec = JSON.parse(readFileSync(join(here, "scenarios.json"), "utf8"));
const run = (command, args, options = {}) => execFileSync(command, args, { encoding: "utf8", ...options });

// Stills come from the recording through the player the site embeds, in the same fonts.
export async function renderStills(castText, stills, outDir, chrome) {
	if (!stills.length) return [];
	const require = createRequire(join(repo, "apps/clio-coder-gui/package.json"));
	const { chromium } = require("playwright-core");
	const browser = await chromium.launch({ executablePath: chrome, headless: true });
	const files = {
		"/player.js": [join(site, "vendor/asciinema-player/asciinema-player.min.js"), "text/javascript"],
		"/player.css": [join(site, "vendor/asciinema-player/asciinema-player.css"), "text/css"],
		"/cast-symbols.woff2": [join(site, "vendor/cast-symbols/cast-symbols.woff2"), "font/woff2"],
		"/plex-400.woff2": [join(site, "assets/fonts/plex-400.woff2"), "font/woff2"],
		"/plex-500.woff2": [join(site, "assets/fonts/plex-500.woff2"), "font/woff2"],
	};
	const page = await (
		await browser.newContext({ deviceScaleFactor: 2, viewport: { width: 1400, height: 1000 } })
	).newPage();
	await page.route("http://capture.invalid/**", (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === "/") {
			return route.fulfill({
				contentType: "text/html",
				body: `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/player.css"><style>
@font-face{font-family:"IBM Plex Mono";font-weight:400;src:url(/plex-400.woff2)}
@font-face{font-family:"IBM Plex Mono";font-weight:500 700;src:url(/plex-500.woff2)}
@font-face{font-family:"Cast Symbols";src:url(/cast-symbols.woff2)}
body{margin:0;background:${spec.theme.bg}}
#host{display:inline-block;padding:16px;background:${spec.theme.bg}}
.ap-player{--term-font-family:"IBM Plex Mono","Cast Symbols",monospace}
.ap-overlay-start,.ap-control-bar{display:none!important}
</style><div id="host"></div><script src="/player.js"></script>`,
			});
		}
		const [file, type] = files[path] ?? [];
		return file ? route.fulfill({ path: file, contentType: type }) : route.fulfill({ status: 404 });
	});
	await page.goto("http://capture.invalid/");
	const results = [];
	for (const still of stills) {
		await page.evaluate(
			async ({ data, time }) => {
				document.querySelector("#host").replaceChildren();
				const el = document.createElement("div");
				document.querySelector("#host").append(el);
				window.AsciinemaPlayer.create({ data }, el, {
					poster: `npt:${time}`,
					fit: false,
					terminalFontSize: "15px",
					controls: false,
				});
				await document.fonts.load('15px "IBM Plex Mono"');
				await document.fonts.load('15px "Cast Symbols"', "✓⣾");
			},
			{ data: castText, time: still.time },
		);
		await page.waitForSelector(".ap-term");
		await page.waitForTimeout(400);
		const term = await page.$(".ap-term");
		let clip = null;
		if (still.crop) {
			let box = await term.boundingBox();
			// A clip is cut at the viewport edge; grow the viewport to hold the whole terminal.
			const needed = Math.ceil(box.y + box.height + 32);
			if (needed > page.viewportSize().height) {
				await page.setViewportSize({ width: page.viewportSize().width, height: needed });
				box = await term.boundingBox();
			}
			const [from, to] = still.crop;
			// Measured per row: the player's line boxes, not the terminal height divided evenly.
			const lines = await page.$$eval(".ap-term .ap-line", (els) =>
				els.map((el) => {
					const rect = el.getBoundingClientRect();
					return [rect.top, rect.bottom];
				}),
			);
			if (lines.length !== still.rows) throw new Error(`${still.id}: the player drew ${lines.length} rows`);
			clip = {
				x: box.x - 16,
				y: lines[from - 1][0] - 16,
				width: box.width + 32,
				height: lines[to - 1][1] - lines[from - 1][0] + 32,
			};
		}
		const path = join(outDir, `${still.id}.png`);
		if (clip) {
			await page.screenshot({ path, clip });
			// The margin above and below a crop shows parts of the neighbouring rows; paint it as background.
			run("python3", [
				"-c",
				"import sys;from PIL import Image,ImageDraw;i=Image.open(sys.argv[1]).convert('RGB');d=ImageDraw.Draw(i);w,h=i.size;m=int(sys.argv[2]);d.rectangle([0,0,w,m-1],fill=sys.argv[3]);d.rectangle([0,h-m,w,h],fill=sys.argv[3]);i.save(sys.argv[1])",
				path,
				"32",
				spec.theme.bg,
			]);
		} else await (await page.$("#host")).screenshot({ path });
		// The terminal's text at this frame, for a transcript of a recording that no harness session drove.
		const text = await page.$$eval(".ap-term .ap-line", (els) => els.map((el) => el.textContent.trimEnd()));
		results.push({ ...still, path, text });
	}
	await browser.close();
	return results;
}
