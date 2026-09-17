import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { it, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { probeHttp, probeJson } from "../../src/domains/providers/probe/http.js";

async function localServer(t: TestContext, handle: (req: IncomingMessage, res: ServerResponse) => void) {
	const server = createServer(handle);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
	});
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function delayedBody(res: ServerResponse, body: string, ms: number) {
	res.writeHead(200, { "content-type": "application/json" });
	res.flushHeaders();
	const timer = setTimeout(() => res.end(body), ms);
	res.on("close", () => clearTimeout(timer));
}

it("bounds JSON consumption after immediate headers and closes the response", async (t) => {
	let closed = false;
	let received = false;
	const url = await localServer(t, (_req, res) => {
		received = true;
		res.on("close", () => {
			closed = true;
		});
		delayedBody(res, '{"ready":true}', 600);
	});
	const caller = new AbortController();
	const result = await probeJson({ url, timeoutMs: 150, signal: caller.signal });
	assert.equal(received, true);
	assert.equal(result.ok, false);
	assert.equal(result.error, "timeout after 150ms");
	assert.equal(result.status, undefined);
	assert.equal(result.data, undefined);
	assert.equal(getEventListeners(caller.signal, "abort").length, 0);
	for (let i = 0; i < 50 && !closed; i++) await delay(10);
	assert.equal(closed, true);
});

it("keeps caller cancellation attached while awaiting the body", async (t) => {
	const caller = new AbortController();
	let observedListeners = 0;
	const url = await localServer(t, (_req, res) => {
		delayedBody(res, '{"ready":true}', 600);
		const timer = setTimeout(() => {
			observedListeners = getEventListeners(caller.signal, "abort").length;
			caller.abort(new Error("operator stopped the probe"));
		}, 80);
		res.on("close", () => clearTimeout(timer));
	});
	const result = await probeJson({ url, timeoutMs: 1000, signal: caller.signal });
	assert.equal(result.ok, false);
	assert.equal(result.error, "aborted by caller");
	assert.equal(result.status, undefined);
	assert.equal(result.data, undefined);
	assert.ok(observedListeners > 0);
	assert.equal(getEventListeners(caller.signal, "abort").length, 0);
});

it("times out a stalled partial JSON body without reporting a parse error", async (t) => {
	const url = await localServer(t, (_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.write('{"never":');
		// Bound the failing baseline too; the repaired probe closes this first.
		const watchdog = setTimeout(() => res.destroy(), 800);
		res.on("close", () => clearTimeout(watchdog));
	});
	const result = await probeJson({ url, timeoutMs: 100 });
	assert.equal(result.ok, false);
	assert.equal(result.error, "timeout after 100ms");
});

for (const probe of [probeHttp, probeJson]) {
	it(`${probe.name} handles pre-aborted callers without sending a request`, async (t) => {
		let requests = 0;
		const url = await localServer(t, (_req, res) => {
			requests++;
			res.end("{}");
		});
		const caller = new AbortController();
		caller.abort();
		const result = await probe({ url, timeoutMs: 100, signal: caller.signal });
		assert.equal(result.ok, false);
		assert.equal(result.error, "aborted by caller");
		assert.equal(result.status, undefined);
		assert.equal(requests, 0);
		assert.equal(getEventListeners(caller.signal, "abort").length, 0);
	});

	for (const status of [401, 503, ...(probe === probeHttp ? [200] : [])]) {
		it(`${probe.name} cancels an unread streaming HTTP ${status} body`, async (t) => {
			let closed = false;
			const url = await localServer(t, (_req, res) => {
				res.writeHead(status);
				res.write("streaming body");
				res.on("close", () => {
					closed = true;
				});
			});
			const caller = new AbortController();
			const result = await probe({ url, timeoutMs: 1000, signal: caller.signal });
			assert.equal(result.ok, status === 200);
			assert.equal(result.status, status);
			if (status !== 200) assert.match(result.error ?? "", new RegExp(`^HTTP ${status}:`));
			assert.equal(getEventListeners(caller.signal, "abort").length, 0);
			for (let i = 0; i < 50 && !closed; i++) await delay(10);
			assert.equal(closed, true, "the probe must release the unread response before server teardown");
		});
	}
}

it("preserves malformed JSON diagnostics and cleans up the caller listener", async (t) => {
	const url = await localServer(t, (_req, res) => res.end("not json"));
	const caller = new AbortController();
	const result = await probeJson({ url, timeoutMs: 1000, signal: caller.signal });
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /^JSON parse: .+/);
	assert.equal(result.status, undefined);
	assert.equal(getEventListeners(caller.signal, "abort").length, 0);
});

