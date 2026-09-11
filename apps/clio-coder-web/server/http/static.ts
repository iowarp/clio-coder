import { readFile, realpath, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import type { Hono } from "hono";
import { AppProblem } from "../services/problem.js";

export function staticClient(app: Hono, directory: string, pwa = false) {
	app.all("*", async (context) => {
		if (context.req.method !== "GET" && context.req.method !== "HEAD")
			throw new AppProblem("unsupported", "Only GET and HEAD are supported.", 405);
		const root = await realpath(directory);
		if (
			!pwa &&
			["/manifest.webmanifest", "/sw.js", "/offline.html", "/offline.js", "/offline.css"].includes(context.req.path)
		)
			throw new AppProblem("not_found", "Installable app assets require background mode.");
		const path =
			context.req.path === "/" ||
			context.req.path.startsWith("/docs/") ||
			[
				"/toolchain",
				"/fleet",
				"/system",
				"/system/interop",
				"/library",
				"/evals",
				"/usage",
				"/evidence",
				"/traces",
				"/sessions",
				"/docs",
				"/settings",
				"/settings/why",
				"/settings/targets",
				"/settings/routing",
			].includes(context.req.path) ||
			/^\/(traces|sessions|fleet|evidence|evals)\/[^/]+$/.test(context.req.path) ||
			/^\/fleet\/dispatches\/[^/]+$/.test(context.req.path) ||
			/^\/workspaces\/[^/]+\/sessions$/.test(context.req.path)
				? "index.html"
				: decodeURIComponent(context.req.path).slice(1);
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
		};
		context.header("Content-Type", types[extname(file)] ?? "application/octet-stream");
		context.header(
			"Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; frame-ancestors 'none'",
		);
		if (["index.html", "sw.js", "manifest.webmanifest"].includes(path)) context.header("Cache-Control", "no-cache");
		if (context.req.method === "HEAD") return context.body(null);
		const bytes = await readFile(file);
		return path === "index.html" && pwa
			? context.body(bytes.toString("utf8").replace("<head>", '<head><link rel="manifest" href="/manifest.webmanifest">'))
			: context.body(Uint8Array.from(bytes));
	});
}
