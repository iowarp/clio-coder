import { spawn } from "node:child_process";
import { createReadStream, readdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { relative, resolve } from "node:path";
import chalk from "chalk";
import { resolvePackageRoot } from "../core/package-root.js";
import { printError, printHeader } from "./shared.js";

// Human-facing viewer over the bundled HTML blueprints. It binds an ephemeral
// static file server to 127.0.0.1 only, serves docs/html/index.html as the
// menu plus the blueprint pages, prints the URL, and runs until SIGINT. It
// uses only Node's built-in http and fs: zero new dependencies, no daemon, no
// persisted state, no telemetry, and no external network. The static-path
// resolution and the menu synthesis are pure functions so they unit-test
// without binding a port.

const HOST = "127.0.0.1";

const HELP = `clio docs [topic] [--no-open]

Serve Clio Coder's bundled HTML documentation locally and open it in a browser.
The server binds an ephemeral port on 127.0.0.1 only; it keeps no state, runs no
daemon, and reaches no external network. Press Ctrl+C to stop it.

Arguments:
  [topic]      deep-link a specific blueprint (for example: safety, configuration,
               tools). Omit to open the documentation menu.

Flags:
  --no-open    do not launch a browser; just print the URL.
  --help, -h   this message.
`;

const CONTENT_TYPES: Readonly<Record<string, string>> = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".webp": "image/webp",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".map": "application/json; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
};

export interface DocsMenuEntry {
	/** Short deep-link key, for example `safety`. */
	topic: string;
	/** Real on-disk file name, for example `safety_blueprint.html`. */
	file: string;
	/** Human label, for example `Safety`. */
	label: string;
}

/** Resolve the bundled docs/html directory from the installed package root. */
export function resolveDocsHtmlDir(): string {
	return resolve(resolvePackageRoot(), "docs", "html");
}