it("preserves POST headers, body, JSON data and header latency", async (t) => {
	let method: string | undefined;
	let header: string | string[] | undefined;
	let body = "";
	const url = await localServer(t, (req, res) => {
		method = req.method;
		header = req.headers["x-probe-fixture"];
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => delayedBody(res, '{"data":[1,2,3]}', 150));
	});
	const caller = new AbortController();
	const started = performance.now();
	const result = await probeJson({
		url,
		method: "POST",
		headers: { "x-probe-fixture": "present" },
		body: '{"input":"fixture"}',
		timeoutMs: 1000,
		signal: caller.signal,
	});
	assert.equal(result.ok, true);
	assert.deepEqual(result.data, { data: [1, 2, 3] });
	assert.equal(result.status, 200);
	assert.equal(method, "POST");
	assert.equal(header, "present");
	assert.equal(body, '{"input":"fixture"}');
	assert.ok(Number.isInteger(result.latencyMs));
	assert.ok((result.latencyMs ?? -1) >= 0);
	assert.ok(
		performance.now() - started - (result.latencyMs ?? 0) >= 100,
		"latency still measures headers, not body delay",
	);
	assert.equal(getEventListeners(caller.signal, "abort").length, 0);
});

it("retains HEAD 405 connectivity semantics without inventing JSON or inference success", async (t) => {
	const url = await localServer(t, (_req, res) => {
		res.writeHead(405);
		res.end();
	});
	const head = await probeHttp({ url, method: "HEAD", timeoutMs: 1000 });
	assert.equal(head.ok, true);
	assert.equal(head.status, 405);
	const json = await probeJson({ url, method: "HEAD", timeoutMs: 1000 });
	assert.equal(json.ok, false);
	assert.match(json.error ?? "", /^JSON parse:/);
	assert.match((await probeHttp({ url, timeoutMs: 1000 })).error ?? "", /^HTTP 405:/);
});

it("retains actionable transport diagnostics when the server closes the socket", async (t) => {
	const url = await localServer(t, (req) => req.socket.destroy());
	const result = await probeHttp({ url, timeoutMs: 1000 });
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /other side closed/);
	assert.match(result.error ?? "", /UND_ERR_SOCKET/);
	assert.equal(result.status, undefined);
});

for (const probe of [probeHttp, probeJson]) {
	for (const cause of ["timeout", "caller"] as const) {
		it(`${probe.name} preserves ${cause} failure before headers`, async (t) => {
			const caller = new AbortController();
			const url = await localServer(t, (_req, res) => {
				const timer = setTimeout(() => res.end("{}"), 600);
				res.on("close", () => clearTimeout(timer));
			});
			const abortTimer = cause === "caller" ? setTimeout(() => caller.abort(), 60) : undefined;
			t.after(() => clearTimeout(abortTimer));
			const result = await probe({ url, timeoutMs: cause === "caller" ? 1000 : 100, signal: caller.signal });
			assert.equal(result.ok, false);
			assert.equal(result.error, cause === "caller" ? "aborted by caller" : "timeout after 100ms");
			assert.equal(result.status, undefined);
			assert.ok((result.latencyMs ?? -1) >= 0);
			assert.equal(getEventListeners(caller.signal, "abort").length, 0);
		});
	}
}

it("cancels a continuously growing JSON body at the existing deadline", async (t) => {
	let chunks = 0;
	let closed = false;
	const url = await localServer(t, (_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.write('["');
		const writer = setInterval(() => {
			chunks++;
			res.write("x".repeat(1024));
		}, 5);
		const watchdog = setTimeout(() => res.end('"]'), 800);
		res.on("close", () => {
			closed = true;
			clearInterval(writer);
			clearTimeout(watchdog);
		});
	});
	const result = await probeJson({ url, timeoutMs: 150 });
	assert.equal(result.ok, false);
	assert.equal(result.error, "timeout after 150ms");
	assert.equal(result.status, undefined);
	assert.ok(chunks > 0);
	for (let i = 0; i < 50 && !closed; i++) await delay(10);
	assert.equal(closed, true);
});

it("releases timers and caller listeners after successful and malformed JSON bodies", async (t) => {
	const signals: AbortSignal[] = [];
	const nativeFetch = globalThis.fetch;
	t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		assert.ok(init?.signal);
		signals.push(init.signal);
		return nativeFetch(input, init);
	});
	const url = await localServer(t, (req, res) => res.end(req.url === "/ok" ? "{}" : "invalid"));
	const caller = new AbortController();
	assert.equal((await probeJson({ url: `${url}/ok`, timeoutMs: 200, signal: caller.signal })).ok, true);
	assert.match(
		(await probeJson({ url: `${url}/bad`, timeoutMs: 200, signal: caller.signal })).error ?? "",
		/^JSON parse:/,
	);
	assert.equal(getEventListeners(caller.signal, "abort").length, 0);
	caller.abort();
	await delay(250);
	assert.equal(signals.length, 2);
	assert.ok(
		signals.every((signal) => !signal.aborted),
		"settled probes must not receive late caller or timer aborts",
	);
});
