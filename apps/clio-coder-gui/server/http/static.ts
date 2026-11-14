import type { Stats } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";
import type { Hono } from "hono";
import { isPagePath } from "../../contracts/pages.js";
import { AppProblem, decodeRequestPath } from "../services/problem.js";

interface CachedFile {
	mtimeMs: number;
	size: number;
	etag: string;
	raw: Uint8Array<ArrayBuffer>;
	gzip?: Uint8Array<ArrayBuffer>;
}

// Keyed by the resolved real path of a file that already passed the containment check, so a request path
// can never name an entry. A reload or an attached machine then costs a stat, not a read and a copy.
const files = new Map<string, CachedFile>();
const CACHE_LIMIT = 64 * 1024 * 1024;
let cachedBytes = 0;

const COMPRESSIBLE = new Set([".js", ".css", ".html", ".svg", ".webmanifest"]);
const COMPRESS_FROM = 1024;
// Vite names every `/assets/` file by its content hash, so a changed file is a new URL.
const IMMUTABLE = "public, max-age=31536000, immutable";

async function load(key: string, file: string, info: Stats, rewrite?: (text: string) => string): Promise<CachedFile> {
	const hit = files.get(key);
	if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit;
	const bytes = await readFile(file);
	const raw = rewrite ? new TextEncoder().encode(rewrite(bytes.toString("utf8"))) : new Uint8Array(bytes);
	const entry: CachedFile = {
		mtimeMs: info.mtimeMs,
		size: info.size,
		etag: `"${raw.length.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`,
		raw,
	};
	if (hit) {
		files.delete(key);
		cachedBytes -= hit.raw.length;
	}
	if (raw.length > CACHE_LIMIT) return entry;
	if (cachedBytes + raw.length > CACHE_LIMIT) {
		files.clear();
		cachedBytes = 0;
	}
	files.set(key, entry);
	cachedBytes += raw.length;
	return entry;
}

const fresh = (header: string | undefined, etag: string) =>
	header?.split(",").some((tag) => {
		const candidate = tag.trim();
		return candidate === "*" || candidate.replace(/^W\//, "") === etag;
	});

const acceptsGzip = (header: string | undefined) =>
	(header ?? "").split(",").some((part) => {
		const [name = "", ...parameters] = part.split(";");
		return (
			name.trim().toLowerCase() === "gzip" && !parameters.some((parameter) => /^\s*q=0(?:\.0*)?\s*$/i.test(parameter))
		);
	});

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
		const path = isPagePath(context.req.path) ? "index.html" : decodeRequestPath(context.req.path).slice(1);
		let file: string;
		try {
			file = await realpath(resolve(root, path));
		} catch {
			throw new AppProblem("not_found", "Page or asset was not found.");
		}
		const difference = relative(root, file);
		if (difference === ".." || difference.startsWith(`..${sep}`) || difference.startsWith(sep))
			throw new AppProblem("not_found", "Page or asset was not found.");
		const info = await stat(file);
		if (!info.isFile()) throw new AppProblem("not_found", "Page or asset was not found.");
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
		const extension = extname(file);
		context.header("Content-Type", types[extension] ?? "application/octet-stream");
		context.header(
			"Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; frame-ancestors 'none'",
		);
		context.header("Cache-Control", context.req.path.startsWith("/assets/") ? IMMUTABLE : "no-cache");
		if (extension === ".mp4") {
			if (context.req.method === "HEAD") return context.body(null);
			const bytes = await readFile(file);
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
			return context.body(Uint8Array.from(bytes));
		}
		// The installable shell links its manifest, so that variant is different bytes under its own key and tag.
		const entry =
			path === "index.html" && pwa
				? await load(`${file}#pwa`, file, info, (text) =>
						text.replace("<head>", '<head><link rel="manifest" href="/manifest.webmanifest">'),
					)
				: await load(file, file, info);
		context.header("ETag", entry.etag);
		const compressible = COMPRESSIBLE.has(extension) && entry.raw.length >= COMPRESS_FROM;
		if (compressible) context.header("Vary", "Accept-Encoding");
		if (fresh(context.req.header("if-none-match"), entry.etag)) return context.body(null, 304);
		const gzip = compressible && acceptsGzip(context.req.header("accept-encoding"));
		if (gzip) context.header("Content-Encoding", "gzip");
		if (context.req.method === "HEAD") return context.body(null);
		if (!gzip) return context.body(entry.raw);
		entry.gzip ??= new Uint8Array(gzipSync(entry.raw));
		return context.body(entry.gzip);
	});
}
