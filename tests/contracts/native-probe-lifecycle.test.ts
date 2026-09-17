import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { it, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { probeOpenAICompatReasoning } from "../../src/domains/providers/probe/reasoning.js";
import embedRuntime from "../../src/domains/providers/runtimes/local-native/llamacpp-embed.js";
import rerankRuntime from "../../src/domains/providers/runtimes/local-native/llamacpp-rerank.js";
import type { ProbeContext } from "../../src/domains/providers/types/runtime-descriptor.js";

async function server(t: TestContext, handle: (req: IncomingMessage, res: ServerResponse) => void) {
	const instance = createServer(handle);
	await new Promise<void>((resolve) => instance.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		instance.closeAllConnections();
		await new Promise<void>((resolve, reject) => instance.close((error) => (error ? reject(error) : resolve())));
	});
	return `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
}
function ctx(signal?: AbortSignal): ProbeContext {
	return { httpTimeoutMs: 120, credentialsPresent: new Set(), ...(signal ? { signal } : {}) };
}
function target(url: string, runtime = embedRuntime.id) {
	return { id: "fixture", runtime, url, defaultModel: "fixture-model" };
}
function later(res: ServerResponse, action: () => void, ms = 500) {
	const timer = setTimeout(action, ms);
	res.on("close", () => clearTimeout(timer));
}
async function closes(check: () => boolean) {
	for (let i = 0; i < 50 && !check(); i++) await delay(10);
	assert.equal(check(), true, "response must close before server teardown");
}
function recordFetch(t: TestContext): string[] {
	const paths: string[] = [];
	const nativeFetch = globalThis.fetch;
	t.mock.method(globalThis, "fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		paths.push(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname);
		return nativeFetch(input, init);
	});
	return paths;
}
async function embed(url: string, context = ctx()) {
	assert.ok(embedRuntime.embed);
	return embedRuntime.embed(target(url), ["alpha", "beta"], context);
}

for (const [runtime, path] of [
	[embedRuntime, "/embedding"],
	[rerankRuntime, "/reranking"],
] as const) {
	it(`${runtime.id} capability POST honors the deadline before headers`, async (t) => {
		const url = await server(t, (req, res) => {
			if (req.url === path) later(res, () => res.end("[]"));
			else res.end("{}");
		});
		assert.ok(runtime.probe, `${runtime.id} must expose its capability probe`);
		const result = await runtime.probe(target(url, runtime.id), ctx());
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /timeout after 120ms/);
	});
	it(`${runtime.id} reports caller abort without fabricated HTTP 599`, async (t) => {
		const caller = new AbortController();
		const url = await server(t, (req, res) => {
			if (req.url === path) {
				later(res, () => caller.abort(), 40);
				later(res, () => res.end("[]"));
			} else res.end("{}");
		});
		assert.ok(runtime.probe, `${runtime.id} must expose its capability probe`);
		const result = await runtime.probe(target(url, runtime.id), ctx(caller.signal));
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /aborted by caller/);
		assert.doesNotMatch(result.error ?? "", /599/);
		assert.equal(getEventListeners(caller.signal, "abort").length, 0);
	});
	for (const status of [200, 202, 204, 401, 503]) {
		it(`${runtime.id} preserves HTTP ${status} capability semantics and releases unread bodies`, async (t) => {
			let closed = false;
			let method: string | undefined;
			let body = "";
			const url = await server(t, (req, res) => {
				if (req.url !== path) {
					res.end("{}");
					return;
				}
				method = req.method;
				req.on("data", (chunk) => {
					body += chunk;
				});
				req.on("end", () => {
					res.writeHead(status);
					res.on("close", () => {
						closed = true;
					});
					if (status === 204) res.end();
					else res.write("unread streaming availability response");
				});
			});
			assert.ok(runtime.probe, `${runtime.id} must expose its capability probe`);
			const result = await runtime.probe(target(url, runtime.id), ctx());
			const expected = status === 200 || status === 202 || (runtime === embedRuntime && status === 204);
			assert.equal(result.ok, expected);
			if (!expected) assert.match(result.error ?? "", new RegExp(`HTTP ${status}`));
			assert.equal(method, "POST");
			assert.deepEqual(
				JSON.parse(body),
				runtime === embedRuntime ? { content: "probe" } : { query: "probe", documents: ["a"], model: "fixture-model" },
			);
			await closes(() => closed);
		});
	}
	it(`${runtime.id} pre-aborted callers never issue requests`, async (t) => {
		let requests = 0;
		const url = await server(t, (_req, res) => {
			requests++;
			res.end("{}");
		});
		const caller = new AbortController();
		caller.abort();
		assert.ok(runtime.probe, `${runtime.id} must expose its capability probe`);
		const result = await runtime.probe(target(url, runtime.id), ctx(caller.signal));
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /aborted by caller/);
		assert.equal(requests, 0);
	});
}

for (const phase of ["headers", "body"] as const) {
	it(`OAI embedding times out during ${phase} without attempting native inference`, async (t) => {
		const paths = recordFetch(t);
		const url = await server(t, (_req, res) => {
			if (phase === "body") {
				res.writeHead(200);
				res.flushHeaders();
			}
			later(res, () => res.end('{"data":[{"embedding":[1,2]}]}'));
		});
		await assert.rejects(embed(url), /timeout after 120ms/);
		assert.deepEqual(paths, ["/v1/embeddings"]);
	});
}

it("caller abort during OAI body consumption does not attempt the native fallback", async (t) => {
	const paths = recordFetch(t);
	const caller = new AbortController();
	const url = await server(t, (_req, res) => {
		res.writeHead(200);
		res.flushHeaders();
		later(res, () => caller.abort(), 40);
		later(res, () => res.end('{"data":[]}'));
	});
	await assert.rejects(embed(url, ctx(caller.signal)), /aborted by caller/);
	assert.deepEqual(paths, ["/v1/embeddings"]);
	assert.equal(getEventListeners(caller.signal, "abort").length, 0);
});

for (const status of [401, 403, 429, 500]) {
	it(`OAI HTTP ${status} fails without retrying inference on a different route`, async (t) => {
		const paths = recordFetch(t);
		let closed = false;
		const url = await server(t, (req, res) => {
			if (req.url === "/v1/embeddings") {
				res.writeHead(status);
				res.write("error stream");
				res.on("close", () => {
					closed = true;
				});
			} else res.end('[{"embedding":[1,2]}]');
		});
		await assert.rejects(embed(url), new RegExp(`HTTP ${status}`));
		assert.deepEqual(paths, ["/v1/embeddings"]);
		await closes(() => closed);
	});
}

for (const status of [404, 405, 501]) {
	it(`unavailable OAI HTTP ${status} retains one native fallback and numeric ordering`, async (t) => {
		const paths = recordFetch(t);
		let closed = false;
		const url = await server(t, (req, res) => {
			if (req.url === "/v1/embeddings") {
				res.writeHead(status);
				res.write("unavailable");
				res.on("close", () => {
					closed = true;
				});
			} else
				res.end('[{"index":1,"embedding":[[1.25,2.5],[3.75,4.5]]},{"index":0,"embedding":[0.1234567890123456,-2.75]}]');
		});
		assert.deepEqual(await embed(url), {
			vectors: [
				[0.1234567890123456, -2.75],
				[2.5, 3.5],
			],
			dimensions: 2,
			model: "fixture-model",
		});
		assert.deepEqual(paths, ["/v1/embeddings", "/embedding"]);
		await closes(() => closed);
	});
}

it("healthy OAI embedding preserves vectors, wire model, token usage and ordering", async (t) => {
	const paths = recordFetch(t);
	const url = await server(t, (req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			assert.deepEqual(JSON.parse(body), { input: ["alpha", "beta"], model: "fixture-model", encoding_format: "float" });
			res.end(
				'{"model":"wire-model","usage":{"total_tokens":19},"data":[{"index":1,"embedding":[3.125,4.25]},{"index":0,"embedding":[0.1234567890123456,-2.75]}]}',
			);
		});
	});
	assert.deepEqual(await embed(`${url}/v1`), {
		vectors: [
			[0.1234567890123456, -2.75],
			[3.125, 4.25],
		],
		model: "wire-model",
		dimensions: 2,
		tokensUsed: 19,
	});
	assert.deepEqual(paths, ["/v1/embeddings"]);
});

for (const body of ["not json", '{"unexpected":"shape"}']) {
	it(`unusable OAI success data does not trigger duplicate inference: ${body}`, async (t) => {
		const paths = recordFetch(t);
		const url = await server(t, (req, res) => res.end(req.url === "/v1/embeddings" ? body : '[{"embedding":[1,2]}]'));
		await assert.rejects(embed(url), /JSON parse|invalid.*embedding/i);
		assert.deepEqual(paths, ["/v1/embeddings"]);
	});
}

it("rerank inference preserves score precision, document forms and returned ordering", async (t) => {
	const url = await server(t, (_req, res) =>
		res.end(
			'{"model":"rank-model","results":[{"index":1,"relevance_score":0.9876543210123456,"document":{"text":"beta"}},{"index":0,"relevance_score":0.125,"document":"alpha"}]}',
		),
	);
	assert.ok(rerankRuntime.rerank);
	assert.deepEqual(await rerankRuntime.rerank(target(url, rerankRuntime.id), "query", ["alpha", "beta"], ctx()), {
		model: "rank-model",
		items: [
			{ index: 1, score: 0.9876543210123456, document: "beta" },
			{ index: 0, score: 0.125, document: "alpha" },
		],
	});
});

it("reasoning HTTP errors cancel unread bodies while retaining status", async (t) => {
	let closed = false;
	const caller = new AbortController();
	const url = await server(t, (_req, res) => {
		res.writeHead(401);
		res.write("unread error body");
		res.on("close", () => {
			closed = true;
		});
	});
	const result = await probeOpenAICompatReasoning({
		baseUrl: url,
		modelId: "fixture",
		timeoutMs: 120,
		signal: caller.signal,
	});
	assert.equal(result.reasoning, false);
	assert.match(result.error ?? "", /^HTTP 401:/);
	assert.equal(getEventListeners(caller.signal, "abort").length, 0);
	await closes(() => closed);
});

it("healthy reasoning still requires a nonempty reasoning field", async (t) => {
	const url = await server(t, (_req, res) =>
		res.end('{"choices":[{"message":{"reasoning_content":"working","content":"4"}}]}'),
	);
	const result = await probeOpenAICompatReasoning({ baseUrl: url, modelId: "fixture", timeoutMs: 120 });
	assert.equal(result.reasoning, true);
	assert.equal(result.field, "reasoning_content");
});

for (const [runtime, path] of [
	[embedRuntime, "/embedding"],
	[rerankRuntime, "/reranking"],
] as const) {
	it(`${runtime.id} preserves actionable capability transport evidence`, async (t) => {
		const url = await server(t, (req, res) => {
			if (req.url === path) req.socket.destroy();
			else res.end("{}");
		});
		assert.ok(runtime.probe, `${runtime.id} must expose its capability probe`);
		const result = await runtime.probe(target(url, runtime.id), ctx());
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /other side closed/);
		assert.match(result.error ?? "", /UND_ERR_SOCKET/);
		assert.doesNotMatch(result.error ?? "", /HTTP 599/);
	});
}

it("pre-aborted embedding fails before attempting the native fallback", async (t) => {
	const paths = recordFetch(t);
	let requests = 0;
	const url = await server(t, (_req, res) => {
		requests++;
		res.end("{}");
	});
	const caller = new AbortController();
	caller.abort();
	await assert.rejects(embed(url, ctx(caller.signal)), /aborted by caller/);
	assert.equal(requests, 0);
	assert.deepEqual(paths, ["/v1/embeddings"]);
});

it("caller cancellation before OAI headers fails without native fallback", async (t) => {
	const paths = recordFetch(t);
	const caller = new AbortController();
	const url = await server(t, (_req, res) => {
		later(res, () => caller.abort(), 40);
		later(res, () => res.end('{"data":[]}'));
	});
	await assert.rejects(embed(url, ctx(caller.signal)), /aborted by caller/);
	assert.deepEqual(paths, ["/v1/embeddings"]);
});

for (const cause of ["timeout", "caller"] as const) {
	it(`native embedding fallback respects ${cause} through body consumption`, async (t) => {
		const paths = recordFetch(t);
		const caller = new AbortController();
		const url = await server(t, (req, res) => {
			if (req.url === "/v1/embeddings") {
				res.writeHead(404);
				res.end();
				return;
			}
			res.writeHead(200);
			res.flushHeaders();
			if (cause === "caller") later(res, () => caller.abort(), 40);
			later(res, () => res.end('[{"embedding":[1,2]}]'));
		});
		await assert.rejects(
			embed(url, ctx(caller.signal)),
			cause === "caller" ? /aborted by caller/ : /timeout after 120ms/,
		);
		assert.deepEqual(paths, ["/v1/embeddings", "/embedding"]);
	});
	it(`rerank inference respects ${cause} through body consumption`, async (t) => {
		const paths = recordFetch(t);
		const caller = new AbortController();
		const url = await server(t, (_req, res) => {
			res.writeHead(200);
			res.flushHeaders();
			if (cause === "caller") later(res, () => caller.abort(), 40);
			later(res, () => res.end('{"results":[]}'));
		});
		assert.ok(rerankRuntime.rerank);
		await assert.rejects(
			rerankRuntime.rerank(target(url), "query", ["a"], ctx(caller.signal)),
			cause === "caller" ? /aborted by caller/ : /timeout after 120ms/,
		);
		assert.deepEqual(paths, ["/reranking"]);
	});
	it(`reasoning retains ${cause} through body consumption`, async (t) => {
		const caller = new AbortController();
		const url = await server(t, (_req, res) => {
			res.writeHead(200);
			res.flushHeaders();
			if (cause === "caller") later(res, () => caller.abort(), 40);
			later(res, () => res.end('{"choices":[]}'));
		});
		const result = await probeOpenAICompatReasoning({
			baseUrl: url,
			modelId: "fixture",
			timeoutMs: 120,
			signal: caller.signal,
		});
		assert.equal(result.reasoning, false);
		assert.equal(result.error, cause === "caller" ? "aborted by caller" : "timeout after 120ms");
		assert.equal(getEventListeners(caller.signal, "abort").length, 0);
	});
}
