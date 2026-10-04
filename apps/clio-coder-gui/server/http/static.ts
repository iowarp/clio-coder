import { readFile, realpath, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import type { Hono } from "hono";
import { isPagePath } from "../../contracts/pages.js";
import { AppProblem } from "../services/problem.js";

/**
 * `installable` decides whether the page advertises itself to the browser as an app. An OS launcher this
 * installation already wrote is the app; a second browser-installed copy would sit beside it under the same name.
 */
export function staticClient(
	app: Hono,
	directory: string,
	pwa = false,
	installable: () => Promise<boolean> = async () => true,
) {
	app.all("*", async (context) => {
		if (context.req.method !== "GET" && context.req.method !== "HEAD")
			throw new AppProblem("unsupported", "Only GET and HEAD are supported.", 405);
		const root = await realpath(directory);
		if (
			!pwa &&
			["/manifest.webmanifest", "/sw.js", "/offline.html", "/offline.js", "/offline.css"].includes(context.req.path)
		)
			throw new AppProblem("not_found", "Installable app assets require background mode.");
		const path = isPagePath(context.req.path) ? "index.html" : decodeURIComponent(context.req.path).slice(1);
		let file: string;
		try {
			file = await realpath(resolve(root, path));
		} catch {
			throw new AppProblem("not_found", "Page or asset was not found.");
		}
		const difference = relative(root, file);
		if (difference === ".." || difference.startsWith(`..${sep}`) || difference.startsWith(sep))
			throw new AppProblem("not_found", "Page or asset was not found.");
		if (!(await stat(file)).isFile()) throw new AppProblem("not_found", "Page or asset was not found.");
		const types: Record<string, string> = {
			".html": "text/html; charset=utf-8",
			".js": "text/javascript; charset=utf-8",
			".css": "text/css; charset=utf-8",
			".svg": "image/svg+xml",
			".woff2": "font/woff2",
			".webmanifest": "application/manifest+json; charset=utf-8",
			".png": "image/png",
			".webp": "image/webp",
			".mp4": "video/mp4",
		};
		context.header("Content-Type", types[extname(file)] ?? "application/octet-stream");
		context.header(
			"Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; frame-ancestors 'none'",
		);
		if (["index.html", "sw.js", "manifest.webmanifest"].includes(path)) context.header("Cache-Control", "no-cache");
		if (context.req.method === "HEAD") return context.body(null);
		const bytes = await readFile(file);
		if (extname(file) === ".mp4") {
			// Safari will not play a film that cannot answer a byte range.
			context.header("Accept-Ranges", "bytes");
			const range = /^bytes=(\d*)-(\d*)$/u.exec(context.req.header("range") ?? "");
			if (range && (range[1] !== "" || range[2] !== "")) {
				const size = bytes.length;
				const start = range[1] === "" ? Math.max(0, size - Number(range[2])) : Number(range[1]);
				const end = range[1] === "" || range[2] === "" ? size - 1 : Math.min(Number(range[2]), size - 1);
				if (start > end || start >= size) {
					context.header("Content-Range", `bytes */${size}`);
					return context.body(null, 416);
				}
				context.header("Content-Range", `bytes ${start}-${end}/${size}`);
				return context.body(Uint8Array.from(bytes.subarray(start, end + 1)), 206);
			}
		}
		return path === "index.html" && pwa && (await installable())
			? context.body(bytes.toString("utf8").replace("<head>", '<head><link rel="manifest" href="/manifest.webmanifest">'))
			: context.body(Uint8Array.from(bytes));
	});
}
