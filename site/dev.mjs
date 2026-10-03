#!/usr/bin/env node
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { readFile, rename, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const site = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
	options: {
		port: { type: "string", default: "4173" },
		host: { type: "string", default: "0.0.0.0" },
		snapshot: { type: "boolean", default: false },
		review: { type: "boolean", default: false },
		dir: { type: "string", default: ".preview" },
	},
});
// A second preview (for example --review beside the normal one) needs its own
// directory; two servers must never swap the same output.
if (!/^\.preview[a-z0-9-]*$/.test(values.dir)) throw new Error("--dir must be an ignored .preview directory name.");
const out = join(site, values.dir);
const next = join(site, `${values.dir}-next`);
const previous = join(site, `${values.dir}-previous`);
const clients = new Set();
const mime = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json; charset=utf-8",
	".xml": "application/xml",
	".txt": "text/plain; charset=utf-8",
	".webp": "image/webp",
	".mp4": "video/mp4",
	".png": "image/png",
	".svg": "image/svg+xml",
	".woff2": "font/woff2",
};
const csp =
	"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src https://www.youtube-nocookie.com; object-src 'none'; base-uri 'self'; form-action 'none'";
function run(command, args) {
	return new Promise((done, reject) => {
		const child = spawn(command, args, { cwd: site, stdio: "inherit" });
		child.on("error", reject);
		child.on("exit", (code) => (code === 0 ? done() : reject(new Error(`${command} exited ${code}`))));
	});
}
let building = false;
let pending = false;
async function build() {
	if (building) {
		pending = true;
		return;
	}
	building = true;
	try {
		if (!values.snapshot) await run("python3", [join(site, "sync-docs.py"), "--worktree"]);
		// --review adds the unregistered manuscripts in content/drafts to this preview only.
		const buildArgs = [join(site, "build.mjs"), "--out", next, ...(values.review ? ["--review"] : [])];
		const buildLock = process.env.CLIO_CODER_SITE_BUILD_LOCK;
		await run(
			buildLock ? "flock" : process.execPath,
			buildLock ? [buildLock, process.execPath, ...buildArgs] : buildArgs,
		);
		await rm(previous, { recursive: true, force: true });
		try {
			await rename(out, previous);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		await rename(next, out);
		await rm(previous, { recursive: true, force: true });
		for (const client of clients) client.write("data: reload\n\n");
		console.log(`Clio preview updated ${new Date().toLocaleTimeString()}`);
	} catch (error) {
		console.error(`Preview build failed; the last working preview is still served.\n${error.message}`);
	} finally {
		building = false;
		if (pending) {
			pending = false;
			await build();
		}
	}
}
await build();
const redirects = JSON.parse(await readFile(join(site, "redirects.json"), "utf8"));
const server = createServer(async (request, response) => {
	response.setHeader("Cache-Control", "no-store");
	response.setHeader("X-Content-Type-Options", "nosniff");
	response.setHeader("Content-Security-Policy", csp);
	response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
	response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
	try {
		const url = new URL(request.url, "http://localhost");
		if (url.pathname === "/__events") {
			response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
			response.write(": connected\n\n");
			clients.add(response);
			request.on("close", () => clients.delete(response));
			return;
		}
		if (url.pathname === "/__reload.js") {
			response.writeHead(200, { "Content-Type": mime[".js"] });
			response.end('new EventSource("/__events").onmessage = () => location.reload();');
			return;
		}
		const path = decodeURIComponent(url.pathname);
		if (redirects[path] || path === "/index.html") {
			const target = new URL(redirects[path] ?? "/", url);
			target.search = url.search;
			response.writeHead(308, { Location: `${target.pathname}${target.search}${target.hash}` });
			response.end();
			return;
		}
		const file = resolve(out, `.${path === "/" ? "/index.html" : path}`);
		if (!file.startsWith(out + sep) || path.split("/").some((part) => part.startsWith("."))) {
			response.writeHead(404);
			response.end("Not found");
			return;
		}
		let target = file;
		let status = 200;
		try {
			if (!(await stat(target)).isFile()) throw new Error("not a file");
		} catch {
			target = join(out, "404.html");
			status = 404;
		}
		let body = await readFile(target);
		if (extname(target) === ".html" && !url.searchParams.has("__static"))
			body = Buffer.from(body.toString().replace("</body>", '<script src="/__reload.js" defer></script></body>'));
		response.writeHead(status, { "Content-Type": mime[extname(target)] ?? "application/octet-stream" });
		response.end(request.method === "HEAD" ? undefined : body);
	} catch {
		response.writeHead(400);
		response.end("Bad request");
	}
});
server.listen(Number(values.port), values.host, () =>
	console.log(
		`\nClio Coder preview: http://localhost:${values.port}/\nWatching site source and public repository guides.\n`,
	),
);
let timer;
function changed() {
	clearTimeout(timer);
	timer = setTimeout(() => {
		void build();
	}, 250);
}
watch(site, { recursive: true }, (_event, name) => {
	if (!name || /^(?:\.preview|public|content\/docs|content\/index\.json)/.test(name)) return;
	if (/\.(?:html|css|js|mjs|json|md|py|webp|png|mp4)$/.test(name)) changed();
});
watch(join(site, "../docs/guide"), { recursive: true }, changed);
for (const name of ["README.md", "package.json"]) watch(join(site, "..", name), changed);
const heartbeat = setInterval(() => {
	for (const client of clients) client.write(": keepalive\n\n");
}, 20000);
for (const signal of ["SIGINT", "SIGTERM"])
	process.on(signal, () => {
		clearInterval(heartbeat);
		for (const client of clients) client.end();
		server.close(() => process.exit(0));
		server.closeAllConnections();
	});