/** Content-type for a file path by extension. Pure. Defaults to octet-stream. */
export function contentTypeFor(filePath: string): string {
	const dot = filePath.lastIndexOf(".");
	if (dot === -1) return "application/octet-stream";
	return CONTENT_TYPES[filePath.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Map a request URL to a safe relative path under the html root. Pure: no disk
 * access. Strips the query and fragment, decodes percent-escapes, defaults `/`
 * to `index.html`, and rejects any traversal segment so a request can never
 * escape the served directory.
 */
export function resolveRequestPath(rawUrl: string): { ok: true; relative: string } | { ok: false; reason: string } {
	const pathPart = (rawUrl.split(/[?#]/, 1)[0] ?? "").trim();
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathPart);
	} catch {
		return { ok: false, reason: "bad-request" };
	}
	if (decoded.includes("\0")) return { ok: false, reason: "forbidden" };
	const segments = decoded.split(/[/\\]/).filter((segment) => segment.length > 0 && segment !== ".");
	if (segments.length === 0) return { ok: true, relative: "index.html" };
	for (const segment of segments) {
		if (segment === "..") return { ok: false, reason: "forbidden" };
	}
	return { ok: true, relative: segments.join("/") };
}

function titleize(topic: string): string {
	return topic
		.split(/[-_]+/)
		.filter((word) => word.length > 0)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

/**
 * Synthesize the deep-linkable topic menu from a directory listing. Pure: takes
 * the file-name list, not the directory. `index.html` is the menu itself and is
 * excluded; a trailing `_blueprint` is stripped from the topic key.
 */
export function synthesizeMenu(fileNames: ReadonlyArray<string>): DocsMenuEntry[] {
	const entries: DocsMenuEntry[] = [];
	for (const name of fileNames) {
		if (!name.toLowerCase().endsWith(".html")) continue;
		if (name.toLowerCase() === "index.html") continue;
		const topic = name.replace(/\.html$/i, "").replace(/_blueprint$/i, "");
		entries.push({ topic, file: name, label: titleize(topic) });
	}
	entries.sort((a, b) => a.topic.localeCompare(b.topic));
	return entries;
}

/**
 * Resolve a user-supplied `[topic]` to a real file name. Pure. Accepts the bare
 * topic (`safety`), the blueprint file stem (`safety_blueprint`), or a full
 * `.html` name, case-insensitively. Returns null when nothing matches.
 */
export function topicToFile(topic: string, fileNames: ReadonlyArray<string>): string | null {
	const wanted = topic
		.trim()
		.toLowerCase()
		.replace(/\.html$/i, "");
	if (wanted.length === 0) return null;
	for (const candidate of [`${wanted}.html`, `${wanted}_blueprint.html`]) {
		const match = fileNames.find((name) => name.toLowerCase() === candidate);
		if (match) return match;
	}
	const hit = synthesizeMenu(fileNames).find((entry) => entry.topic.toLowerCase() === wanted);
	return hit ? hit.file : null;
}

function isWithin(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${"/"}`) && !/^([A-Za-z]:)?[/\\]/.test(rel));
}

function listHtmlFiles(htmlDir: string): string[] {
	try {
		return readdirSync(htmlDir)
			.filter((name) => name.toLowerCase().endsWith(".html"))
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}

/** Build the static request handler for one html root. */
export function createDocsRequestHandler(htmlDir: string): (req: IncomingMessage, res: ServerResponse) => void {
	const root = resolve(htmlDir);
	return (req, res) => {
		if (req.method !== "GET" && req.method !== "HEAD") {
			res.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" });
			res.end("method not allowed");
			return;
		}
		const resolved = resolveRequestPath(req.url ?? "/");
		if (!resolved.ok) {
			const status = resolved.reason === "forbidden" ? 403 : 400;
			res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
			res.end(resolved.reason);
			return;
		}
		const target = resolve(root, resolved.relative);
		if (!isWithin(target, root)) {
			res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
			res.end("forbidden");
			return;
		}
		let size: number | null = null;
		try {
			const stat = statSync(target);
			if (stat.isFile()) size = stat.size;
		} catch {
			size = null;
		}
		if (size === null) {
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
			res.end("not found");
			return;
		}
		const headers = {
			"content-type": contentTypeFor(target),
			"content-length": String(size),
			"cache-control": "no-store",
		};
		if (req.method === "HEAD") {
			res.writeHead(200, headers);
			res.end();
			return;
		}
		res.writeHead(200, headers);
		const stream = createReadStream(target);
		stream.on("error", () => {
			if (!res.writableEnded) res.end();
		});
		stream.pipe(res);
	};
}

export interface DocsServerHandle {
	server: Server;
	url: string;
	port: number;
	close(): Promise<void>;
}

export interface StartDocsServerOptions {
	htmlDir: string;
	/** Bind host. Defaults to 127.0.0.1 and is never widened. */
	host?: string;
	/** Bind port. Defaults to 0 (ephemeral). */
	port?: number;
}

/** Start the viewer bound to 127.0.0.1 on an ephemeral port. */
export async function startDocsServer(options: StartDocsServerOptions): Promise<DocsServerHandle> {
	const host = options.host ?? HOST;
	const server = createServer(createDocsRequestHandler(options.htmlDir));
	await new Promise<void>((resolveListen, rejectListen) => {
		const onError = (err: Error): void => rejectListen(err);
		server.once("error", onError);
		server.listen(options.port ?? 0, host, () => {
			server.removeListener("error", onError);
			resolveListen();
		});
	});
	const address = server.address() as AddressInfo;
	const port = address.port;
	return {
		server,
		port,
		url: `http://${host}:${port}/`,
		close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
	};
}

function openBrowser(url: string): void {
	const platform = process.platform;
	const command = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
	const args = platform === "win32" ? ["/c", "start", "", url] : [url];
	try {
		const child = spawn(command, args, { stdio: "ignore", detached: true });
		child.on("error", () => {
			// Best-effort: the printed URL is the fallback when no opener exists.
		});
		child.unref();
	} catch {
		// Best-effort: never fail the command because a browser could not launch.
	}
}

function waitForShutdown(): Promise<void> {
	return new Promise((resolveShutdown) => {
		const onSignal = (): void => {
			process.removeListener("SIGINT", onSignal);
			process.removeListener("SIGTERM", onSignal);
			resolveShutdown();
		};
		process.once("SIGINT", onSignal);
		process.once("SIGTERM", onSignal);
	});
}

export async function runDocsCommand(args: ReadonlyArray<string> = []): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	let noOpen = false;
	const positionals: string[] = [];
	for (const arg of args) {
		if (arg === "--no-open") {
			noOpen = true;
			continue;
		}
		if (arg.startsWith("-")) {
			printError(`unknown flag: ${arg}`);
			process.stdout.write(HELP);
			return 2;
		}
		positionals.push(arg);
	}
	if (positionals.length > 1) {
		printError("docs accepts at most one [topic]");
		process.stdout.write(HELP);
		return 2;
	}

	let htmlDir: string;
	try {
		htmlDir = resolveDocsHtmlDir();
	} catch (err) {
		printError(`could not resolve bundled docs: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
	const files = listHtmlFiles(htmlDir);
	if (files.length === 0) {
		printError(`no bundled HTML docs found at ${htmlDir}`);
		return 1;
	}

	let landing = "index.html";
	const topic = positionals[0];
	if (topic !== undefined) {
		const file = topicToFile(topic, files);
		if (!file) {
			printError(`unknown docs topic: ${topic}`);
			const topics = synthesizeMenu(files).map((entry) => entry.topic);
			if (topics.length > 0) process.stdout.write(`  available topics: ${topics.join(", ")}\n`);
			return 2;
		}
		landing = file;
	}

	const handle = await startDocsServer({ htmlDir });
	const landingUrl = landing === "index.html" ? handle.url : `${handle.url}${landing}`;
	printHeader("Clio docs viewer");
	process.stdout.write(`  serving ${relative(process.cwd(), htmlDir) || htmlDir}\n`);
	process.stdout.write(`  open ${chalk.cyan(landingUrl)}\n`);
	process.stdout.write("  bound to 127.0.0.1 only: no external network, no daemon, no state.\n");
	process.stdout.write("  press Ctrl+C to stop.\n");
	if (!noOpen) openBrowser(landingUrl);

	await waitForShutdown();
	await handle.close();
	process.stdout.write("docs viewer stopped.\n");
	return 0;
}
