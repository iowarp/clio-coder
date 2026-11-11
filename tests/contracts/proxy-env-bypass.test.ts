import { ok, strictEqual } from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { installProxyFromEnv, proxyEnvSummary, proxyForUrl } from "../../src/core/proxy-env.js";
import { observeAnthropicResponse } from "../../src/engine/apis/anthropic-response.js";
import { observeCodexTransport } from "../../src/engine/apis/codex-transport.js";
import { withProxyConnectionNote } from "../../src/engine/apis/proxy-connection-error.js";
import { observeResponsesModelId } from "../../src/engine/apis/responses-model-id.js";
import type { Api, Model } from "../../src/engine/types.js";

let proxyHits = 0;

function listen(body: string, host: string): Promise<Server> {
	const server = createServer((_req, res) => {
		if (body === "proxied") proxyHits++;
		res.end(body);
	});
	// undici tunnels through the proxy with CONNECT; the stub counts it and refuses.
	server.on("connect", (_req, socket) => {
		proxyHits++;
		socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
	});
	return new Promise((resolve) => server.listen(0, host, () => resolve(server)));
}

test("NO_PROXY CIDR ranges and IP wildcards send matching IP hosts direct and others through the proxy", async (t) => {
	const original = getGlobalDispatcher();
	const proxy = await listen("proxied", "127.0.0.1");
	const target = await listen("direct", "127.0.0.2");
	t.after(() => {
		setGlobalDispatcher(original);
		proxy.close();
		target.close();
	});
	const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
	const url = `http://127.0.0.2:${(target.address() as AddressInfo).port}/`;
	const written: string[] = [];
	t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
		written.push(String(chunk));
		return true;
	});

	await installProxyFromEnv({ http_proxy: proxyUrl, no_proxy: "127.0.0.0/8,corp.example" });
	strictEqual(await (await fetch(url)).text(), "direct");
	strictEqual(proxyForUrl(url), null);
	strictEqual(proxyForUrl("http://10.1.2.3/"), proxyUrl);
	ok((proxyEnvSummary() ?? "").includes("127.0.0.0/8"));

	await installProxyFromEnv({ http_proxy: proxyUrl, no_proxy: "127.0.0.*" });
	strictEqual(await (await fetch(url)).text(), "direct");

	await installProxyFromEnv({ http_proxy: proxyUrl, no_proxy: "10.0.0.0/8,192.168.*" });
	const before = proxyHits;
	const via = await fetch(url).then(
		(res) => res.text(),
		() => "refused",
	);
	ok(via === "proxied" || via === "refused", via);
	ok(proxyHits > before);
	strictEqual(proxyForUrl("http://10.1.2.3/"), null);
	strictEqual(proxyForUrl("http://192.168.1.5/"), null);
	strictEqual(proxyForUrl("http://192.169.1.5/"), proxyUrl);
	strictEqual(proxyForUrl("http://[fd00::1]/"), proxyUrl);

	await installProxyFromEnv({ http_proxy: proxyUrl, no_proxy: "fd00::/8" });
	strictEqual(proxyForUrl("http://[fd00::1]/"), null);
	t.mock.restoreAll();
	strictEqual(written.join("").includes("not honoured"), false);
});

test("Anthropic, Responses, Codex and Ollama connection errors name the proxy without its credentials", async (t) => {
	const original = getGlobalDispatcher();
	t.after(() => setGlobalDispatcher(original));
	const written: string[] = [];
	t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
		written.push(String(chunk));
		return true;
	});
	await installProxyFromEnv({ https_proxy: "http://alice:s3cret@proxy.corp.example:3128" });
	t.mock.restoreAll();

	const failing = (api: Api) => {
		const model = { id: "m", api, provider: "p", baseUrl: "https://provider.example/v1" } as Model<Api>;
		const invoke = () => {
			const stream = createAssistantMessageEventStream();
			const error = {
				role: "assistant",
				content: [],
				api,
				provider: "p",
				model: "m",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "error",
				errorMessage: "Connection error.: connect ECONNREFUSED 10.0.0.1:3128",
				timestamp: 0,
			} as AssistantMessage;
			stream.push({ type: "error", reason: "error", error });
			stream.end(error);
			return stream;
		};
		return { model, invoke };
	};
	const anthropic = failing("anthropic-messages");
	const responses = failing("openai-responses");
	const codex = failing("openai-codex-responses");
	const results = [
		await observeAnthropicResponse(anthropic.model, undefined, anthropic.invoke).result(),
		await observeResponsesModelId(responses.model, undefined, responses.invoke).result(),
		await observeCodexTransport(codex.model, undefined, codex.invoke).result(),
	];
	for (const message of results) {
		strictEqual(
			message.errorMessage,
			"Connection error. (through proxy http://proxy.corp.example:3128): connect ECONNREFUSED 10.0.0.1:3128",
		);
		ok((message.errorMessage ?? "").includes("proxy.corp.example:3128"));
		ok(!(message.errorMessage ?? "").includes("s3cret"));
		ok(!(message.errorMessage ?? "").includes("alice"));
	}
	// Ollama's native client surfaces undici's bare `fetch failed`.
	const ollama = withProxyConnectionNote("fetch failed", "https://ollama.example/") ?? "";
	ok(ollama.startsWith("fetch failed (through proxy "), ollama);
	ok(!ollama.includes("s3cret"));
	strictEqual(withProxyConnectionNote("fetch failed", "http://127.0.0.1:11434"), "fetch failed");
	strictEqual(withProxyConnectionNote("HTTP 400: bad request", "https://provider.example/"), "HTTP 400: bad request");
});
