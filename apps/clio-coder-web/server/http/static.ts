import { readFile, realpath, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import type { Hono } from "hono";
import { AppProblem } from "../services/problem.js";

export function staticClient(app: Hono, directory: string) {
	app.all("*", async (context) => {
		if (context.req.method !== "GET" && context.req.method !== "HEAD")
			throw new AppProblem("unsupported", "Only GET and HEAD are supported.", 405);
		const root = await realpath(directory);
		const path =
			context.req.path === "/" ||
			["/toolchain", "/traces", "/sessions"].includes(context.req.path) ||
			/^\/(traces|sessions)\/[^/]+$/.test(context.req.path) ||
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
		};
		context.header("Content-Type", types[extname(file)] ?? "application/octet-stream");
		context.header(
			"Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
		);
		return context.req.method === "HEAD" ? context.body(null) : context.body(Uint8Array.from(await readFile(file)));
	});
}
