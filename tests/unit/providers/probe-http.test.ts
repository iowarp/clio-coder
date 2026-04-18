import { ok, strictEqual } from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";

import { probeHttp, probeJson } from "../../../src/domains/providers/probe/http.js";

interface Spec {
	status?: number;
	body?: string;
	rejectHead?: boolean;
	delayMs?: number;
}

let handler: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) => {
	res.statusCode = 204;
	res.end();
};
let server: Server | null = null;
let baseUrl = "";

function configure(spec: Spec): void {
	handler = (req, res) => {
		if (spec.rejectHead && req.method === "HEAD") {
			res.statusCode = 405;
			res.end();
			return;
		}
		const send = () => {
			res.statusCode = spec.status ?? 200;
			if (spec.body !== undefined) {
				res.setHeader("content-type", "application/json");
				res.end(spec.body);
			} else {
				res.end();
			}
		};
		if (spec.delayMs && spec.delayMs > 0) {
			setTimeout(send, spec.delayMs);
		} else {
			send();
		}
	};
}

beforeEach(async () => {
	server = createServer((req, res) => handler(req, res));
	await new Promise<void>((resolve) => {
		server?.listen(0, "127.0.0.1", () => resolve());
	});
	const addr = server?.address() as AddressInfo;
	baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterEach(async () => {
	await new Promise<void>((resolve) => {
		if (!server) return resolve();
		server.close(() => resolve());
	});
	server = null;
});

describe("providers/probe probeHttp", () => {
	it("ok on 200", async () => {
		configure({ status: 200 });
		const result = await probeHttp({ url: baseUrl, timeoutMs: 1000 });
		strictEqual(result.ok, true);
	});

	it("HEAD returning 405 is still ok=true (reachable endpoint)", async () => {
		configure({ rejectHead: true, status: 500 });
		const result = await probeHttp({ url: baseUrl, method: "HEAD", timeoutMs: 1000 });
		strictEqual(result.ok, true);
	});

	it("non-ok status surfaces an HTTP error string", async () => {
		configure({ status: 500 });
		const result = await probeHttp({ url: baseUrl, timeoutMs: 1000 });
		strictEqual(result.ok, false);
		ok(result.error?.startsWith("HTTP 500"), `expected HTTP 500 error, got: ${result.error}`);
	});

	it("timeoutMs fires the abort controller with a 'timeout after Xms' error", async () => {
		configure({ delayMs: 200, status: 200 });
		const result = await probeHttp({ url: baseUrl, timeoutMs: 30 });
		strictEqual(result.ok, false);
		strictEqual(result.error, "timeout after 30ms");
	});

	it("caller-supplied signal aborts ahead of timeout", async () => {
		configure({ delayMs: 300, status: 200 });
		const controller = new AbortController();
		const started = probeHttp({ url: baseUrl, timeoutMs: 5000, signal: controller.signal });
		setTimeout(() => controller.abort(), 30);
		const result = await started;
		strictEqual(result.ok, false);
		strictEqual(result.error, "aborted by caller");
	});
});

describe("providers/probe probeJson", () => {
	it("parses a well-formed JSON body", async () => {
		configure({ status: 200, body: '{"hello":"world"}' });
		const result = await probeJson<{ hello: string }>({ url: baseUrl, timeoutMs: 1000 });
		strictEqual(result.ok, true);
		strictEqual(result.data?.hello, "world");
	});

	it("surfaces 'JSON parse: …' on malformed JSON", async () => {
		configure({ status: 200, body: "{not json" });
		const result = await probeJson({ url: baseUrl, timeoutMs: 1000 });
		strictEqual(result.ok, false);
		ok(result.error?.startsWith("JSON parse: "), `expected JSON parse error, got: ${result.error}`);
	});
});
