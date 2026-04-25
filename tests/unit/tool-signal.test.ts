import { match, ok, strictEqual } from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { bashTool } from "../../src/tools/bash.js";
import { webFetchTool } from "../../src/tools/web-fetch.js";

interface SlowServer {
	server: Server;
	url: (path?: string) => string;
}

function startSlowServer(delayMs: number): Promise<SlowServer> {
	return new Promise((resolve, reject) => {
		const server = createServer((_req, res) => {
			setTimeout(() => {
				res.writeHead(200, { "content-type": "text/plain" });
				res.end("slow-ok");
			}, delayMs);
		});
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address() as AddressInfo | null;
			if (!addr || typeof addr === "string") {
				reject(new Error("failed to bind slow test server"));
				return;
			}
			const port = addr.port;
			resolve({
				server,
				url: (path = "/") => `http://127.0.0.1:${port}${path}`,
			});
		});
	});
}

function closeServer(server: Server): Promise<void> {
	return new Promise((resolve, reject) => {
		server.close((err) => {
			if (err) reject(err);
			else resolve();
		});
	});
}

describe("tool abort signal handling", () => {
	let slow: SlowServer | null = null;

	before(async () => {
		slow = await startSlowServer(5_000);
	});

	after(async () => {
		if (slow) await closeServer(slow.server);
	});

	it("bash external abort terminates running command", async () => {
		const controller = new AbortController();
		const startedAt = Date.now();
		const started = bashTool.run({ command: "sleep 5", timeout_ms: 60_000 }, { signal: controller.signal });
		setTimeout(() => controller.abort(), 50);
		const result = await started;
		const elapsedMs = Date.now() - startedAt;

		strictEqual(result.kind, "error");
		if (result.kind === "error") match(result.message, /aborted/);
		ok(elapsedMs < 1500, `expected abort to terminate within 1500ms, got ${elapsedMs}ms`);
	});

	it("bash pre-aborted signal returns immediately", async () => {
		const signal = AbortSignal.abort();
		const startedAt = Date.now();
		const result = await bashTool.run({ command: "sleep 1" }, { signal });
		const elapsedMs = Date.now() - startedAt;

		strictEqual(result.kind, "error");
		if (result.kind === "error") match(result.message, /aborted/);
		ok(elapsedMs < 200, `expected pre-abort short-circuit under 200ms, got ${elapsedMs}ms`);
	});

	it("web_fetch external abort cancels the fetch", async () => {
		ok(slow, "slow server must be running");
		const controller = new AbortController();
		const startedAt = Date.now();
		const started = webFetchTool.run({ url: slow.url("/abort"), timeout_ms: 10_000 }, { signal: controller.signal });
		setTimeout(() => controller.abort(), 50);
		const result = await started;
		const elapsedMs = Date.now() - startedAt;

		strictEqual(result.kind, "error");
		if (result.kind === "error") match(result.message, /aborted/);
		ok(elapsedMs < 1000, `expected abort to cancel fetch within 1000ms, got ${elapsedMs}ms`);
	});

	it("web_fetch internal timeout still fires when no external signal supplied", async () => {
		ok(slow, "slow server must be running");
		const startedAt = Date.now();
		const result = await webFetchTool.run({ url: slow.url("/timeout"), timeout_ms: 200 });
		const elapsedMs = Date.now() - startedAt;

		strictEqual(result.kind, "error");
		if (result.kind === "error") match(result.message, /timeout|timed out/i);
		ok(elapsedMs < 1500, `expected timeout to fire within 1500ms, got ${elapsedMs}ms`);
	});
});
