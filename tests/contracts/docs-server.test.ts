import { strictEqual, throws } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, it } from "node:test";
import { createDocsRequestHandler, waitForShutdown } from "../../src/cli/docs.js";

interface Response {
	status: number;
	headers: Record<string, string>;
	body: string;
}

class CapturedResponse extends Writable {
	status = 0;
	readonly headers: Record<string, string> = {};
	readonly chunks: Buffer[] = [];

	writeHead(status: number, headers: Readonly<Record<string, string>>): this {
		this.status = status;
		for (const [name, value] of Object.entries(headers)) this.headers[name.toLowerCase()] = value;
		return this;
	}

	override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
		callback();
	}
}

async function send(
	handler: ReturnType<typeof createDocsRequestHandler>,
	method: string,
	url: string,
): Promise<Response> {
	const response = new CapturedResponse();
	const finished = new Promise<void>((resolve, reject) => {
		response.once("finish", resolve);
		response.once("error", reject);
	});
	handler({ method, url } as IncomingMessage, response as unknown as ServerResponse);
	await finished;
	return {
		status: response.status,
		headers: response.headers,
		body: Buffer.concat(response.chunks).toString("utf8"),
	};
}

describe("contracts/docs server", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	function fixture(): { handler: ReturnType<typeof createDocsRequestHandler>; root: string; html: string } {
		const root = mkdtempSync(join(tmpdir(), "clio-docs-server-"));
		const html = join(root, "html");
		mkdirSync(html);
		writeFileSync(join(html, "index.html"), "<h1>Clio docs</h1>\n", "utf8");
		roots.push(root);
		return { handler: createDocsRequestHandler(html), root, html };
	}

	it("serves GET and HEAD from the canonical docs root", async () => {
		const { handler } = fixture();
		const get = await send(handler, "GET", "/");
		strictEqual(get.status, 200);
		strictEqual(get.headers["content-type"], "text/html; charset=utf-8");
		strictEqual(get.headers["cache-control"], "no-store");
		strictEqual(get.body, "<h1>Clio docs</h1>\n");

		const head = await send(handler, "HEAD", "/index.html?ignored=1");
		strictEqual(head.status, 200);
		strictEqual(head.headers["content-length"], String(Buffer.byteLength(get.body)));
		strictEqual(head.body, "");
	});

	it("rejects traversal and symlinks whose canonical target escapes the docs root", async () => {
		const { handler, root, html } = fixture();
		const outside = join(root, "outside.html");
		writeFileSync(outside, "outside\n", "utf8");
		symlinkSync(outside, join(html, "escape.html"));

		const traversal = await send(handler, "GET", "/%2e%2e/outside.html");
		strictEqual(traversal.status, 403);
		strictEqual(traversal.body, "forbidden");

		const escaped = await send(handler, "GET", "/escape.html");
		strictEqual(escaped.status, 403);
		strictEqual(escaped.body, "forbidden");
	});

	it("returns bounded errors for missing files and unsupported methods", async () => {
		const { handler } = fixture();
		const missing = await send(handler, "GET", "/missing.html");
		strictEqual(missing.status, 404);
		strictEqual(missing.body, "not found");

		const method = await send(handler, "POST", "/index.html");
		strictEqual(method.status, 405);
		strictEqual(method.headers.allow, "GET, HEAD");
		strictEqual(method.body, "method not allowed");
	});

	it("refuses a missing HTML build and cleans up shutdown signal listeners", async () => {
		const root = mkdtempSync(join(tmpdir(), "clio-docs-missing-"));
		roots.push(root);
		throws(() => createDocsRequestHandler(join(root, "missing-html")), /ENOENT/u);

		const beforeInt = process.listenerCount("SIGINT");
		const beforeTerm = process.listenerCount("SIGTERM");
		const shutdown = waitForShutdown();
		strictEqual(process.listenerCount("SIGINT"), beforeInt + 1);
		strictEqual(process.listenerCount("SIGTERM"), beforeTerm + 1);
		process.emit("SIGTERM");
		await shutdown;
		strictEqual(process.listenerCount("SIGINT"), beforeInt);
		strictEqual(process.listenerCount("SIGTERM"), beforeTerm);
	});
});
